/**
 * initBridgeCore 的 REPL 专用 wrapper。负责读取 bootstrap 状态，包括功能开关、cwd、session ID、
 * git context、OAuth 与标题推导，随后委托给不依赖 bootstrap 的核心实现。
 *
 * 从 replBridge.ts 拆出，因为 import sessionStorage（getCurrentSessionTitle）会间接引入
 * src/commands.ts，进而带入完整 slash command 与 React 组件树（约 1300 个模块）。让
 * initBridgeCore 所在文件不接触 sessionStorage，可使 daemonBridge.ts 导入核心而不膨胀
 * Agent SDK bundle。
 *
 * 由 useReplBridge（自动启动）与 print.ts（通过 query.enableRemoteControl 的 SDK -p 模式）
 * 动态导入调用。
 */

import { feature } from 'bun:bundle'
import { hostname } from 'node:os'
import { getOriginalCwd, getSessionId } from 'src/bootstrap/runtime/runtimeContext.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  getAPIProvider,
  isAnthropicProvider,
  isOpenAIProvider,
} from '../services/model/providers.js'
import { isPolicyAllowed, waitForPolicyLimitsToLoad } from '../services/policy-limits/index.js'
import type { WireMessage } from '../types/index.js'
import type { Message } from '../types/message.js'
import type { WireControlResponse } from '../types/wire/control.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getOrganizationUUID,
  getZyAIOAuthTokens,
  handleOAuth401Error,
} from '../services/auth/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../services/config/config.js'
import { logForDebugging } from '../services/infra/debug.js'
import { stripDisplayTagsAllowEmpty } from '../services/messages/xmlTagUtils.js'
import { isInternalBuild } from '../services/infra/envUtils.js'
import { errorMessage } from '../utils/errors.js'
import { getBranch, getRemoteUrl } from '../services/infra/git.js'
import { toSDKMessages } from '../services/messages/mappers.js'
import { getContentText } from '../services/messages/./predicates.js'
import { getHotContextMessages } from '../services/messages/projections.js'
import { isSyntheticMessage } from '../services/messages/./constants.js'
import type { PermissionMode } from '../services/permissions/permissionMode.js'
import { getCurrentSessionTitle, saveAiGeneratedTitle } from '../services/sessionStorage.js'
import {
  extractConversationText,
  generateSessionTitle,
} from '../services/session-storage/sessionTitle.js'
import { generateShortWordSlug } from '../utils/words.js'
import { getWireAccessToken, getWireBaseUrl, getWireTokenOverride } from './bridgeConfig.js'
import {
  checkWireMinVersion,
  isBridgeEnabledBlocking,
  isCseShimEnabled,
  isEnvLessWireEnabled,
} from './bridgeEnabled.js'
import { archiveWireSession, createWireSession, updateWireSessionTitle } from './createSession.js'
import { logWireSkip } from './debugUtils.js'
import { checkEnvLessWireMinVersion } from './envLessBridgeConfig.js'
import { getPollIntervalConfig } from './pollConfig.js'
import type { ReplWireHandle, WireState } from './replBridge.js'
import { initBridgeCore } from './replBridge.js'
import { setCseShimGate } from './sessionIdCompat.js'
import type { WireWorkerType } from './types.js'
export type InitWireOptions = {
  onInboundMessage?: (msg: WireMessage) => void | Promise<void>
  onPermissionResponse?: (response: WireControlResponse) => void
  onInterrupt?: () => void
  onSetModel?: (model: string | undefined) => void
  onSetMaxThinkingTokens?: (maxTokens: number | null) => void
  onSetPermissionMode?: (mode: PermissionMode) => { ok: true } | { ok: false; error: string }
  onStateChange?: (state: WireState, detail?: string) => void
  initialMessages?: Message[]
  // `/remote-control <name>` 显式指定的会话名。设置后覆盖根据对话或 /rename 推导的标题。
  initialName?: string
  // 调用时完整对话的最新视图。onUserMessage 在第 3 条消息时用它对完整对话调用
  // generateSessionTitle。可选；print.ts 的 SDK enableRemoteControl 路径没有 REPL 消息数组，
  // 缺失时第 3 条推导回退到单条消息文本。
  getMessages?: () => Message[]
  // 先前 bridge 会话中已 flush 的 UUID。初始 flush 会排除这些 UUID 对应的消息，避免污染服务端；
  // 跨会话重复 UUID 会导致 WS 被终止。原地修改，每次 flush 后加入新 UUID。
  previouslyFlushedUUIDs?: Set<string>
  /** 参见 WireCoreParams.perpetual。 */
  perpetual?: boolean
  /**
   * 为 true 时，bridge 只向外转发事件，不建立 SSE 入站流。用于 CCR mirror 模式，使本地会话在
   * zy.ai 可见，而无需启用入站控制。
   */
  outboundOnly?: boolean
  tags?: string[]
}

