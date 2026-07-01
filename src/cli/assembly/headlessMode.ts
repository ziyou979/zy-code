// 无头（--print）模式装配。
// 从 root.ts 的 `if (isNonInteractiveSession)` 块提取。
// 处理 stream-json/json 格式设置、遥测初始化、SessionStart 钩子、
// org 验证、headlessStore 创建、MCP 批量连接、zy.ai MCP 连接、
// 以及最终的 runHeadless 调用。

import { feature } from 'bun:bundle'
import pickBy from 'lodash-es/pickBy.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { setSdkBetas, setSessionPersistenceDisabled } from '../../bootstrap/state.js'
import { startDeferredPrefetches } from '../../cli/bootstrap/prefetch.js'
import { logSessionTelemetry } from '../../cli/bootstrap/telemetry.js'
import { initializeTelemetryAfterTrust } from '../../entrypoints/init.js'
import { clearServerCache, getMcpToolsCommandsAndResources } from '../../services/mcp/client.js'
import { dedupZyAIMcpServers, getMcpServerSignature } from '../../services/mcp/config.js'
import type { McpSdkServerConfig, ScopedMcpServerConfig } from '../../services/mcp/types.js'
import { excludeCommandsByServer, excludeResourcesByServer } from '../../services/mcp/utils.js'
import { type AppState, getDefaultAppState } from '../../state/AppStateStore.js'
import { onChangeAppState } from '../../state/onChangeAppState.js'
import { createStore } from '../../state/store.js'
import type { ToolInputJSONSchema, ToolPermissionContext, Tools } from '../../Tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { Command } from '../../types/command.js'
import { isAdvisorEnabled } from '../../utils/advisor.js'
import { validateForceLoginOrg } from '../../utils/auth.js'
import { filterAllowedSdkBetas } from '../../utils/betas.js'
import { logForDebugging, setHasFormattedOutput } from '../../utils/debug.js'
import { resolveInitialEffortSetting } from '../../utils/effort.js'
import { isBareMode } from '../../utils/envUtils.js'
import { applyConfigEnvironmentVariables } from '../../utils/managedEnv.js'
import {
  checkAndDisableBypassPermissions,
  verifyAutoModeGateAccess,
} from '../../utils/permissions/permissionSetup.js'
import { processSessionStartHooks } from '../../utils/sessionStart.js'
import { profileCheckpoint } from '../../utils/startupProfiler.js'
import type { ThinkingConfig } from '../../utils/thinking.js'

// ---------- 参数接口 ----------

/** rootAction 传入无头模式的全部上下文。 */
export interface HeadlessModeParams {
  // 用户输入（可能是 stream-json 的 AsyncIterable）
  inputPrompt: string | AsyncIterable<string>

  // CLI options 子集
  options: {
    continue?: boolean
    resume?: boolean | string
    effort?: string
    sessionPersistence?: boolean
    permissionPromptTool?: string
    maxTurns?: number
    maxBudgetUsd?: number
    taskBudget?: number
    forkSession?: boolean
    resumeSessionAt?: string
    rewindFiles?: string
    enableAuthStatus?: boolean
    workload?: string
  }

  // 格式与输出
  outputFormat: string | undefined
  verbose: boolean | undefined
  jsonSchema: ToolInputJSONSchema | undefined

  // 工具与权限
  tools: Tools
  toolPermissionContext: ToolPermissionContext
  allowDangerouslySkipPermissions: boolean
  allowedTools: string[]

  // 模型
  effectiveModel: string | undefined
  userSpecifiedFallbackModel: string | undefined
  advisorModel: string | undefined

  // 推理
  thinkingConfig: ThinkingConfig

  // 系统提示
  systemPrompt: string | undefined
  appendSystemPrompt: string | undefined

  // 命令 & 代理
  commands: Command[]
  disableSlashCommands: boolean
  agentActiveAgents: AgentDefinition[]
  agentCli: string | undefined

  // MCP
  mcpClients: AppState['mcp']['clients']
  mcpCommands: AppState['mcp']['commands']
  mcpTools: AppState['mcp']['tools']
  regularMcpConfigs: Record<string, ScopedMcpServerConfig>
  sdkMcpConfigs: Record<string, McpSdkServerConfig>
  zyaiConfigPromise: Promise<Record<string, ScopedMcpServerConfig>>

  // SDK / 集成
  betas: string[]
  sdkUrl: string | undefined
  teleport: string | true | null
  effectiveReplayUserMessages: boolean
  effectiveIncludePartialMessages: boolean

  // 钩子 / 触发
  setupTrigger: 'init' | 'maintenance' | null

  // kairos
  kairosEnabled: boolean
}

// ---------- 主函数 ----------

