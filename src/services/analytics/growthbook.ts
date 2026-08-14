import { GrowthBook } from '@growthbook/growthbook'
import { isEqual, memoize } from 'lodash-es'
import {
  getIsNonInteractiveSession,
  getSessionTrustAccepted,
} from '../../bootstrap/runtime/runtimeContext.js'
import { getGrowthBookClientKey } from '../../constants/keys.js'
import { checkHasTrustDialogAccepted, getGlobalConfig, saveGlobalConfig } from '../config/config.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { isInternalBuild } from '../../services/infra/envUtils.js'
import { toError } from '../../utils/errors.js'
import { getAuthHeaders } from '../http/http.js'
import { logError } from '../../services/infra/log.js'
import { createSignal } from '../../utils/signal.js'
import { jsonStringify } from '../../services/infra/slowOperations.js'
import { type GitHubActionsMetadata, getUserForGrowthBook } from '../auth/user.js'
import { isZyEventLoggingEnabled, logGrowthBookExperimentToZy } from './zyEventLogger.js'

/**
 * 发送给 GrowthBook 用于定向的用户属性。
 * 使用 UUID 后缀(非 Uuid)以符合 GrowthBook 惯例。
 */
export type GrowthBookUserAttributes = {
  id: string
  sessionId: string
  deviceID: string
  platform: 'win32' | 'darwin' | 'linux'
  apiBaseUrlHost?: string
  organizationUUID?: string
  accountUUID?: string
  userType?: string
  subscriptionType?: string
  rateLimitTier?: string
  firstTokenTime?: number
  email?: string
  appVersion?: string
  github?: GitHubActionsMetadata
}

/**
 * API 返回的格式错误的特性响应，使用 "value" 而非 "defaultValue"。
 * 这是一个变通方法，直到 API 修复为止。
 */
type MalformedFeatureDefinition = {
  value?: unknown
  defaultValue?: unknown
  [key: string]: unknown
}

let client: GrowthBook | null = null

// 命名处理器引用，以便 resetGrowthBook 可移除它们防止累积
let currentBeforeExitHandler: (() => void) | null = null
let currentExitHandler: (() => void) | null = null

// 跟踪创建客户端时是否有可用的认证
// 这让我们能检测何时需要用新的认证头重新创建
let clientCreatedWithAuth = false

// 存储来自 payload 的实验数据，稍后记录曝光
type StoredExperimentData = {
  experimentId: string
  variationId: number
  inExperiment?: boolean
  hashAttribute?: string
  hashValue?: string
}
const experimentDataByFeature = new Map<string, StoredExperimentData>()

// 远程评估特性值的缓存 —— SDK 不遵守 remoteEval 响应的变通方法
// SDK 的 setForcedFeatures 与 remoteEval 也不可靠
const remoteEvalFeatureValues = new Map<string, unknown>()

// 跟踪 init 前访问的特性，稍后需记录曝光
const pendingExposures = new Set<string>()

// 跟踪本会话已记录曝光的特性 (去重)
// 这防止当 getFeatureValue_CACHED_MAY_BE_STALE 在热路径
// 中重复调用时(如 render 循环中的 isAutoMemoryEnabled)
// 触发重复曝光事件
const loggedExposures = new Set<string>()

// 跟踪安全门检查的重新初始化 Promise
// 当 GrowthBook 重新初始化时(如认证变更后)，安全门检查
// 应等待 init 完成以避免返回陈旧值
let reinitializingPromise: Promise<unknown> | null = null

// GrowthBook 特性值刷新时通知的监听器 (初始 init 或周期性刷新)。
// 用于在构造时将特性值烘焙进长生命周期对象的系统
// (如 zyEventLogger 读取 zy_1p_event_batch_config 一次并用其
// 构建 LoggerProvider)，当配置变化时需要重建。
// 逐次读取器如 getEventSamplingConfig / isSinkKilled 不需要此机制
// —— 它们本身已是响应式的。
//
// resetGrowthBook 不清除 —— 订阅者通常在 init.ts 中注册一次
// 且必须在认证变更重置后存活。
type GrowthBookRefreshListener = () => void | Promise<void>
const refreshed = createSignal()

// 使用同步抛出和异步拒绝均路由到 logError 的方式调用监听器。
function callSafe(listener: GrowthBookRefreshListener): void {
  try {
    // Promise.resolve() 将同步返回值和 Promise 统一处理，使同步抛错（由外层 try 捕获）
    // 与异步拒绝（由 .catch 捕获）都会进入 logError。若缺少 .catch，异步 listener
    // 的拒绝会成为未处理拒绝，因为 try/catch 只能看到 Promise，无法看到其最终拒绝。
    void Promise.resolve(listener()).catch((e) => {
      logError(e)
    })
  } catch (e) {
    logError(e)
  }
}

/**
 * 注册 GrowthBook 功能值刷新时触发的 callback，并返回取消订阅函数。
 *
 * 调用时若 init 已完成且取得功能值（remoteEvalFeatureValues 已填充），listener
 * 会在下一个微任务中触发一次。此补偿用于处理 GB 网络响应早于 REPL useEffect
 * 提交的竞态：在网络较快且 MCP 配置较重的外部构建中，init 约 100ms 即可完成，
 * 而 REPL 挂载约需 600ms（见 #20951 external-build trace 30.540 与 31.046）。
 *
 * 变更检测由订阅方负责：每次刷新都会触发 callback；应使用 isEqual 与上次所见
 * 配置比较，以决定是否执行操作。
 */
