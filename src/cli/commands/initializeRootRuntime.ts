/**
 * 根命令的 `.action` 处理器 —— 即交互式 REPL 启动主路径。
 *
 * 这一段约 3300 行的逻辑覆盖：bare 模式 / KAIROS 助手 / 工具栈装配 /
 * MCP 配置加载 / 插件初始化 / 权限解算 / 模型选择 / 会话恢复 / 远程
 * 会话（DIRECT_CONNECT、SSH_REMOTE、teleport）/ Plan 模式 / Coordinator
 * Mode / 队友 swarm / Bridge Mode / 最终 renderAndRun。
 *
 * 与 main.tsx 的耦合点：lazy modules（都走 cli/lazyModules.js）+ pending
 * 状态（cli/argvDispatch.js）。无 run() 局部变量捕获。
 */

import { feature } from 'bun:bundle'
import chalk from 'chalk'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { setAdditionalDirectoriesForAgentsMd } from 'src/bootstrap/runtime/runtimeContext.js'
import { maybeActivateProactive } from '../activate/proactive.js'
import { getInputPrompt } from '../bootstrap/inputPrompt.js'
import { getCommands } from '../../commands.js'
import { getSystemContext, getUserContext } from '../../services/context/context.js'
import { initBuiltinPlugins } from '../../services/plugins/builtinInitialization.js'
import {
  hasGrowthBookEnvOverride,
  initializeGrowthBook,
} from '../../services/analytics/growthbook.js'
import {
  CLAUDE_IN_CHROME_SKILL_HINT,
  CLAUDE_IN_CHROME_SKILL_HINT_WITH_WEBBROWSER,
} from '../../services/claude-in-chrome/prompt.js'
import { setupClaudeInChrome } from '../../services/claude-in-chrome/setup.js'
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'
import { getDefaultMainLoopModel } from '../../services/model/model.js'
import { ensureModelStringsInitialized } from '../../services/model/modelStrings.js'
import { initBundledSkills } from '../../skills/bundled/index.js'
import type { ToolInputJSONSchema } from '../../tools/Tool.js'
import {
  getActiveAgentsFromList,
  getAgentDefinitionsWithOverrides,
  parseAgentsFromJson,
} from '../../tools/AgentTool/loadAgentsDir.js'
import {
  createSyntheticOutputTool,
  isSyntheticOutputToolEnabled,
} from '../../tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { getTools, loadExternalTools } from '../../tools/tools.js'
import { assertMinVersion } from '../../utils/autoUpdater.js'
import { getGlobalConfig } from '../../services/config/config.js'
import { isBareMode, isEnvTruthy, isInternalBuild } from '../../utils/envUtils.js'
import { safeParseJSON } from '../../utils/json.js'
import { logError } from '../../utils/log.js'
import { applyConfigEnvironmentVariables } from '../../utils/managedEnv.js'
import {
  initializeToolPermissionContext,
  parseToolListFromCLI,
  removeDangerousPermissions,
  stripDangerousPermissionsForAutoMode,
} from '../../services/permissions/permissionSetup.js'
import { getPlatform } from '../../services/shell/platform.js'
import { cacheSessionTitle } from '../../services/sessionStorage.js'
import { getInitialSettings } from '../../services/settings/settings.js'
import { jsonParse } from '../../utils/slowOperations.js'
import { profileCheckpoint } from '../../utils/startupProfiler.js'
import { validateUuid } from '../../utils/uuid.js'
import {
  areMcpConfigsAllowedWithEnterpriseMcpConfig,
  doesEnterpriseMcpConfigExist,
  filterMcpServersByPolicy,
  getZyCodeMcpConfigs,
} from 'src/services/mcp/config.js'
import { fetchZyAIMcpConfigsIfEligible } from 'src/services/mcp/zyai.js'
import { getCwd } from 'src/utils/cwd.js'
import { logForDebugging } from 'src/utils/debug.js'
import { errorMessage } from 'src/utils/errors.js'
import { writeToStderr } from 'src/services/shell/process.js'
import { plural } from 'src/utils/stringUtils.js'
import type { ChannelEntry } from 'src/bootstrap/runtime/runtimeContext.js'
import {
  getIsNonInteractiveSession,
  setUserMsgOptIn,
} from 'src/bootstrap/runtime/runtimeContext.js'
import { setAllowedChannels } from 'src/bootstrap/runtime/runtimeContext.js'
import { prepareRootAction } from './prepareRootAction.js'
export async function initializeRootRuntime(
  context: Awaited<ReturnType<typeof prepareRootAction>>,
) {
  let {
    prompt,
    options,
    kairosEnabled,
    assistantTeamContext,
    debug,
    debugToStderr,
    dangerouslySkipPermissions,
    allowDangerouslySkipPermissions,
    baseTools,
    allowedTools,
    disallowedTools,
    mcpConfig,
    permissionModeCli,
    addDir,
    fallbackModel,
    betas,
    ide,
    sessionId,
    includeHookEvents,
    includePartialMessages,
    fileDownloadPromise,
    agentsJson,
    agentCli,
    outputFormat,
    inputFormat,
    verbose,
    print,
    init,
    initOnly,
    maintenance,
    disableSlashCommands,
    tasksOption,
    taskListId,
    worktreeOption,
    worktreeName,
    worktreeEnabled,
    worktreePRNumber,
    tmuxEnabled,
    storedTeammateOpts,
    sdkUrl,
    effectiveIncludePartialMessages,
    teleport,
    remoteOption,
    remote,
    remoteControlOption,
    remoteControl,
    remoteControlName,
    fileSpecs,
    isNonInteractiveSession,
    systemPrompt,
    appendSystemPrompt,
    permissionMode,
    permissionModeNotification,
    dynamicMcpConfig,
    enableClaudeInChrome,
    autoEnableClaudeInChrome,
  } = context

  if (enableClaudeInChrome) {
    const platform = getPlatform()
    try {
      logEvent('zy_Zy_in_chrome_setup', {
        platform: platform as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      const {
        mcpConfig: chromeMcpConfig,
        allowedTools: chromeMcpTools,
        systemPrompt: chromeSystemPrompt,
      } = setupClaudeInChrome()
      dynamicMcpConfig = {
        ...dynamicMcpConfig,
        ...chromeMcpConfig,
      }
      allowedTools.push(...chromeMcpTools)
      if (chromeSystemPrompt) {
        appendSystemPrompt = appendSystemPrompt
          ? `${chromeSystemPrompt}\n\n${appendSystemPrompt}`
          : chromeSystemPrompt
      }
    } catch (error) {
      logEvent('zy_Zy_in_chrome_setup_failed', {
        platform: platform as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      logForDebugging(`[Claude in Chrome] Error: ${error}`)
      logError(error)
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(`Error: Failed to run with ZY in Chrome.`)
      process.exit(1)
    }
  } else if (autoEnableClaudeInChrome) {
    try {
      const { mcpConfig: chromeMcpConfig } = setupClaudeInChrome()
      dynamicMcpConfig = {
        ...dynamicMcpConfig,
        ...chromeMcpConfig,
      }
      const hint = feature('WEB_BROWSER_TOOL')
        ? typeof Bun !== 'undefined' && 'WebView' in Bun
          ? CLAUDE_IN_CHROME_SKILL_HINT_WITH_WEBBROWSER
          : CLAUDE_IN_CHROME_SKILL_HINT
        : CLAUDE_IN_CHROME_SKILL_HINT
      appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${hint}` : hint
    } catch (error) {
      // 静默跳过自动启用的任何错误
      logForDebugging(`[Claude in Chrome] Error (auto-enable): ${error}`)
    }
  }

  // 提取严格的 MCP 配置标志
  const strictMcpConfig = options.strictMcpConfig || false

  // 检查是否存在企业 MCP 配置。当存在时，只允许包含特殊服务器类型（sdk）的动态 MCP
  // 配置
  if (doesEnterpriseMcpConfigExist()) {
    if (strictMcpConfig) {
      process.stderr.write(
        chalk.red('You cannot use --strict-mcp-config when an enterprise MCP config is present'),
      )
      process.exit(1)
    }

    // 对于 --mcp-config，如果所有服务器都是内部类型（sdk）则允许
    if (dynamicMcpConfig && !areMcpConfigsAllowedWithEnterpriseMcpConfig(dynamicMcpConfig)) {
      process.stderr.write(
        chalk.red(
          'You cannot dynamically configure MCP servers when an enterprise MCP config is present',
        ),
      )
      process.exit(1)
    }
  }

  // chicago MCP: guarded Computer Use (app allowlist + frontmost gate +
  // SCContentFilter screenshots). Ant-only, GrowthBook-gated — failures
  // are silent (this is dogfooding). Platform + interactive checks inline
  // so non-macOS / print-mode ants skip the heavy @ant/computer-use-mcp
  // import entirely. gates.js is light (type-only package import).
  //
  // Placed AFTER the enterprise-MCP-config check: that check rejects any
  // dynamicMcpConfig entry with `type !== 'sdk'`, and our config is
  // `type: 'stdio'`. An enterprise-config ant with the GB gate on would
  // otherwise process.exit(1). Chrome has the same latent issue but has
  // shipped without incident; chicago places itself correctly.
  if (feature('CHICAGO_MCP') ? getPlatform() === 'macos' && !getIsNonInteractiveSession() : false) {
    try {
      const { getChicagoEnabled } = await import('src/services/computer-use/gates.js')
      if (getChicagoEnabled()) {
        const { setupComputerUseMCP } = await import('src/services/computer-use/setup.js')
        const { mcpConfig, allowedTools: cuTools } = setupComputerUseMCP()
        dynamicMcpConfig = {
          ...dynamicMcpConfig,
          ...mcpConfig,
        }
        allowedTools.push(...cuTools)
      }
    } catch (error) {
      logForDebugging(`[Computer Use MCP] Setup failed: ${errorMessage(error)}`)
    }
  }

  // 存储额外目录用于 AGENTS.md 加载（由 env var 控制）
  setAdditionalDirectoriesForAgentsMd(addDir)

  // 来自 --channels 标志的通道服务器允许列表 —— 服务器 whose
  // 入站推送通知应注册此会话。选项
  // 在 feature() 块内添加，所以 TS 不知道它
  // 在选项类型上 —— 与 main.tsx:1824 处的 --assistant 相同模式。
  // devChannels 延迟：showSetupScreens 显示确认对话框
  // 并且只在接受时附加到 allowedChannels。
  let devChannels: ChannelEntry[] | undefined

  if (feature('KAIROS') || feature('KAIROS_CHANNELS')) {
    // Parse plugin:name@marketplace / server:Y tags into typed entries.
    // Tag 决定下游信任模型：plugin-kind 命中市场
    // 验证 + GrowthBook 允许列表，server-kind 总是失败
    // 允许列表（schema 仅适用于插件），除非设置了 dev 标志。
    // 未标记或没有 marketpalce 的插件条目是硬错误 ——
    // 在门中静默不匹配看起来像通道
    // "开启" 但什么都不触发。
    const parseChannelEntries = (raw: string[], flag: string): ChannelEntry[] => {
      const entries: ChannelEntry[] = []
      const bad: string[] = []
      for (const c of raw) {
        if (c.startsWith('plugin:')) {
          const rest = c.slice(7)
          const at = rest.indexOf('@')
          if (at <= 0 || at === rest.length - 1) {
            bad.push(c)
          } else {
            entries.push({
              kind: 'plugin',
              name: rest.slice(0, at),
              marketplace: rest.slice(at + 1),
            })
          }
        } else if (c.startsWith('server:') && c.length > 7) {
          entries.push({
            kind: 'server',
            name: c.slice(7),
          })
        } else {
          bad.push(c)
        }
      }
      if (bad.length > 0) {
        process.stderr.write(
          chalk.red(
            `${flag} entries must be tagged: ${bad.join(', ')}\n` +
              `  plugin:<name>@<marketplace>  — plugin-provided channel (allowlist enforced)\n` +
              `  server:<name>                — manually configured MCP server\n`,
          ),
        )
        process.exit(1)
      }
      return entries
    }
    const rawChannels = options.channels
    const rawDev = options.dangerouslyLoadDevelopmentChannels
    // 始终解析 + 设置。ChannelsNotice 读取 getAllowedChannels() 并
    // 在启动屏幕中渲染适当的分支（disabled/noAuth/policyBlocked/
    // listening）。gateChannelServer() 强制执行。
    // --channels 在交互和打印/SDK 模式中都有效；dev-channels
    // 保持仅限交互模式（需要确认对话框）。
    let channelEntries: ChannelEntry[] = []
    if (rawChannels && rawChannels.length > 0) {
      channelEntries = parseChannelEntries(rawChannels, '--channels')
      setAllowedChannels(channelEntries)
    }
    if (!isNonInteractiveSession) {
      if (rawDev && rawDev.length > 0) {
        devChannels = parseChannelEntries(rawDev, '--dangerously-load-development-channels')
      }
    }
    // 标志使用遥测。记录插件标识符（与
    // zy_plugin_installed 相同层级 —— 公共注册表式名称）；server-kind
    // 不记录（MCP 服务器名称层级，仅在其他地方选择加入）。
    // 每个服务器的门结果进入 zy_mcp_channel_gate 一旦
    // 服务器连接。dev 条目经过确认对话框后
    // —— dev_plugins 捕获输入的内容，而不是接受的内容。
    if (channelEntries.length > 0 || (devChannels?.length ?? 0) > 0) {
      const joinPluginIds = (entries: ChannelEntry[]) => {
        const ids = entries.flatMap((e) =>
          e.kind === 'plugin' ? [`${e.name}@${e.marketplace}`] : [],
        )
        return ids.length > 0
          ? (ids.sort().join(',') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
          : undefined
      }
      logEvent('zy_mcp_channel_flags', {
        channels_count: channelEntries.length,
        dev_count: devChannels?.length ?? 0,
        plugins: joinPluginIds(channelEntries),
        dev_plugins: joinPluginIds(devChannels ?? []),
      })
    }
  }

  // SDK 通过 --tools 选择启用 SendUserMessage。所有会话都需要
  // 明确选择；在 --tools 中列出它表示意图。运行在
  // initializeToolPermissionContext 之前，以便 getToolsForDefaultPreset() 在计算基础工具不允许过滤器时
  // 看到该工具已启用。
  // 条件导入避免将工具名称字符串泄漏到
  // 外部构建中。
  if ((feature('KAIROS') || feature('KAIROS_BRIEF')) && baseTools.length > 0) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { BRIEF_TOOL_NAME, LEGACY_BRIEF_TOOL_NAME } =
      require('../../tools/BriefTool/prompt.js') as typeof import('../../tools/BriefTool/prompt.js')
    const { isBriefEntitled } =
      require('../../tools/BriefTool/BriefTool.js') as typeof import('../../tools/BriefTool/BriefTool.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    const parsed = parseToolListFromCLI(baseTools)
    if (
      (parsed.includes(BRIEF_TOOL_NAME) || parsed.includes(LEGACY_BRIEF_TOOL_NAME)) &&
      isBriefEntitled()
    ) {
      setUserMsgOptIn(true)
    }
  }

  // 此 await 替换了启动路径中已有的阻塞 existsSync/statSync 调用。
  // 挂钟时间不变；我们只是在 fs I/O 期间让出事件循环
  // 而不是阻塞它。参见 #19661。
  const initResult = await initializeToolPermissionContext({
    allowedToolsCli: allowedTools,
    disallowedToolsCli: disallowedTools,
    baseToolsCli: baseTools,
    permissionMode,
    allowDangerouslySkipPermissions,
    addDirs: addDir,
  })

  let toolPermissionContext = initResult.toolPermissionContext

  const { warnings, dangerousPermissions, overlyBroadBashPermissions } = initResult

  // 为 ant 用户处理过于宽泛的 shell 允许规则（Bash(*)、PowerShell(*)）
  if (isInternalBuild() && overlyBroadBashPermissions.length > 0) {
    for (const permission of overlyBroadBashPermissions) {
      logForDebugging(
        `Ignoring overly broad shell permission ${permission.ruleDisplay} from ${permission.sourceDisplay}`,
      )
    }
    toolPermissionContext = removeDangerousPermissions(
      toolPermissionContext,
      overlyBroadBashPermissions,
    )
  }

  if (dangerousPermissions.length > 0) {
    toolPermissionContext = stripDangerousPermissionsForAutoMode(toolPermissionContext)
  }

  // 打印初始化中的任何警告
  warnings.forEach((warning) => {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(warning)
  })

  void assertMinVersion()

  // zy.ai 配置获取：仅 -p 模式（交互使用 useManageMCPConnections
  // 两阶段加载）。在这里启动以便与 setup() 重叠；在
  // runHeadless 之前等待，以便单次 -p 看到连接器。在
  // 企业/严格 MCP 下跳过以保留策略边界。
  const zyaiConfigPromise: Promise<Record<string, ScopedMcpServerConfig>> =
    isNonInteractiveSession &&
    !strictMcpConfig &&
    !doesEnterpriseMcpConfigExist() &&
    // --bare / SIMPLE：跳过 zy.ai 代理服务器（datadog、Gmail、
    // Slack、BigQuery、PubMed —— 每个连接 6-14 秒）。需要 MCP 的脚本化调用
    // 显式传递 --mcp-config。
    !isBareMode()
      ? fetchZyAIMcpConfigsIfEligible().then((configs) => {
          const { allowed, blocked } = filterMcpServersByPolicy(configs)
          if (blocked.length > 0) {
            process.stderr.write(
              `Warning: zy.ai MCP ${plural(blocked.length, 'server')} blocked by enterprise policy: ${blocked.join(', ')}\n`,
            )
          }
          return allowed
        })
      : Promise.resolve({})

  // 早期启动 MCP 配置加载（安全 —— 仅读取文件，不执行）。
  // 交互和 -p 都使用 getZyCodeMcpConfigs（仅本地文件读取）。
  // 本地 promise 稍后等待（在 prefetchAllMcpResources 之前）以便
  // 与 setup()、命令加载和信任对话框重叠配置 I/O。
  logForDebugging('[STARTUP] Loading MCP configs...')

  const mcpConfigStart = Date.now()

  let mcpConfigResolvedMs: number | undefined

  // --bare 跳过自动发现的 MCP（.mcp.json、用户设置、插件）——
  // 只有显式的 --mcp-config 有效。dynamicMcpConfig 在下游
  // 扩展到 allMcpConfigs 上，所以它在此跳过后仍然存在。
  const mcpConfigPromise = (
    strictMcpConfig || isBareMode()
      ? Promise.resolve({
          servers: {} as Record<string, ScopedMcpServerConfig>,
        })
      : getZyCodeMcpConfigs(dynamicMcpConfig)
  ).then((result) => {
    mcpConfigResolvedMs = Date.now() - mcpConfigStart
    return result
  })

  // NOTE: We do NOT call prefetchAllMcpResources here - that's deferred until after trust dialog

  if (inputFormat && inputFormat !== 'text' && inputFormat !== 'stream-json') {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(`Error: Invalid input format "${inputFormat}".`)
    process.exit(1)
  }

  if (inputFormat === 'stream-json' && outputFormat !== 'stream-json') {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(`Error: --input-format=stream-json requires output-format=stream-json.`)
    process.exit(1)
  }

  // 验证 sdkUrl 仅与适当的格式一起使用（格式在上面自动设置）
  if (sdkUrl) {
    if (inputFormat !== 'stream-json' || outputFormat !== 'stream-json') {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(
        `Error: --sdk-url requires both --input-format=stream-json and --output-format=stream-json.`,
      )
      process.exit(1)
    }
  }

  // 验证 replayUserMessages 仅与 stream-json 格式一起使用
  if (options.replayUserMessages) {
    if (inputFormat !== 'stream-json' || outputFormat !== 'stream-json') {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(
        `Error: --replay-user-messages requires both --input-format=stream-json and --output-format=stream-json.`,
      )
      process.exit(1)
    }
  }

  // 验证 includePartialMessages 仅与打印模式和 stream-json 输出一起使用
  if (effectiveIncludePartialMessages) {
    if (!isNonInteractiveSession || outputFormat !== 'stream-json') {
      writeToStderr(
        `Error: --include-partial-messages requires --print and --output-format=stream-json.`,
      )
      process.exit(1)
    }
  }

  // 验证 --no-session-persistence 仅与打印模式一起使用
  if (options.sessionPersistence === false && !isNonInteractiveSession) {
    writeToStderr(`Error: --no-session-persistence can only be used with --print mode.`)
    process.exit(1)
  }

  const effectivePrompt = prompt || ''

  const inputPrompt = await getInputPrompt(
    effectivePrompt,
    (inputFormat ?? 'text') as 'text' | 'stream-json',
  )

  profileCheckpoint('action_after_input_prompt')

  // 在 getTools() 之前激活主动模式，以便 SleepTool.isEnabled()
  //（返回 isProactiveActive()）通过并包含 Sleep。
  // 稍后 REPL 路径的 maybeActivateProactive() 调用是幂等的。
  maybeActivateProactive(options)

  await loadExternalTools()

  let tools = getTools(toolPermissionContext)

  // 为无头路径应用协调器模式工具过滤
  //（镜像 useMergedTools.ts 对 REPL/交互路径的过滤）
  if (feature('COORDINATOR_MODE') ? isEnvTruthy(process.env.ZY_CODE_COORDINATOR_MODE) : false) {
    const { applyCoordinatorToolFilter } = await import('../../utils/toolPool.js')
    tools = applyCoordinatorToolFilter(tools)
  }

  profileCheckpoint('action_tools_loaded')

  let jsonSchema: ToolInputJSONSchema | undefined

  if (
    isSyntheticOutputToolEnabled({
      isNonInteractiveSession,
    }) &&
    options.jsonSchema
  ) {
    jsonSchema = jsonParse(options.jsonSchema) as ToolInputJSONSchema
  }

  if (jsonSchema) {
    const syntheticOutputResult = createSyntheticOutputTool(jsonSchema)
    if ('tool' in syntheticOutputResult) {
      // 在 getTools() 过滤之后将 SyntheticOutputTool 添加到工具数组。
      // 此工具从正常过滤中排除（参见 tools.ts），因为它是
      // 结构化输出的实现细节，不是用户控制的工具。
      tools = [...tools, syntheticOutputResult.tool]
      logEvent('zy_structured_output_enabled', {
        schema_property_count: Object.keys((jsonSchema.properties as Record<string, unknown>) || {})
          .length as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        has_required_fields: Boolean(
          jsonSchema.required,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    } else {
      logEvent('zy_structured_output_failure', {
        error: 'Invalid JSON schema' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
  }

  // 重要：setup() 必须在任何其他依赖 cwd 或 worktree 设置的代码之前调用

  profileCheckpoint('action_before_setup')

  logForDebugging('[STARTUP] Running setup()...')

  const setupStart = Date.now()

  const { setup } = await import('../../bootstrap/setup.js')

  const messagingSocketPath = feature('UDS_INBOX') ? options.messagingSocketPath : undefined

  // 并行化 setup() 与命令+代理加载。setup() 的约 28ms 主要是
  // startUdsMessaging（socket 绑定，约 20ms）—— 不是磁盘绑定的，所以它
  // 不与 getCommands 的文件读取竞争。在 !worktreeEnabled 门控，
  // 因为 --worktree 使 setup() 执行 process.chdir()（setup.ts:203），
  // 而命令/代理需要 post-chdir 的 cwd。
  const preSetupCwd = getCwd()

  // 在启动 getCommands() 之前注册捆绑的技能/插件 —— 它们是
  // 纯内存数组推送（<1ms，零 I/O），getBundledSkills()
  // 同步读取。之前在 setup() 中运行，在约 20ms 的
  // await 点之后，所以并行的 getCommands() 缓存了一个空列表。
  if (process.env.ZY_CODE_ENTRYPOINT !== 'local-agent') {
    initBuiltinPlugins()
    initBundledSkills()
  }

  const setupPromise = setup(
    preSetupCwd,
    permissionMode,
    allowDangerouslySkipPermissions,
    worktreeEnabled,
    worktreeName,
    tmuxEnabled,
    sessionId ? validateUuid(sessionId) : undefined,
    worktreePRNumber,
    messagingSocketPath,
  )

  const commandsPromise = worktreeEnabled ? null : getCommands(preSetupCwd)

  const agentDefsPromise = worktreeEnabled ? null : getAgentDefinitionsWithOverrides(preSetupCwd)

  // 如果这些在下方约 28ms setupPromise await 期间拒绝，
  // 在 Promise.all 连接它们之前抑制瞬态 unhandledRejection。
  commandsPromise?.catch(() => {})

  agentDefsPromise?.catch(() => {})

  await setupPromise

  logForDebugging(`[STARTUP] setup() completed in ${Date.now() - setupStart}ms`)

  profileCheckpoint('action_after_setup')

  // 仅在显式请求 socket 时才将用户消息重放到 stream-json。
  // 自动生成的 socket 是被动的 —— 它让工具在想要时注入，
  // 但默认开启会为从未使用它的 SDK 消费者重塑 stream-json。
  // 注入并希望在流中看到这些注入的调用者
  // 显式传递 --messaging-socket-path（或 --replay-user-messages）。
  let effectiveReplayUserMessages = !!options.replayUserMessages

  if (feature('UDS_INBOX')) {
    if (!effectiveReplayUserMessages && outputFormat === 'stream-json') {
      effectiveReplayUserMessages = !!options.messagingSocketPath
    }
  }

  if (getIsNonInteractiveSession()) {
    // 现在应用完全合并的设置 env（包括项目范围的
    // .zy/settings.json PATH/GIT_DIR/GIT_WORK_TREE）以便 gitExe() 和
    // 下方的 git 生成看到它。信任在 -p 模式中是隐式的；
    // managedEnv.ts:96-97 的文档字符串说这应用了"潜在的
    // 危险环境变量如 LD_PRELOAD、PATH"来自所有
    // 来源。下方 isNonInteractiveSession 块中的后续调用
    // 是幂等的（Object.assign，configureGlobalAgents 弹出先前的
    // 拦截器）并选择插件贡献的 env 在插件
    // 初始化之后。项目设置已经在此加载：
    // init() 中的 applySafeConfigEnvironmentVariables 调用了
    // managedEnv.ts:86 的 getInitialSettings，它合并了所有启用的
    // 源，包括 projectSettings/localSettings。
    applyConfigEnvironmentVariables()

    // 现在生成 git status/log/branch 子进程，以便子进程执行与
    // 下方的 getCommands await 和 startDeferredPrefetches 重叠。在
    // setup() 之后，以便 cwd 是最终的（setup.ts:254 对于 --worktree 可能
    // process.chdir(worktreePath)），并在上面的 applyConfigEnvironmentVariables
    // 之后以便应用所有来源的 PATH/GIT_DIR/GIT_WORK_TREE（受信任 + 项目）。
    // getSystemContext 是缓存的；startDeferredPrefetches 中的
    // prefetchSystemContextIfSafe 调用变成缓存命中。await getIsGit()
    // 的微任务在 getCommands Promise.all await 下方排空。
    // 信任在 -p 模式中是隐式的（与 prefetchSystemContextIfSafe 相同的门控）。
    void getSystemContext()
    // 现在也启动 getUserContext —— 它的首次 await（getMemoryFiles
    // 中的 fs.readFile）自然让出，所以 AGENTS.md 目录遍历
    // 在 context Promise.all 连接之前约 280ms 的重叠窗口中运行。
    // startDeferredPrefetches 中的 void getUserContext() 变成缓存命中。
    void getUserContext()
    // 现在启动 ensureModelStringsInitialized —— 对于 Bedrock 这会触发
    // 100-200ms 的配置获取，之前在 print.ts:739 串行等待。
    // updateBedrockModelStrings 是 sequential() 包装的，所以
    // await 连接进行中的获取。非 Bedrock 是同步
    // 提前返回（零成本）。
    void ensureModelStringsInitialized()
  }

  // 应用 --name：仅缓存，以便在
  // 会话 ID 最终通过 --continue/--resume 确定之前不创建孤立文件。
  // materializeSessionFile 在首次用户消息时持久化它；
  // REPL 的 useTerminalTitle 通过 getCurrentSessionTitle 读取它。
  const sessionNameArg = options.name?.trim()

  if (sessionNameArg) {
    cacheSessionTitle(sessionNameArg)
  }

  // Ant 模型别名（capybara-fast 等）通过
  // zy_ant_model_override GrowthBook 标志解析。_CACHED_MAY_BE_STALE
  // 同步读取磁盘；磁盘由 fire-and-forget 写入填充。在
  // 冷缓存上，parseUserSpecifiedModel 返回未解析的别名，
  // API 404，并且 -p 在异步写入落地之前退出 —— 新鲜 pod 上崩溃循环。
  // 在此等待 init 填充 _CACHED_MAY_BE_STALE 现在首先检查的内存负载映射。
  // 门控以便温暖路径保持非阻塞：
  //  - 通过 --model 或 ZY_CODE_MODEL 显式指定模型（两者都馈入别名解析）
  //  - 没有 env 覆盖（它在磁盘之前在 _CACHED_MAY_BE_STALE 之前短路）
  //  - 标志在磁盘上不存在（== null 也捕获 pre-#22279 中毒的 null）
  const explicitModel = options.model || process.env.ZY_CODE_MODEL

  if (
    isInternalBuild() &&
    explicitModel &&
    explicitModel !== 'default' &&
    !hasGrowthBookEnvOverride('zy_ant_model_override') &&
    getGlobalConfig().cachedGrowthBookFeatures?.zy_ant_model_override == null
  ) {
    await initializeGrowthBook()
  }

  // 用 null 关键字特殊处理默认模型
  // NOTE: Model resolution happens after setup() to ensure trust is established before AWS auth
  const userSpecifiedModel = options.model === 'default' ? getDefaultMainLoopModel() : options.model

  const userSpecifiedFallbackModel =
    fallbackModel === 'default' ? getDefaultMainLoopModel() : fallbackModel

  // 重用 preSetupCwd，除非 setup() chdir'd（worktreeEnabled）。
  // 在常见路径中节省一个 getCwd() 系统调用。
  const currentCwd = worktreeEnabled ? getCwd() : preSetupCwd

  logForDebugging('[STARTUP] Loading commands and agents...')

  const commandsStart = Date.now()

  // 连接在 setup() 之前启动的 promises（或者如果
  // worktreeEnabled 门控了早期启动则重新开始）。两者都按 cwd 缓存。
  const [commands, agentDefinitionsResult] = await Promise.all([
    commandsPromise ?? getCommands(currentCwd),
    agentDefsPromise ?? getAgentDefinitionsWithOverrides(currentCwd),
  ])

  logForDebugging(`[STARTUP] Commands and agents loaded in ${Date.now() - commandsStart}ms`)

  profileCheckpoint('action_commands_loaded')

  // 如果通过 --agents 标志提供了 CLI 代理，则解析它们
  let cliAgents: typeof agentDefinitionsResult.activeAgents = []

  if (agentsJson) {
    try {
      const parsedAgents = safeParseJSON(agentsJson)
      if (parsedAgents) {
        cliAgents = parseAgentsFromJson(parsedAgents, 'flagSettings')
      }
    } catch (error) {
      logError(error)
    }
  }

  // 将 CLI 代理与现有的合并
  const allAgents = [...agentDefinitionsResult.allAgents, ...cliAgents]

  const agentDefinitions = {
    ...agentDefinitionsResult,
    allAgents,
    activeAgents: getActiveAgentsFromList(allAgents),
  }

  // 从 CLI 标志或设置查找主线程代理
  const agentSetting = agentCli ?? getInitialSettings().agent

  let mainThreadAgentDefinition: (typeof agentDefinitions.activeAgents)[number] | undefined
  return {
    ...context,
    strictMcpConfig,
    devChannels,
    initResult,
    toolPermissionContext,
    warnings,
    dangerousPermissions,
    overlyBroadBashPermissions,
    zyaiConfigPromise,
    mcpConfigStart,
    mcpConfigResolvedMs,
    mcpConfigPromise,
    effectivePrompt,
    inputPrompt,
    tools,
    jsonSchema,
    setupStart,
    setup,
    messagingSocketPath,
    preSetupCwd,
    setupPromise,
    commandsPromise,
    agentDefsPromise,
    effectiveReplayUserMessages,
    sessionNameArg,
    explicitModel,
    userSpecifiedModel,
    userSpecifiedFallbackModel,
    currentCwd,
    commandsStart,
    commands,
    agentDefinitionsResult,
    cliAgents,
    allAgents,
    agentDefinitions,
    agentSetting,
    mainThreadAgentDefinition,
  }
}