/**
 * 执行无头（--print）模式的全部启动与运行逻辑。
 * 调用方在此返回后也需要 `return`。
 */
export async function runHeadlessMode(params: HeadlessModeParams): Promise<void> {
  const {
    inputPrompt,
    options,
    outputFormat,
    verbose,
    jsonSchema,
    tools,
    toolPermissionContext,
    allowDangerouslySkipPermissions,
    allowedTools,
    effectiveModel,
    userSpecifiedFallbackModel,
    advisorModel,
    thinkingConfig,
    systemPrompt,
    appendSystemPrompt,
    commands,
    disableSlashCommands,
    agentActiveAgents,
    agentCli,
    mcpClients,
    mcpCommands,
    mcpTools,
    regularMcpConfigs,
    sdkMcpConfigs,
    zyaiConfigPromise,
    betas,
    sdkUrl,
    teleport,
    effectiveReplayUserMessages,
    effectiveIncludePartialMessages,
    setupTrigger,
    kairosEnabled,
  } = params

  if (outputFormat === 'stream-json' || outputFormat === 'json') {
    setHasFormattedOutput(true)
  }

  // 在打印模式下应用完整的环境变量，因为信任对话框被跳过
  // 这包括来自不可信来源的潜在危险环境变量
  // 但打印模式被视为受信任的（如帮助文本中所述）
  applyConfigEnvironmentVariables()

  // 在应用环境变量后初始化遥测，以便 OTEL 端点环境变量和
  // otelHeadersHelper（需要信任才能执行）可用。
  initializeTelemetryAfterTrust()

  // 现在启动 SessionStart 钩子，以便子进程生成与
  // MCP 连接 + 插件初始化 + 下方 print.ts 导入重叠。
  // loadInitialMessages 在 print.ts:4397 连接此 promise。
  // 守卫与 loadInitialMessages 相同 ——
  // continue/resume/teleport 路径不触发启动钩子
  //（或在 resume 分支内有条件地触发它们，此 promise 为
  // undefined 且 ?? 回退运行）。当 setupTrigger 设置时也跳过
  // —— 那些路径先运行 setup 钩子（print.ts:544），且会话
  // 启动钩子必须等待 setup 完成。
  const sessionStartHooksPromise =
    options.continue || options.resume || teleport || setupTrigger
      ? undefined
      : processSessionStartHooks('startup')
  // 如果这在 loadInitialMessages 等待之前拒绝，抑制瞬态 unhandledRejection。
  // 下游等待仍然观察到拒绝 —— 这只是防止虚假的全局处理器触发。
  sessionStartHooksPromise?.catch(() => {})
  profileCheckpoint('before_validateForceLoginOrg')
  // 验证非交互会话的 org 限制
  const orgValidation = await validateForceLoginOrg()
  if (!orgValidation.valid) {
    process.stderr.write(`${orgValidation.message}\n`)
    process.exit(1)
  }

  // 无头模式支持所有提示命令和一些本地命令
  // 如果 disableSlashCommands 为 true，返回空数组
  const commandsHeadless = disableSlashCommands
    ? []
    : commands.filter(
        (command) =>
          (command.type === 'prompt' && !command.disableNonInteractive) ||
          (command.type === 'local' && command.supportsNonInteractive),
      )
  const defaultState = getDefaultAppState()
  const headlessInitialState: AppState = {
    ...defaultState,
    mcp: {
      ...defaultState.mcp,
      clients: mcpClients,
      commands: mcpCommands,
      tools: mcpTools,
    },
    toolPermissionContext,
    effortValue: resolveInitialEffortSetting(options.effort),
    ...(isAdvisorEnabled() &&
      advisorModel && {
        advisorModel,
      }),
    // kairosEnabled 门控 executeForkedSlashCommand 中的异步 fire-and-forget 路径
    //（processSlashCommand.tsx:132）和 AgentTool 的 shouldRunAsync。
    // REPL initialState 在约 3459 处设置此；无头默认为 false，
    // 所以守护进程子计划的任务和 Agent-tool 调用同步运行
    // —— 生成时 N 个逾期的 cron 任务 = N 个串行子代理回合阻塞用户输入。
    ...(feature('KAIROS')
      ? {
          kairosEnabled,
        }
      : {}),
  }

  // 初始化应用状态
  const headlessStore = createStore(headlessInitialState, onChangeAppState)

  // 根据 Statsig 门检查是否应禁用 bypassPermissions
  // 这与下方代码并行运行，以避免阻塞主循环。
  if (toolPermissionContext.mode === 'bypassPermissions' || allowDangerouslySkipPermissions) {
    void checkAndDisableBypassPermissions(toolPermissionContext)
  }

  // 自动模式门的异步检查 —— 更正状态并在需要时禁用自动。
  // 门控在 TRANSCRIPT_CLASSIFIER（不是 USER_TYPE）以便 GrowthBook 终止开关也为外部构建运行。
  void verifyAutoModeGateAccess(toolPermissionContext).then(({ updateContext }) => {
    headlessStore.setState((prev) => {
      const nextCtx = updateContext(prev.toolPermissionContext)
      if (nextCtx === prev.toolPermissionContext) {
        return prev
      }
      return {
        ...prev,
        toolPermissionContext: nextCtx,
      }
    })
  })

  // 为会话持久化设置全局状态
  if (options.sessionPersistence === false) {
    setSessionPersistenceDisabled(true)
  }

  // 将 SDK betas 存储在全局状态中，用于上下文窗口计算
  // 仅存储允许的 betas（按允许列表和订阅者状态过滤）
  setSdkBetas(filterAllowedSdkBetas(betas))

  // 打印模式 MCP：按服务器增量推送到 headlessStore。
  // 镜像 useManageMCPConnections —— 先推送 pending（以便 ToolSearch
  // 在 ToolSearchTool.ts:334 的 pending 检查看到它们），然后用
  // connected/failed 替换每个服务器稳定时。
  const connectMcpBatch = (
    configs: Record<string, ScopedMcpServerConfig>,
    label: string,
  ): Promise<void> => {
    if (Object.keys(configs).length === 0) {
      return Promise.resolve()
    }
    headlessStore.setState((prev) => ({
      ...prev,
      mcp: {
        ...prev.mcp,
        clients: [
          ...prev.mcp.clients,
          ...Object.entries(configs).map(([name, config]) => ({
            name,
            type: 'pending' as const,
            config,
          })),
        ],
      },
    }))
    return getMcpToolsCommandsAndResources(({ client, tools, commands }) => {
      headlessStore.setState((prev) => ({
        ...prev,
        mcp: {
          ...prev.mcp,
          clients: prev.mcp.clients.some((c) => c.name === client.name)
            ? prev.mcp.clients.map((c) => (c.name === client.name ? client : c))
            : [...prev.mcp.clients, client],
          tools: uniqBy([...prev.mcp.tools, ...tools], 'name'),
          commands: uniqBy([...prev.mcp.commands, ...commands], 'name'),
        },
      }))
    }, configs).catch((err) => logForDebugging(`[MCP] ${label} connect error: ${err}`))
  }
  // 等待所有 MCP 配置 —— 打印模式通常是单次，所以
  // "下一轮可见的晚连接服务器"没有帮助。SDK 初始化
  // 消息和第一轮工具列表都需要存在的 MCP 工具。
  // 零服务器情况通过 connectMcpBatch 中的早期返回免费处理。
  // 连接器在 getMcpToolsCommandsAndResources 内部并行化
  //（带 Promise.all 的 processBatched）。zy.ai 也等待 —— 它的
  // 获取很早就启动了（zyaiMcpPromise 在 prefetchAllMcpResources 之前）所以只有剩余时间阻塞
  // 在这里。--bare 完全跳过 zy.ai 以用于性能敏感的脚本。
  profileCheckpoint('before_connectMcp')
  await connectMcpBatch(regularMcpConfigs, 'regular')
  profileCheckpoint('after_connectMcp')
  // 去重：抑制重复 zy.ai 连接器的插件 MCP 服务器
  //（连接器获胜），然后连接 zy.ai 服务器。
  // 有界等待 —— #23725 使其阻塞以便单次 -p 看到
  // 连接器，但有 40+ 慢速连接器时 zy_startup_perf p99
  // 攀升到 76 秒。如果获取+连接没有及时完成，继续；
  // promise 继续运行并在后台更新 headlessStore
  // 以便第 2+ 轮仍然看到连接器。
  const ZY_AI_MCP_TIMEOUT_MS = 5_000
  const zyaiConnect = zyaiConfigPromise.then((zyaiConfigs) => {
    if (Object.keys(zyaiConfigs).length > 0) {
      const zyaiSigs = new Set<string>()
      for (const config of Object.values(zyaiConfigs)) {
        const sig = getMcpServerSignature(config)
        if (sig) {
          zyaiSigs.add(sig)
        }
      }
      const suppressed = new Set<string>()
      for (const [name, config] of Object.entries(regularMcpConfigs)) {
        if (!name.startsWith('plugin:')) {
          continue
        }
        const sig = getMcpServerSignature(config)
        if (sig && zyaiSigs.has(sig)) {
          suppressed.add(name)
        }
      }
      if (suppressed.size > 0) {
        logForDebugging(
          `[MCP] Lazy dedup: suppressing ${suppressed.size} plugin server(s) that duplicate zy.ai connectors: ${[...suppressed].join(', ')}`,
        )
        // 从状态过滤前先断开连接。只有已连接的服务器需要清理 —
        // 对未连接的服务器调用 clearServerCache 会触发一次真实连接
        // 然后立即终止（memoize 缓存未命中路径）。
        for (const c of headlessStore.getState().mcp.clients) {
          if (!suppressed.has(c.name) || c.type !== 'connected') {
            continue
          }
          c.client.onclose = undefined
          void clearServerCache(c.name, c.config).catch(() => {})
        }
        headlessStore.setState((prev) => {
          let { clients, tools, commands, resources } = prev.mcp
          clients = clients.filter((c) => !suppressed.has(c.name))
          tools = tools.filter((t) => !t.mcpInfo || !suppressed.has(t.mcpInfo.serverName))
          for (const name of suppressed) {
            commands = excludeCommandsByServer(commands, name)
            resources = excludeResourcesByServer(resources, name)
          }
          return {
            ...prev,
            mcp: {
              ...prev.mcp,
              clients,
              tools,
              commands,
              resources,
            },
          }
        })
      }
    }
    // 抑制重复已启用手动服务器的 zy.ai 连接器
    //（URL 签名匹配）。上方的插件去重仅处理 `plugin:*` 键；
    // 这捕获手动 `.mcp.json` 条目。plugin:* 必须在此处排除
    // —— 步骤 1 已经抑制了那些（zy.ai 获胜）；留下它们也会
    // 抑制连接器，两者都不存活（gh-39974）。
    const nonPluginConfigs = pickBy(regularMcpConfigs, (_, n) => !n.startsWith('plugin:'))
    const { servers: dedupedZyAI } = dedupZyAIMcpServers(zyaiConfigs, nonPluginConfigs)
    return connectMcpBatch(dedupedZyAI, 'zyai')
  })
  let zyaiTimer: ReturnType<typeof setTimeout> | undefined
  const zyaiTimedOut = await Promise.race([
    zyaiConnect.then(() => false),
    new Promise<boolean>((resolve) => {
      zyaiTimer = setTimeout((r) => r(true), ZY_AI_MCP_TIMEOUT_MS, resolve)
    }),
  ])
  if (zyaiTimer) {
    clearTimeout(zyaiTimer)
  }
  if (zyaiTimedOut) {
    logForDebugging(
      `[MCP] zy.ai connectors not ready after ${ZY_AI_MCP_TIMEOUT_MS}ms — proceeding; background connection continues`,
    )
  }
  profileCheckpoint('after_connectMcp_zyai')

  // 在无头模式下，立即启动延迟预取（没有用户输入延迟）
  // --bare / SIMPLE：startDeferredPrefetches 在内部早期返回。
  // backgroundHousekeeping（initExtractMemories、pruneShellSnapshots、
  // cleanupOldMessageFiles）是脚本化调用
  // 不需要的簿记 —— 下次交互会话将协调。
  if (!isBareMode()) {
    startDeferredPrefetches()
    void import('../../utils/backgroundHousekeeping.js').then((m) =>
      m.startBackgroundHousekeeping(),
    )
  }
  logSessionTelemetry()
  profileCheckpoint('before_print_import')
  const { runHeadless } = await import('src/cli/print.js')
  profileCheckpoint('after_print_import')
  void runHeadless(
    inputPrompt,
    () => headlessStore.getState(),
    headlessStore.setState,
    commandsHeadless,
    tools,
    sdkMcpConfigs,
    agentActiveAgents,
    {
      continue: options.continue,
      resume: options.resume,
      verbose: verbose,
      outputFormat: outputFormat,
      jsonSchema,
      permissionPromptToolName: options.permissionPromptTool,
      allowedTools,
      thinkingConfig,
      maxTurns: options.maxTurns,
      maxBudgetUsd: options.maxBudgetUsd,
      taskBudget: options.taskBudget
        ? {
            total: options.taskBudget,
          }
        : undefined,
      systemPrompt,
      appendSystemPrompt,
      userSpecifiedModel: effectiveModel,
      fallbackModel: userSpecifiedFallbackModel,
      teleport,
      sdkUrl,
      replayUserMessages: effectiveReplayUserMessages,
      includePartialMessages: effectiveIncludePartialMessages,
      forkSession: options.forkSession || false,
      resumeSessionAt: options.resumeSessionAt || undefined,
      rewindFiles: options.rewindFiles,
      enableAuthStatus: options.enableAuthStatus,
      agent: agentCli,
      workload: options.workload,
      setupTrigger: setupTrigger ?? undefined,
      sessionStartHooksPromise,
    },
  )
}