export function onGrowthBookRefresh(listener: GrowthBookRefreshListener): () => void {
  let subscribed = true
  const unsubscribe = refreshed.subscribe(() => callSafe(listener))
  if (remoteEvalFeatureValues.size > 0) {
    queueMicrotask(() => {
      // 再次检查：从注册到此微任务执行之间，listener 可能已被移除，
      // 或 resetGrowthBook 已清空 Map。
      if (subscribed && remoteEvalFeatureValues.size > 0) {
        callSafe(listener)
      }
    })
  }
  return () => {
    subscribed = false
    unsubscribe()
  }
}

/**
 * 解析 GrowthBook 功能的环境变量覆盖值。
 * 将 CLAUDE_INTERNAL_FC_OVERRIDES 设置为功能键到值的 JSON 映射，即可绕过远程
 * 评估和磁盘缓存。适用于需要测试特定 feature flag 配置的 eval harness。
 * 仅在 USER_TYPE 为 'ant' 时生效。
 *
 * Example: CLAUDE_INTERNAL_FC_OVERRIDES='{"my_feature": true, "my_config": {"key": "val"}}'
 */
let envOverrides: Record<string, unknown> | null = null
let envOverridesParsed = false

function getEnvOverrides(): Record<string, unknown> | null {
  if (!envOverridesParsed) {
    envOverridesParsed = true
    if (isInternalBuild()) {
      const raw = process.env.CLAUDE_INTERNAL_FC_OVERRIDES
      if (raw) {
        try {
          envOverrides = JSON.parse(raw) as Record<string, unknown>
          logForDebugging(
            `GrowthBook: Using env var overrides for ${Object.keys(envOverrides!).length} features: ${Object.keys(envOverrides!).join(', ')}`,
          )
        } catch {
          logError(new Error(`GrowthBook: Failed to parse CLAUDE_INTERNAL_FC_OVERRIDES: ${raw}`))
        }
      }
    }
  }
  return envOverrides
}

/**
 * 检查功能是否有环境变量覆盖值（CLAUDE_INTERNAL_FC_OVERRIDES）。
 * 若有，_CACHED_MAY_BE_STALE 会直接返回覆盖值而不访问磁盘或网络；
 * 调用方可跳过等待该功能初始化。
 */
export function hasGrowthBookEnvOverride(feature: string): boolean {
  const overrides = getEnvOverrides()
  return overrides !== null && feature in overrides
}

/**
 * 通过 /config 的 Gates 标签设置本地配置覆盖值（仅限 ant）。其优先级低于环境
 * 变量覆盖值，确保 eval harness 结果可复现。与 getEnvOverrides 不同，此处不做
 * memoize：用户可在运行时修改覆盖值，且 getGlobalConfig() 已在内存中缓存
 *（指针读取），直至下次 saveGlobalConfig() 使其失效。
 */
function getConfigOverrides(): Record<string, unknown> | undefined {
  if (!isInternalBuild()) {
    return undefined
  }
  try {
    return getGlobalConfig().growthBookOverrides
  } catch {
    // 在 configReadingAllowed 设置前（main.tsx 启动早期路径），
    // getGlobalConfig() 会抛错；此处采用与下方磁盘缓存 fallback 相同的降级方式。
    return undefined
  }
}

/**
 * 枚举所有已知 GrowthBook 功能及当前解析值（不含覆盖值）。优先使用内存 payload，
 * 再退回磁盘缓存，与 getter 的优先级一致。供 /config 的 Gates 标签使用。
 */
export function getAllGrowthBookFeatures(): Record<string, unknown> {
  if (remoteEvalFeatureValues.size > 0) {
    return Object.fromEntries(remoteEvalFeatureValues)
  }
  return getGlobalConfig().cachedGrowthBookFeatures ?? {}
}

export function getGrowthBookConfigOverrides(): Record<string, unknown> {
  return getConfigOverrides() ?? {}
}

/**
 * 设置或清除单个配置覆盖值；传入 undefined 表示清除。
 * 触发 onGrowthBookRefresh listener，使将 gate 值固化到长生命周期对象中的系统
 *（useMainLoopModel、useSkillsChange 等）重新构建；否则覆盖
 * zy_ant_model_override 等值后，要到下次周期刷新才会真正更换模型。
 */
export function setGrowthBookConfigOverride(feature: string, value: unknown): void {
  if (!isInternalBuild()) {
    return
  }
  try {
    saveGlobalConfig((c) => {
      const current = c.growthBookOverrides ?? {}
      if (value === undefined) {
        if (!(feature in current)) {
          return c
        }
        const { [feature]: _, ...rest } = current
        if (Object.keys(rest).length === 0) {
          const { growthBookOverrides: __, ...configWithout } = c
          return configWithout
        }
        return { ...c, growthBookOverrides: rest }
      }
      if (isEqual(current[feature], value)) {
        return c
      }
      return { ...c, growthBookOverrides: { ...current, [feature]: value } }
    })
    // 订阅方自行执行变更检测（见 onGrowthBookRefresh 文档），
    // 因此写入未改变值时触发也没有问题。
    refreshed.emit()
  } catch (e) {
    logError(e)
  }
}