export async function initReplBridge(options?: InitWireOptions): Promise<ReplWireHandle | null> {
  const {
    onInboundMessage,
    onPermissionResponse,
    onInterrupt,
    onSetModel,
    onSetMaxThinkingTokens,
    onSetPermissionMode,
    onStateChange,
    initialMessages,
    getMessages,
    previouslyFlushedUUIDs,
    initialName,
    perpetual,
    outboundOnly,
    tags,
  } = options ?? {}

  // 绑定 cse_ shim kill switch，使 toCompatSessionId 遵守 GrowthBook 开关。Daemon/SDK 路径
  // 跳过此步骤，shim 默认启用。
  setCseShimGate(isCseShimEnabled)

  // 1. 运行时开关
  if (!(await isBridgeEnabledBlocking())) {
    logWireSkip('not_enabled', '[bridge:repl] Skipping: bridge not enabled')
    return null
  }

  // 1b. 最低版本检查延迟到下方 v1/v2 分支后，因为各实现有独立下限：v1 使用
  // zy_bridge_min_version，v2 使用 zy_bridge_repl_v2_config.min_version。

  // 2. 检查 OAuth，用户必须登录 zy.ai。在策略检查前运行，使 console-auth 用户获得可操作的
  // "/login" 提示，而非陈旧或错误组织缓存导致的误导性策略错误。
  // 仅 Anthropic 直连平台需要 OAuth；OpenAI / Google / 本地引擎等平台跳过
  if (!getWireAccessToken() && isAnthropicProvider(getAPIProvider())) {
    logWireSkip('no_oauth', '[bridge:repl] Skipping: no OAuth tokens')
    onStateChange?.('failed', '/login')
    return null
  }

  // 3. 检查组织策略；组织可能已禁用 remote control
  await waitForPolicyLimitsToLoad()
  if (!isPolicyAllowed('allow_remote_control')) {
    logWireSkip('policy_denied', '[bridge:repl] Skipping: allow_remote_control policy not allowed')
    onStateChange?.('failed', "disabled by your organization's policy")
    return null
  }

  // 设置 CLAUDE_BRIDGE_OAUTH_TOKEN（仅用于 ant 本地开发）时，bridge 通过 getWireAccessToken()
  // 直接使用该 token，与 keychain 状态无关。跳过 2b/2c 以保持解耦；已过期的 keychain token
  // 不应阻止不使用它的 bridge 连接。
  if (!getWireTokenOverride()) {
    // 2a. 跨进程退避。若之前 N 个进程已看到完全相同的失效 token（按 expiresAt 匹配），则静默
    // 跳过，不发送事件，也不尝试刷新。计数阈值可容忍瞬时刷新失败，例如认证服务 5xx、
    // auth.ts:1437/1444/1485 所述的 lockfile 错误；各进程独立重试，连续 3 次失败才证明 token
    // 已失效。与 useReplBridge 的进程内 MAX_CONSECUTIVE_INIT_FAILURES 一致。expiresAt key 按
    // 内容寻址：/login 产生新 token 与新 expiresAt 后，无需显式清除便不再匹配。
    const cfg = getGlobalConfig()
    if (
      cfg.bridgeOauthDeadExpiresAt != null &&
      (cfg.bridgeOauthDeadFailCount ?? 0) >= 3 &&
      getZyAIOAuthTokens()?.expiresAt === cfg.bridgeOauthDeadExpiresAt
    ) {
      logForDebugging(
        `[bridge:repl] Skipping: cross-process backoff (dead token seen ${cfg.bridgeOauthDeadFailCount} times)`,
      )
      return null
    }

    // 2b. 已过期时主动刷新。与 bridgeMain.ts:2096 一致；REPL bridge 在 useEffect 挂载时、任何
    // v1/messages 调用前触发，通常是会话首个 OAuth 请求。缺少此处理时，约 9% 的注册会携带
    // 过期超过 8 小时的 token 请求服务端，先收到 401 再由 withOAuthRetry 恢复，但该 401 本可
    // 避免。大量无关用户聚集在 8 小时 TTL 边界时，VPN 出口 IP 曾观察到 401:200 为 30:1。
    //
    // token 新鲜时成本仅为一次记忆化读取和一次 Date.now() 比较，约微秒级。
    // checkAndRefreshOAuthTokenIfNeeded 会在所有接触 keychain 的路径中自行清缓存，包括刷新成功、
    // lockfile 竞争与抛错，因此此处无需显式 clearOAuthTokenCache()；否则会让超过 91% 的新鲜
    // token 路径强制阻塞式启动 keychain 进程。
    await checkAndRefreshOAuthTokenIfNeeded()

    // 2c. 刷新尝试后 token 仍过期则跳过。环境变量或 FD token（auth.ts:894-917）的
    // expiresAt=null，不会触发。但 refresh token 已失效（密码更改、退出组织、token 被 GC）的
    // keychain token 会同时满足 expiresAt<now 与刷新失败；否则 client 会永久循环 401：
    // withOAuthRetry → handleOAuth401Error → 再次刷新失败 → 用同一陈旧 token 重试 → 再次 401。
    // Datadog 2026-03-08 记录单个 IP 每日产生 2,879 次此类 401。跳过必然失败的 API 调用，
    // 由 useReplBridge 呈现失败。
    //
    // 此处有意不使用 isOAuthTokenExpired；它包含 5 分钟主动刷新缓冲，适合判断“应尽快刷新”，
    // 却不适合判断“确定不可用”。剩余 3 分钟的 token 遇到刷新端点瞬时故障（5xx、超时、Wi-Fi
    // 重连）会错误触发带缓冲检查，但该 token 仍有效且能正常连接。改为检查实际过期：已过期且
    // 刷新失败才表示真正失效。
    const tokens = getZyAIOAuthTokens()
    if (tokens && tokens.expiresAt != null && tokens.expiresAt <= Date.now()) {
      logWireSkip(
        'oauth_expired_unrefreshable',
        '[bridge:repl] Skipping: OAuth token expired and refresh failed (re-login required)',
      )
      onStateChange?.('failed', '/login')
      // 为下个进程持久化。再次发现按 expiresAt 匹配的同一失效 token 时增加 failCount；不同 token
      // 则重置为 1。计数达到 3 后，步骤 2a 会提前返回，不再进入此路径，因此每个失效 token
      // 最多写入 3 次。局部 const 捕获缩窄后的类型，因为闭包会丢失 !== null 的缩窄。
      const deadExpiresAt = tokens.expiresAt
      saveGlobalConfig((c) => ({
        ...c,
        bridgeOauthDeadExpiresAt: deadExpiresAt,
        bridgeOauthDeadFailCount:
          c.bridgeOauthDeadExpiresAt === deadExpiresAt ? (c.bridgeOauthDeadFailCount ?? 0) + 1 : 1,
      }))
      return null
    }
  }

  // 4. 计算 baseUrl；基于环境的 v1 与无环境层的 v2 路径都需要。提升到 v2 开关前供二者使用。
  const baseUrl = getWireBaseUrl()

  // 5. 推导会话标题。优先级：显式 initialName → /rename（session storage）→ 最后一条有意义的
  // 用户消息 → 生成的 slug。仅用于 zy.ai 会话列表展示，模型不会看到。使用两个 flag：
  // `hasExplicitTitle` 表示 initialName 或 /rename，绝不自动覆盖；`hasTitle` 表示任意标题，
  // 包括自动推导，可阻止第 1 条消息重新推导，但不阻止第 3 条。下方同时绑定到 v1 与 v2 的
  // onUserMessage callback 会根据第 1 个 prompt 推导，并在第 3 个 prompt 再次推导，使移动端与
  // Web 标题反映更多 context。slug 回退（如 "remote-control-graceful-unicorn"）使自动启动
  // 会话在首个 prompt 前也能在 zy.ai 列表中区分。
  let title = `remote-control-${generateShortWordSlug()}`
  let hasTitle = false
  let hasExplicitTitle = false
  if (initialName) {
    title = initialName
    hasTitle = true
    hasExplicitTitle = true
  } else {
    const sessionId = getSessionId()
    const customTitle = sessionId ? getCurrentSessionTitle(sessionId) : undefined
    if (customTitle) {
      title = customTitle
      hasTitle = true
      hasExplicitTitle = true
    } else if (initialMessages && initialMessages.length > 0) {
      // 查找最后一条包含有意义内容的用户消息。跳过 meta（nudge）、tool result、compact summary、
      // 非人工来源（task 通知、channel push）与合成中断（[Request interrupted by user]），这些均非
      // 用户撰写。过滤条件与 extractTitleText + isSyntheticMessage 相同。
      for (let i = initialMessages.length - 1; i >= 0; i--) {
        const msg = initialMessages[i]!
        if (
          msg.type !== 'user' ||
          msg.isMeta ||
          msg.toolUseResult ||
          msg.isCompactSummary ||
          (msg.origin && msg.origin.kind !== 'human') ||
          isSyntheticMessage(msg)
        ) {
          continue
        }
        const rawContent = getContentText(msg.message.content)
        if (!rawContent) {
          continue
        }
        const derived = deriveTitle(rawContent)
        if (!derived) {
          continue
        }
        title = derived
        hasTitle = true
        break
      }
    }
  }

  // v1 与 v2 共用；每条适合生成标题的用户消息都会触发，直到返回 true。计数为 1 时立即设置
  // deriveTitle 占位标题，再以 fire-and-forget 调用 generateSessionTitle（Haiku、sentence-case）
  // 升级；计数为 3 时基于完整对话重新生成。标题由 /remote-control <name> 或 /rename 显式指定
  // 时完全跳过；调用时重新检查 sessionStorage，避免覆盖两条消息之间执行的 /rename。若
  // initialMessages 已推导出新鲜标题，则跳过计数 1，但仍在计数 3 时刷新。v2 传入 cse_*；
  // updateWireSessionTitle 在内部重新标记。
  let userMessageCount = 0
  let lastWireSessionId: string | undefined
  let genSeq = 0
  const patch = (derived: string, bridgeSessionId: string, atCount: number): void => {
    hasTitle = true
    title = derived
    logForDebugging(`[bridge:repl] derived title from message ${atCount}: ${derived}`)
    void updateWireSessionTitle(bridgeSessionId, derived, {
      baseUrl,
      getAccessToken: getWireAccessToken,
    }).catch(() => {})
    // 在本地持久化 AI 标题，使 /resume 无需重新生成即可显示
    try {
      const sid = getSessionId()
      if (sid) {
        saveAiGeneratedTitle(sid as import('crypto').UUID, derived)
      }
    } catch {
      // 忽略非关键的持久化失败
    }
  }
  // 以 fire-and-forget 生成 Haiku 标题，并在 await 后检查：重新检查 /rename（sessionStorage）、
  // v1 环境丢失（lastWireSessionId）及同一会话乱序完成（genSeq；若第 1 条的 Haiku 在第 3 条后
  // 完成，会覆盖信息更丰富的标题）。generateSessionTitle 不会 reject。
  const generateAndPatch = (input: string, bridgeSessionId: string): void => {
    const gen = ++genSeq
    const atCount = userMessageCount
    void generateSessionTitle(input, AbortSignal.timeout(15_000)).then((generated) => {
      if (
        generated &&
        gen === genSeq &&
        lastWireSessionId === bridgeSessionId &&
        !getCurrentSessionTitle(getSessionId())
      ) {
        patch(generated, bridgeSessionId, atCount)
      }
    })
  }
  const onUserMessage = (text: string, bridgeSessionId: string): boolean => {
    if (hasExplicitTitle || getCurrentSessionTitle(getSessionId())) {
      return true
    }
    // v1 环境丢失后会以新 ID 重建会话。重置计数，使新会话拥有自己的第 3 条推导；hasTitle
    // 保持 true，因为新会话通过 getCurrentTitle() 创建，会读取此闭包中的第 1 条标题，因此
    // 新周期的第 1 条会正确跳过。
    if (lastWireSessionId !== undefined && lastWireSessionId !== bridgeSessionId) {
      userMessageCount = 0
    }
    lastWireSessionId = bridgeSessionId
    userMessageCount++
    if (userMessageCount === 1 && !hasTitle) {
      const placeholder = deriveTitle(text)
      if (placeholder) {
        patch(placeholder, bridgeSessionId, userMessageCount)
      }
      generateAndPatch(text, bridgeSessionId)
    } else if (userMessageCount === 3) {
      const msgs = getMessages?.()
      const input = msgs ? extractConversationText(getHotContextMessages(msgs)) : text
      generateAndPatch(input, bridgeSessionId)
    }
    // 若 v1 环境丢失在计数超过 3 后重置 transport 的 done flag，也重新锁定。
    return userMessageCount >= 3
  }

  const initialHistoryCap = getFeatureValue_CACHED_MAY_BE_STALE(
    'zy_bridge_initial_history_cap',
    200,
  )

  // 在 v1/v2 分支前获取 orgUUID，因为两条路径都需要：v1 用于环境注册；v2 用于兼容接口
  // /v1/sessions/{id}/archive 的归档，而非 /v1/code/sessions。缺失时 v2 归档会返回 404，
  // /exit 后会话仍在 CCR 中存活。
  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    logWireSkip('no_org_uuid', '[bridge:repl] Skipping: no org UUID')
    onStateChange?.('failed', '/login')
    return null
  }

  // ── GrowthBook 开关：无环境层 bridge ───────────────────────────────────
  // 启用后完全跳过 Environments API 层，不执行 register/poll/ack/heartbeat，而是通过
  // POST /bridge → worker_jwt 直接连接。参见服务端 PR #292605（在 #293280 中重命名）。
  // 仅用于 REPL；daemon/print 仍使用环境路径。
  //
  // 命名：“无环境层”与作为 /worker/* transport 的 “CCR v2” 不同。下方基于环境的路径也能通过
  // ZY_CODE_ 使用 CCR v2。zy_bridge_repl_v2 控制无环境层（无轮询循环），而非 transport 版本。
  //
  // perpetual（通过 bridge-pointer.json 保持 assistant 模式会话连续性）与环境耦合，此处尚未
  // 实现；设置时回退到环境路径，避免 KAIROS 用户静默失去跨重启连续性。
  if (isEnvLessWireEnabled() && !perpetual) {
    const versionError = await checkEnvLessWireMinVersion()
    if (versionError) {
      logWireSkip('version_too_old', `[bridge:repl] Skipping: ${versionError}`, true)
      onStateChange?.('failed', 'run `zy update` to upgrade')
      return null
    }
    logForDebugging('[bridge:repl] Using env-less bridge path (zy_bridge_repl_v2)')
    const { initEnvLessWireCore } = await import('./remoteBridgeCore.js')
    return initEnvLessWireCore({
      baseUrl,
      orgUUID,
      title,
      getAccessToken: getWireAccessToken,
      onAuth401: handleOAuth401Error,
      toSDKMessages,
      initialHistoryCap,
      initialMessages,
      // v2 始终创建新的服务端会话（新 cse_* ID），因此不传 previouslyFlushedUUIDs；不存在跨会话
      // UUID 冲突风险，而且该 ref 会跨启用→禁用→重新启用周期保留，传入后会使新会话收不到任何
      // 历史，因为所有 UUID 都已由上次启用加入集合。v1 在创建新会话时调用
      // previouslyFlushedUUIDs.clear() 处理（replBridge.ts:768）；v2 直接省略参数。
      onInboundMessage,
      onUserMessage,
      onPermissionResponse,
      onInterrupt,
      onSetModel,
      onSetMaxThinkingTokens,
      onSetPermissionMode,
      onStateChange,
      outboundOnly,
      tags,
    })
  }

  // ── v1 路径：基于环境（register/poll/ack/heartbeat）────────────────────

  const versionError = checkWireMinVersion()
  if (versionError) {
    logWireSkip('version_too_old', `[bridge:repl] Skipping: ${versionError}`)
    onStateChange?.('failed', 'run `zy update` to upgrade')
    return null
  }

  // 收集 git context；这里是 bootstrap 读取边界。此处以下所有值都显式传给 bridgeCore。
  const branch = await getBranch()
  const gitRepoUrl = await getRemoteUrl()
  const sessionIngressUrl =
    isInternalBuild() && process.env.CLAUDE_BRIDGE_SESSION_INGRESS_URL
      ? process.env.CLAUDE_BRIDGE_SESSION_INGRESS_URL
      : baseUrl

  // assistant 模式会话声明不同的 worker_type，使 Web UI 能将其筛选到专用 picker。KAIROS
  // 防护确保外部构建完全不包含 assistant 模块。
  let workerType: WireWorkerType = 'zy_code'
  if (feature('KAIROS')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isAssistantMode } =
      // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 扩展字段
      require('../assistant/index.js') as typeof import('../assistant/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isAssistantMode?.() as unknown) {
      workerType = 'zy_code_assistant'
    }
  }

  // 6. 委托。WireCoreHandle 在结构上是 ReplWireHandle 的超集，只多出 REPL 调用方不用的
  // writeSdkMessages，因此无需 adapter，返回时使用更窄类型即可。
  return initBridgeCore({
    dir: getOriginalCwd(),
    machineName: hostname(),
    branch,
    gitRepoUrl,
    title,
    baseUrl,
    sessionIngressUrl,
    workerType,
    getAccessToken: getWireAccessToken,
    createSession: (opts) =>
      createWireSession({
        ...opts,
        events: [],
        baseUrl,
        getAccessToken: getWireAccessToken,
      }),
    archiveSession: (sessionId) =>
      archiveWireSession(sessionId, {
        baseUrl,
        getAccessToken: getWireAccessToken,
        // gracefulShutdown.ts:407 让 runCleanupFunctions 与 2 秒上限竞争。Teardown 还会并行执行
        // stopWork、随后串行 deregister，因此 archive 不能占用全部预算。1.5 秒与 v2 的
        // teardown_archive_timeout_ms 默认值一致。
        timeoutMs: 1500,
      }).catch((err: unknown) => {
        // archiveWireSession 没有 try/catch，5xx、超时或网络错误会直接抛出。此前这些错误被静默
        // 吞掉，使归档失败在 BQ 中不可见，也无法通过 debug 日志诊断。
        logForDebugging(`[bridge:repl] archiveWireSession threw: ${errorMessage(err)}`, {
          level: 'error',
        })
      }),
    // 环境丢失后重连时读取 getCurrentTitle，为新会话重新设置标题。/rename 写入 session storage，
    // onUserMessage 直接修改 `title`；两条路径都会在此读取。
    getCurrentTitle: () => getCurrentSessionTitle(getSessionId()) ?? title,
    onUserMessage,
    toSDKMessages,
    onAuth401: handleOAuth401Error,
    getPollIntervalConfig,
    initialHistoryCap,
    initialMessages,
    previouslyFlushedUUIDs,
    onInboundMessage,
    onPermissionResponse,
    onInterrupt,
    onSetModel,
    onSetMaxThinkingTokens,
    onSetPermissionMode,
    onStateChange,
    perpetual,
  })
}