export function clearGrowthBookConfigOverrides(): void {
  if (!isInternalBuild()) {
    return
  }
  try {
    saveGlobalConfig((c) => {
      if (!c.growthBookOverrides || Object.keys(c.growthBookOverrides).length === 0) {
        return c
      }
      const { growthBookOverrides: _, ...rest } = c
      return rest
    })
    refreshed.emit()
  } catch (e) {
    logError(e)
  }
}

/**
 * 功能包含实验数据时记录实验曝光。同一会话内去重，每项功能最多记录一次。
 */
function logExposureForFeature(feature: string): void {
  // 本会话已记录时跳过，以实现去重。
  if (loggedExposures.has(feature)) {
    return
  }

  const expData = experimentDataByFeature.get(feature)
  if (expData) {
    loggedExposures.add(feature)
    logGrowthBookExperimentToZy({
      experimentId: expData.experimentId,
      variationId: expData.variationId,
      userAttributes: getUserAttributes(),
      experimentMetadata: {
        feature_id: feature,
      },
    })
  }
}

/**
 * 处理 GrowthBook 服务器的远程评估 payload 并填充本地缓存。在初始
 * client.init() 和 client.refreshFeatures() 后都会调用，使 _BLOCKS_ON_INIT
 * 调用方在整个进程生命周期内都能取得新值，而非仅看到初始化快照。
 *
 * 若刷新时不执行，remoteEvalFeatureValues 会冻结在初始化快照，
 * getDynamicConfig_BLOCKS_ON_INIT 会在整个进程生命周期返回陈旧值，
 * 导致 zy_max_version_config kill switch 对长时间会话失效。
 */
async function _processRemoteEvalPayload(gbClient: GrowthBook): Promise<boolean> {
  // WORKAROUND：转换远程评估响应格式。API 返回 { "value": ... }，
  // 但 SDK 需要 { "defaultValue": ... }。
  // TODO：API 修复为返回正确格式后移除此逻辑。
  const payload = gbClient.getPayload()
  // 空对象为 truthy；若没有长度检查，`{features: {}}`（服务器临时故障或响应被截断）
  // 会通过校验、清空下方 Map 并返回 true，随后 syncRemoteEvalToDisk 会将 `{}`
  // 整体写入磁盘，使所有共享 ~/.zy.json 的进程丢失全部 flag。
  if (!payload?.features || Object.keys(payload.features).length === 0) {
    return false
  }

  // 重建前先清空，避免两次刷新间删除的功能留下陈旧幽灵条目，
  // 导致 getFeatureValueInternal 提前返回。
  experimentDataByFeature.clear()

  const transformedFeatures: Record<string, MalformedFeatureDefinition> = {}
  for (const [key, feature] of Object.entries(payload.features)) {
    const f = feature as MalformedFeatureDefinition
    if ('value' in f && !('defaultValue' in f)) {
      transformedFeatures[key] = {
        ...f,
        defaultValue: f.value,
      }
    } else {
      transformedFeatures[key] = f
    }

    // 保存实验数据，待功能被访问时记录。
    if (f.source === 'experiment' && f.experimentResult) {
      const expResult = f.experimentResult as {
        variationId?: number
      }
      const exp = f.experiment as { key?: string } | undefined
      if (exp?.key && expResult.variationId !== undefined) {
        experimentDataByFeature.set(key, {
          experimentId: exp.key,
          variationId: expResult.variationId,
        })
      }
    }
  }
  // 使用转换后的功能重新设置 payload。
  await gbClient.setPayload({
    ...payload,
    features: transformedFeatures,
  })

  // WORKAROUND：直接缓存远程评估响应中的已评估值。SDK 的 evalFeature() 会尝试
  // 在本地重新评估规则，忽略 remoteEval 预评估的 'value'；setForcedFeatures
  // 也不可靠。因此自行缓存值，并在 getFeatureValueInternal 中使用。
  remoteEvalFeatureValues.clear()
  for (const [key, feature] of Object.entries(transformedFeatures)) {
    // remoteEval:true 时由服务器预评估。无论结果位于 `value`（当前 API）还是
    // `defaultValue`（TODO 完成后的 API 形态），它都是该用户的权威值。
    // 同时兼容两者，可确保 API 部分或完整迁移期间 syncRemoteEvalToDisk 都正确。
    const v = 'value' in feature ? feature.value : feature.defaultValue
    if (v !== undefined) {
      remoteEvalFeatureValues.set(key, v)
    }
  }
  return true
}

/**
 * 将完整 remoteEvalFeatureValues Map 写入磁盘。每次
 * processRemoteEvalPayload 成功后恰好调用一次，失败路径不会调用，
 * 因而从结构上避免 init 超时污染（init 的 .catch() 不会到达此处）。
 *
 * 整体替换而非合并：服务端删除的功能会在下次成功 payload 后从磁盘移除。
 * Ant 构建包含 external 构建的功能集合，因此切换构建安全；写入内容始终是
 * 当前进程 SDK key 对应的完整结果。
 */
function _syncRemoteEvalToDisk(): void {
  const fresh = Object.fromEntries(remoteEvalFeatureValues)
  const config = getGlobalConfig()
  if (isEqual(config.cachedGrowthBookFeatures, fresh)) {
    return
  }
  saveGlobalConfig((current) => ({
    ...current,
    cachedGrowthBookFeatures: fresh,
  }))
}

/**
 * 检查是否应启用 GrowthBook 操作。
 */
function isGrowthBookEnabled(): boolean {
  // GrowthBook 依赖直接 API 事件日志。
  return isZyEventLoggingEnabled()
}

/**
 * ZY_CODE_BASE_URL 指向非 Anthropic proxy 时的 hostname。
 *
 * 企业 proxy 部署（Epic、Marble 等）通常使用 apiKeyHelper 鉴权，因此
 * isAuthEnabled() 返回 false，GrowthBook 属性中也没有
 * organizationUUID/accountUUID/email。若不补充此值，就只剩每设备 ID，
 * 无法使用稳定属性进行定向。参见 src/utils/auth.ts 的 isAuthEnabled()。
 *
 * 未设置或采用默认值 api.anthropic.com 时返回 undefined，使直接 API 用户不带该属性。
 * 仅返回 hostname，不含 path、query 或凭据。
 */
export function getApiBaseUrlHost(): string | undefined {
  const baseUrl = process.env.ZY_CODE_BASE_URL
  if (!baseUrl) {
    return undefined
  }
  try {
    const host = new URL(baseUrl).host
    if (host === 'api.anthropic.com') {
      return undefined
    }
    return host
  } catch {
    return undefined
  }
}

/**
 * 从 CoreUserData 获取 GrowthBook 用户属性。
 */
function getUserAttributes(): GrowthBookUserAttributes {
  const user = getUserForGrowthBook()

  // 对 ant 而言，即使设置了自定义 API key，也始终尝试包含 OAuth 配置中的 email，
  // 确保无论采用哪种鉴权方式，GrowthBook 都能按 email 定向。
  let email = user.email
  if (!email && isInternalBuild()) {
    email = getGlobalConfig().oauthAccount?.emailAddress
  }

  const apiBaseUrlHost = getApiBaseUrlHost()

  const attributes = {
    id: user.deviceId,
    sessionId: user.sessionId,
    deviceID: user.deviceId,
    platform: user.platform,
    ...(apiBaseUrlHost && { apiBaseUrlHost }),
    ...(user.organizationUuid && { organizationUUID: user.organizationUuid }),
    ...(user.accountUuid && { accountUUID: user.accountUuid }),
    ...(user.userType && { userType: user.userType }),
    ...(user.subscriptionType && { subscriptionType: user.subscriptionType }),
    ...(user.rateLimitTier && { rateLimitTier: user.rateLimitTier }),
    ...(user.firstTokenTime && { firstTokenTime: user.firstTokenTime }),
    ...(email && { email }),
    ...(user.appVersion && { appVersion: user.appVersion }),
    ...(user.githubActionsMetadata && {
      githubActionsMetadata: user.githubActionsMetadata,
    }),
  }
  return attributes
}

/**
 * 获取或创建 GrowthBook client 实例。
 */