const TITLE_MAX_LEN = 50

/**
 * 快速生成占位标题：移除展示 tag、取首句、合并空白并截断到 50 个字符。结果为空时返回
 * undefined，例如消息只有 <local-command-stdout>。Haiku 在约 1 至 15 秒后完成
 * generateSessionTitle 时会替换该标题。
 */
function deriveTitle(raw: string): string | undefined {
  // 移除 <ide_opened_file>、<session-start-hook> 等；IDE/hook 注入 context 时它们会出现在用户
  // 消息中。stripDisplayTagsAllowEmpty 对纯 tag 消息返回 '' 而非原文，使其被跳过。
  const clean = stripDisplayTagsAllowEmpty(raw) ?? ''
  // 首句通常表达意图，其余常是 context 或细节。使用捕获组而非 lookbehind，以兼容 YARR JIT。
  const firstSentence = /^(.*?[.!?])\s/.exec(clean)?.[1] ?? clean
  // 合并换行符与制表符；zy.ai 列表中的标题为单行。
  const flat = firstSentence.replace(/\s+/g, ' ').trim()
  if (!flat) {
    return undefined
  }
  return flat.length > TITLE_MAX_LEN ? `${flat.slice(0, TITLE_MAX_LEN - 1)}\u2026` : flat
}