const getGrowthBookClient = memoize(
  (): { client: GrowthBook; initialized: Promise<void> } | null => {
    if (!isGrowthBookEnabled()) {
      return null
    }

    const attributes = getUserAttributes()
    const clientKey = getGrowthBookClientKey()
    if (isInternalBuild()) {
      logForDebugging(
        `GrowthBook: Creating client with clientKey=${clientKey}, attributes: ${jsonStringify(attributes)}`,
      )
    }
    const baseUrl = isInternalBuild() ? process.env.ZY_CODE_GB_BASE_URL : ''

    // 信任流程完成前不附加认证头，避免初始化阶段提前触发认证工作。
    // 非交互会话隐式拥有 workspace trust。
    // getSessionTrustAccepted() 覆盖 TrustDialog 已自动完成但未为当前 CWD
    // 持久化信任的情况（例如 home 目录）；showSetupScreens() 会在流程结束后设置。
    const hasTrust =
      checkHasTrustDialogAccepted() || getSessionTrustAccepted() || getIsNonInteractiveSession()
    const authHeaders = hasTrust
      ? getAuthHeaders()
      : { headers: {}, error: 'trust not established' }
    const hasAuth = !authHeaders.error
    clientCreatedWithAuth = hasAuth

    // 保存到局部变量，确保 init callback 操作的是当前 client，而非 init 完成前
    // 发生重新初始化后创建的新 client。
    const thisClient = new GrowthBook({
      apiHost: baseUrl,
      clientKey,
      attributes,
      remoteEval: true,
      // user ID 或组织变化时重新获取；组织变化表示登录了其他组织。
      cacheKeyAttributes: ['id', 'organizationUUID'],
      // 有可用鉴权 header 时添加。
      ...(authHeaders.error ? {} : { apiHostRequestHeaders: authHeaders.headers }),
      // 供 Ant 调试的日志。
      ...(isInternalBuild()
        ? {
            log: (msg: string, ctx: Record<string, unknown>) => {
              logForDebugging(`GrowthBook: ${msg} ${jsonStringify(ctx)}`)
            },
          }
        : {}),
    })
    client = thisClient

    if (!hasAuth) {
      // 尚无可用鉴权，跳过 HTTP init 并使用磁盘缓存值。鉴权可用后，
      // initializeGrowthBook() 会重置并带鉴权重新创建。
      return { client: thisClient, initialized: Promise.resolve() }
    }

    // TODO: 等待 ZY Code 自建 GrowthBook 服务就绪后启用
    // const initialized = thisClient
    //   .init({ timeout: 5000 })
    //   .then(async (result) => {
    //     // Guard: if this client was replaced by a newer one, skip processing
    //     if (client !== thisClient) {
    //       if (isInternalBuild()) {
    //         logForDebugging('GrowthBook: Skipping init callback for replaced client')
    //       }
    //       return
    //     }
    //
    //     if (isInternalBuild()) {
    //       logForDebugging(
    //         `GrowthBook initialized successfully, source: ${result.source}, success: ${result.success}`,
    //       )
    //     }
    //
    //     const hadFeatures = await processRemoteEvalPayload(thisClient)
    //     // Re-check: processRemoteEvalPayload yields at `await setPayload`.
    //     // Microtask-only today (no encryption, no sticky-bucket service), but
    //     // the guard at the top of this callback runs before that await;
    //     // this runs after.
    //     if (client !== thisClient) return
    //
    //     if (hadFeatures) {
    //       for (const feature of pendingExposures) {
    //         logExposureForFeature(feature)
    //       }
    //       pendingExposures.clear()
    //       syncRemoteEvalToDisk()
    //       // Notify subscribers: remoteEvalFeatureValues is populated and
    //       // disk is freshly synced. _CACHED_MAY_BE_STALE reads memory first
    //       // (#22295), so subscribers see fresh values immediately.
    //       refreshed.emit()
    //     }
    //
    //     // Log what features were loaded
    //     if (isInternalBuild()) {
    //       const features = thisClient.getFeatures()
    //       if (features) {
    //         const featureKeys = Object.keys(features)
    //         logForDebugging(
    //           `GrowthBook loaded ${featureKeys.length} features: ${featureKeys.slice(0, 10).join(', ')}${featureKeys.length > 10 ? '...' : ''}`,
    //         )
    //       }
    //     }
    //   })
    //   .catch((error) => {
    //     if (isInternalBuild()) {
    //       logError(toError(error))
    //     }
    //   })
    const initialized = Promise.resolve()

    // 注册用于优雅关闭的 cleanup handler；使用具名引用，以便 resetGrowthBook 移除。
    currentBeforeExitHandler = () => client?.destroy()
    currentExitHandler = () => client?.destroy()
    process.on('beforeExit', currentBeforeExitHandler)
    process.on('exit', currentExitHandler)

    return { client: thisClient, initialized }
  },
)

/**
 * 初始化 GrowthBook client，并阻塞至就绪。
 */
export const initializeGrowthBook = memoize(async (): Promise<GrowthBook | null> => {
  let clientWrapper = getGrowthBookClient()
  if (!clientWrapper) {
    return null
  }

  // 如果 client 创建后认证变为可用，需要用新的认证头重建 client。
  // 仅在信任流程完成后检查，避免初始化阶段提前触发认证工作。
  if (!clientCreatedWithAuth) {
    const hasTrust =
      checkHasTrustDialogAccepted() || getSessionTrustAccepted() || getIsNonInteractiveSession()
    if (hasTrust) {
      const currentAuth = getAuthHeaders()
      if (!currentAuth.error) {
        if (isInternalBuild()) {
          logForDebugging('GrowthBook: Auth became available after client creation, reinitializing')
        }
        // 使用 resetGrowthBook 正确销毁旧 client 并停止周期刷新，
        // 避免旧 client 的 init Promise 仍在运行而导致重复初始化。
        resetGrowthBook()
        clientWrapper = getGrowthBookClient()
        if (!clientWrapper) {
          return null
        }
      }
    }
  }

  await clientWrapper.initialized

  // 初始化成功后设置周期刷新。此处统一调用，确保每次重新初始化后都会恢复。
  setupPeriodicGrowthBookRefresh()

  return clientWrapper.client
})

/**
 * 获取功能值，并以默认值 fallback；阻塞至初始化完成。
 * @internal 由 deprecated 函数和缓存函数共同使用。
 */
async function getFeatureValueInternal<T>(
  feature: string,
  defaultValue: T,
  logExposure: boolean,
): Promise<T> {
  // 优先检查环境变量覆盖值，供 eval harness 使用。
  const overrides = getEnvOverrides()
  if (overrides && feature in overrides) {
    return overrides[feature] as T
  }
  const configOverrides = getConfigOverrides()
  if (configOverrides && feature in configOverrides) {
    return configOverrides[feature] as T
  }

  if (!isGrowthBookEnabled()) {
    return defaultValue
  }

  const growthBookClient = await initializeGrowthBook()
  if (!growthBookClient) {
    return defaultValue
  }

  // 有缓存的远程评估值时优先使用，以规避 SDK bug。
  let result: T
  if (remoteEvalFeatureValues.has(feature)) {
    result = remoteEvalFeatureValues.get(feature) as T
  } else {
    result = growthBookClient.getFeatureValue(feature, defaultValue) as T
  }

  // 使用已保存的实验数据记录实验曝光。
  if (logExposure) {
    logExposureForFeature(feature)
  }

  if (isInternalBuild()) {
    logForDebugging(`GrowthBook: getFeatureValue("${feature}") = ${jsonStringify(result)}`)
  }
  return result
}

/**
 * @deprecated 请改用非阻塞的 getFeatureValue_CACHED_MAY_BE_STALE。
 * 此函数会等待 GrowthBook 初始化，可能拖慢启动。
 */
export async function getFeatureValue_DEPRECATED<T>(feature: string, defaultValue: T): Promise<T> {
  return getFeatureValueInternal(feature, defaultValue, true)
}

/**
 * 立即从磁盘缓存获取功能值。此函数只读；每次 payload 成功（init 和周期刷新）时，
 * 磁盘由 syncRemoteEvalToDisk 填充。
 *
 * 这是启动关键路径和同步上下文的首选方式。若缓存由此前进程写入，值可能已过期。
 */
export function getFeatureValue_CACHED_MAY_BE_STALE<T>(feature: string, defaultValue: T): T {
  // 优先检查环境变量覆盖值，供 eval harness 使用。
  const overrides = getEnvOverrides()
  if (overrides && feature in overrides) {
    return overrides[feature] as T
  }
  const configOverrides = getConfigOverrides()
  if (configOverrides && feature in configOverrides) {
    return configOverrides[feature] as T
  }

  if (!isGrowthBookEnabled()) {
    return defaultValue
  }

  // 有数据时记录实验曝光，否则延迟到 init 后处理。
  if (experimentDataByFeature.has(feature)) {
    logExposureForFeature(feature)
  } else {
    pendingExposures.add(feature)
  }

  // processRemoteEvalPayload 运行后，内存 payload 即为权威值。此时磁盘也已更新
  //（syncRemoteEvalToDisk 在 init 内同步运行），因此正确性等同于下方磁盘读取，
  // 但可跳过配置 JSON 解析；onGrowthBookRefresh 订阅方依靠此路径在收到通知时
  // 立即读取新值。
  if (remoteEvalFeatureValues.has(feature)) {
    return remoteEvalFeatureValues.get(feature) as T
  }

  // 退回可跨进程重启保留的磁盘缓存。
  try {
    const cached = getGlobalConfig().cachedGrowthBookFeatures?.[feature]
    return cached !== undefined ? (cached as T) : defaultValue
  } catch {
    return defaultValue
  }
}

/**
 * 通过 GrowthBook 检查 Statsig feature gate，并可退回 Statsig 缓存。
 *
 * **仅用于迁移**：此函数用于将已有 Statsig gate 迁移到 GrowthBook。
 * 新功能请使用 `getFeatureValue_CACHED_MAY_BE_STALE()`。
 *
 * - 优先检查 GrowthBook 磁盘缓存
 * - 迁移期间退回 Statsig 的 cachedStatsigGates
 * - 缓存近期未更新时，值可能已过期
 *
 * @deprecated 新代码请使用 getFeatureValue_CACHED_MAY_BE_STALE()。
 * 此函数仅用于支持已有 Statsig gate 的迁移。
 */
export function checkStatsigFeatureGate_CACHED_MAY_BE_STALE(gate: string): boolean {
  // 优先检查环境变量覆盖值，供 eval harness 使用。
  const overrides = getEnvOverrides()
  if (overrides && gate in overrides) {
    return Boolean(overrides[gate])
  }
  const configOverrides = getConfigOverrides()
  if (configOverrides && gate in configOverrides) {
    return Boolean(configOverrides[gate])
  }

  if (!isGrowthBookEnabled()) {
    return false
  }

  // 有数据时记录实验曝光，否则延迟到 init 后处理。
  if (experimentDataByFeature.has(gate)) {
    logExposureForFeature(gate)
  } else {
    pendingExposures.add(gate)
  }

  // 立即返回磁盘缓存值：先检查 GrowthBook 缓存，再在迁移期间退回 Statsig 缓存。
  const config = getGlobalConfig()
  const gbCached = config.cachedGrowthBookFeatures?.[gate]
  if (gbCached !== undefined) {
    return Boolean(gbCached)
  }
  // 迁移期间退回 Statsig 缓存。
  return config.cachedStatsigGates?.[gate] ?? false
}

/**
 * 检查安全限制 gate；正在重新初始化时等待完成。
 *
 * 用于鉴权变化后必须取得新值的安全关键 gate。
 *
 * Behavior:
 * - GrowthBook 正在重新初始化（如登录后）时等待完成
 * - 否则立即返回缓存值，先查 Statsig，再查 GrowthBook
 *
 * 出于安全考虑，相关检查优先查看 Statsig 缓存；若其中表明 gate 已启用，则予以采用。
 */
export async function checkSecurityRestrictionGate(gate: string): Promise<boolean> {
  // 优先检查环境变量覆盖值，供 eval harness 使用。
  const overrides = getEnvOverrides()
  if (overrides && gate in overrides) {
    return Boolean(overrides[gate])
  }
  const configOverrides = getConfigOverrides()
  if (configOverrides && gate in configOverrides) {
    return Boolean(configOverrides[gate])
  }

  if (!isGrowthBookEnabled()) {
    return false
  }

  // 正在重新初始化时等待完成，确保鉴权变化后取得新值。
  if (reinitializingPromise) {
    await reinitializingPromise
  }

  // 优先检查 Statsig 缓存，其中可能保留上次登录会话的正确值。
  const config = getGlobalConfig()
  const statsigCached = config.cachedStatsigGates?.[gate]
  if (statsigCached !== undefined) {
    return Boolean(statsigCached)
  }

  // 随后检查 GrowthBook 缓存。
  const gbCached = config.cachedGrowthBookFeatures?.[gate]
  if (gbCached !== undefined) {
    return Boolean(gbCached)
  }

  // 无缓存时返回 false，不为未缓存 gate 阻塞等待 init。
  return false
}

/**
 * 以 fallback-to-blocking 语义检查布尔 entitlement gate。
 *
 * 快速路径：磁盘缓存为 `true` 时立即返回。慢速路径：磁盘为 `false` 或缺失时，
 * 等待 GrowthBook init 并获取服务端新值（最多约 5 秒）。init 内的
 * syncRemoteEvalToDisk 会填充磁盘，因此慢速路径返回时磁盘已有新值，
 * 此处无需再写入。
 *
 * 用于受订阅或组织限制、由用户主动调用的功能（如 /remote-control）。
 * 陈旧的 `false` 会不合理地阻止访问，而陈旧的 `true` 可以接受，
 * 因为服务端才是实际 gatekeeper。
 */
export async function checkGate_CACHED_OR_BLOCKING(gate: string): Promise<boolean> {
  // 优先检查环境变量覆盖值，供 eval harness 使用。
  const overrides = getEnvOverrides()
  if (overrides && gate in overrides) {
    return Boolean(overrides[gate])
  }
  const configOverrides = getConfigOverrides()
  if (configOverrides && gate in configOverrides) {
    return Boolean(configOverrides[gate])
  }

  if (!isGrowthBookEnabled()) {
    return false
  }

  // 快速路径：磁盘缓存已为 true，直接信任。
  const cached = getGlobalConfig().cachedGrowthBookFeatures?.[gate]
  if (cached === true) {
    // 有数据时记录实验曝光，否则延迟处理。
    if (experimentDataByFeature.has(gate)) {
      logExposureForFeature(gate)
    } else {
      pendingExposures.add(gate)
    }
    return true
  }

  // 慢速路径：磁盘值为 false 或缺失，可能已过期，获取新值。
  return getFeatureValueInternal(gate, false, true)
}

/**
 * 鉴权变化（登录或登出）后刷新 GrowthBook。
 *
 * 注意：必须销毁并重建 client，因为 GrowthBook 的 apiHostRequestHeaders
 * 无法在 client 创建后更新。
 */
export function refreshGrowthBookAfterAuthChange(): void {
  if (!isGrowthBookEnabled()) {
    return
  }

  try {
    // 完全重置 client 以取得新鉴权 header；apiHostRequestHeaders 创建后无法更新。
    resetGrowthBook()

    // resetGrowthBook 已清空 remoteEvalFeatureValues。若下方重新初始化超时
    //（hadFeatures=false）或因 !hasAuth（登出）而提前结束，init callback 的通知
    // 永远不会触发，订阅方会继续同步到上一账号的 memoize 状态。此处主动通知，
    // 让其立即重读（退回磁盘缓存）。重新初始化成功时会再次以新值通知；
    // 即使失败，至少也会同步到重置后的状态。
    refreshed.emit()

    // 使用新鉴权 header 和属性重新初始化，并跟踪此 Promise，供安全 gate 检查等待。
    // .catch 必须放在 .finally 前：同步辅助函数（getGrowthBookClient、
    // getAuthHeaders、resetGrowthBook）抛错时 initializeGrowthBook 可能拒绝；
    // clientWrapper.initialized 自带 .catch，因此不会拒绝。finally 会按原拒绝状态
    // 重新 settled，而下方同步 try/catch 无法捕获异步拒绝。
    reinitializingPromise = initializeGrowthBook()
      .catch((error) => {
        logError(toError(error))
        return null
      })
      .finally(() => {
        reinitializingPromise = null
      })
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      throw error
    }
    logError(toError(error))
  }
}

/**
 * 重置 GrowthBook client 状态，主要供测试使用。
 */
export function resetGrowthBook(): void {
  stopPeriodicGrowthBookRefresh()
  // 销毁 client 前移除进程 handler，防止累积。
  if (currentBeforeExitHandler) {
    process.off('beforeExit', currentBeforeExitHandler)
    currentBeforeExitHandler = null
  }
  if (currentExitHandler) {
    process.off('exit', currentExitHandler)
    currentExitHandler = null
  }
  client?.destroy()
  client = null
  clientCreatedWithAuth = false
  reinitializingPromise = null
  experimentDataByFeature.clear()
  pendingExposures.clear()
  loggedExposures.clear()
  remoteEvalFeatureValues.clear()
  getGrowthBookClient.cache?.clear?.()
  initializeGrowthBook.cache?.clear?.()
  envOverrides = null
  envOverridesParsed = false
}

// 周期刷新间隔，与 Statsig 的 6 小时间隔一致。
const GROWTHBOOK_REFRESH_INTERVAL_MS = !isInternalBuild()
  ? 6 * 60 * 60 * 1000 // 6 hours
  : 20 * 60 * 1000 // 20 min (for ants)
let refreshInterval: ReturnType<typeof setInterval> | null = null
let beforeExitListener: (() => void) | null = null

/**
 * 轻量刷新：不重建 client，直接从服务器重新获取功能。
 * 鉴权 header 未变化时用于周期刷新。
 *
 * 与销毁并重建 client 的 refreshGrowthBookAfterAuthChange() 不同，
 * 此函数保留 client 状态，只获取新的功能值。
 */
export async function refreshGrowthBookFeatures(): Promise<void> {
  if (!isGrowthBookEnabled()) {
    return
  }

  try {
    const growthBookClient = await initializeGrowthBook()
    if (!growthBookClient) {
      return
    }

    // TODO: 等待 ZY Code 自建 GrowthBook 服务就绪后启用
    // await growthBookClient.refreshFeatures()
    //
    // // Guard: if this client was replaced during the in-flight refresh
    // // (e.g. refreshGrowthBookAfterAuthChange ran), skip processing the
    // // stale payload. Mirrors the init-callback guard above.
    // if (growthBookClient !== client) {
    //   if (isInternalBuild()) {
    //     logForDebugging('GrowthBook: Skipping refresh processing for replaced client')
    //   }
    //   return
    // }
    //
    // // Rebuild remoteEvalFeatureValues from the refreshed payload so that
    // // _BLOCKS_ON_INIT callers (e.g. getMaxVersion for the auto-update kill
    // // switch) see fresh values, not the stale init-time snapshot.
    // const hadFeatures = await processRemoteEvalPayload(growthBookClient)
    // // Same re-check as init path: covers the setPayload yield inside
    // // processRemoteEvalPayload (the guard above only covers refreshFeatures).
    // if (growthBookClient !== client) return
    //
    // if (isInternalBuild()) {
    //   logForDebugging('GrowthBook: Light refresh completed')
    // }
    //
    // // Gate on hadFeatures: if the payload was empty/malformed,
    // // remoteEvalFeatureValues wasn't rebuilt — skip both the no-op disk
    // // write and the spurious subscriber churn (clearCommandMemoizationCaches
    // // + getCommands + 4× model re-renders).
    // if (hadFeatures) {
    //   syncRemoteEvalToDisk()
    //   refreshed.emit()
    // }
    return
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      throw error
    }
    logError(toError(error))
  }
}

/**
 * 设置 GrowthBook 功能的周期刷新。使用轻量刷新 refreshGrowthBookFeatures，
 * 无需重建 client 即可重新获取。
 *
 * 长时间会话应在初始化后调用，确保功能值保持最新。间隔与 Statsig 的 6 小时一致。
 */
export function setupPeriodicGrowthBookRefresh(): void {
  if (!isGrowthBookEnabled()) {
    return
  }

  // 清除已有 interval，避免重复。
  if (refreshInterval) {
    clearInterval(refreshInterval)
  }

  refreshInterval = setInterval(() => {
    void refreshGrowthBookFeatures()
  }, GROWTHBOOK_REFRESH_INTERVAL_MS)
  // 允许进程自然退出，此计时器不应阻止进程结束。
  refreshInterval.unref?.()

  // cleanup listener 只注册一次。
  if (!beforeExitListener) {
    beforeExitListener = () => {
      stopPeriodicGrowthBookRefresh()
    }
    process.once('beforeExit', beforeExitListener)
  }
}

/**
 * 停止周期刷新，供测试或清理使用。
 */
export function stopPeriodicGrowthBookRefresh(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval)
    refreshInterval = null
  }
  if (beforeExitListener) {
    process.removeListener('beforeExit', beforeExitListener)
    beforeExitListener = null
  }
}

// ============================================================================
// Dynamic Config 函数。这些是对功能函数的语义包装，用于与 Statsig API 对齐。
// 在 GrowthBook 中，dynamic config 就是值为对象的功能。
// ============================================================================

/**
 * 获取 dynamic config 值，并阻塞至 GrowthBook 初始化完成。
 * 启动关键路径优先使用 getFeatureValue_CACHED_MAY_BE_STALE。
 */
export async function getDynamicConfig_BLOCKS_ON_INIT<T>(
  configName: string,
  defaultValue: T,
): Promise<T> {
  return getFeatureValue_DEPRECATED(configName, defaultValue)
}

/**
 * 立即从磁盘缓存读取 dynamic config 值。此函数只读，另见
 * getFeatureValue_CACHED_MAY_BE_STALE.
 * 这是启动关键路径和同步上下文的首选方式。
 *
 * 在 GrowthBook 中，dynamic config 就是值为对象的功能。
 */
export function getDynamicConfig_CACHED_MAY_BE_STALE<T>(configName: string, defaultValue: T): T {
  return getFeatureValue_CACHED_MAY_BE_STALE(configName, defaultValue)
}
