// 这些副作用必须在所有其他导入之前运行：
// 1. profileCheckpoint 在重型模块评估开始前标记入口
// 2. startMdmRawRead 触发 MDM 子进程（plutil/reg query），使其与下方
//    剩余约 135ms 的导入并行运行
// 3. startKeychainPrefetch 并行触发两个 macOS keychain 读取（OAuth + 旧版 API
//    密钥）—— 否则 isRemoteManagedSettingsEligible() 会在 applySafeConfigEnvironmentVariables()
//    内部通过同步 spawn 顺序读取它们（每次 macOS 启动约 65ms）
import { profileCheckpoint, profileReport } from './utils/startupProfiler.js'

// eslint-disable-next-line custom-rules/no-top-level-side-effects
profileCheckpoint('main_tsx_entry')
import { startMdmRawRead } from './utils/settings/mdm/rawRead.js'

// eslint-disable-next-line custom-rules/no-top-level-side-effects
startMdmRawRead()
import {
  ensureKeychainPrefetchCompleted,
  startKeychainPrefetch,
} from './utils/secureStorage/keychainPrefetch.js'

// eslint-disable-next-line custom-rules/no-top-level-side-effects
startKeychainPrefetch()
import { feature } from 'bun:bundle'
import {
  Command as CommanderCommand,
  InvalidArgumentError,
  Option,
} from '@commander-js/extra-typings'
import chalk from 'chalk'
import { readFileSync } from 'fs'
import mapValues from 'lodash-es/mapValues.js'
import pickBy from 'lodash-es/pickBy.js'
import uniqBy from 'lodash-es/uniqBy.js'
import React from 'react'
import { getOauthConfig } from './constants/oauth.js'
import { getRemoteSessionUrl } from './constants/product.js'
import { getSystemContext, getUserContext } from './context.js'
import { init, initializeTelemetryAfterTrust } from './entrypoints/init.js'
import { addToHistory } from './history.js'
import type { Root } from './ink.js'
import { launchRepl } from './replLauncher.js'
import {
  hasGrowthBookEnvOverride,
  initializeGrowthBook,
  refreshGrowthBookAfterAuthChange,
} from './services/analytics/growthbook.js'
import { fetchBootstrapData } from './services/api/bootstrap.js'
import {
  type DownloadResult,
  downloadSessionFiles,
  type FilesApiConfig,
  parseFileSpecs,
} from './services/api/filesApi.js'
import { warmI18n } from './i18n/index.js'
import { prefetchOfficialMcpUrls } from './services/mcp/officialRegistry.js'
import type {
  McpSdkServerConfig,
  McpServerConfig,
  ScopedMcpServerConfig,
} from './services/mcp/types.js'
import {
  isPolicyAllowed,
  loadPolicyLimits,
  refreshPolicyLimits,
  waitForPolicyLimitsToLoad,
} from './services/policyLimits/index.js'
import {
  loadRemoteManagedSettings,
  refreshRemoteManagedSettings,
} from './services/remoteManagedSettings/index.js'
import type { ToolInputJSONSchema } from './Tool.js'
import {
  createSyntheticOutputTool,
  isSyntheticOutputToolEnabled,
} from './tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { getTools } from './tools.js'
import {
  canUserConfigureAdvisor,
  getInitialAdvisorSetting,
  isAdvisorEnabled,
  isValidAdvisorModel,
  modelSupportsAdvisor,
} from './utils/advisor.js'
import { isAgentSwarmsEnabled } from './utils/agentSwarmsEnabled.js'
import { count, uniq } from './utils/array.js'
import { installAsciicastRecorder } from './utils/asciicast.js'
import { validateForceLoginOrg } from './utils/auth.js'
import {
  checkHasTrustDialogAccepted,
  getGlobalConfig,
  getRemoteControlAtStartup,
  isAutoUpdaterDisabled,
  saveGlobalConfig,
} from './utils/config.js'
import { seedEarlyInput, stopCapturingEarlyInput } from './utils/earlyInput.js'
import { getInitialEffortSetting, parseEffortValue } from './utils/effort.js'
import { applyConfigEnvironmentVariables } from './utils/managedEnv.js'
import { createSystemMessage, createUserMessage } from './utils/messages.js'
import { getPlatform } from './utils/platform.js'
import { getBaseRenderOptions } from './utils/renderOptions.js'
import { getSessionIngressAuthToken } from './utils/sessionIngressAuth.js'
import { settingsChangeDetector } from './utils/settings/changeDetector.js'
import { skillChangeDetector } from './utils/skills/skillChangeDetector.js'
import { jsonParse, writeFileSync_DEPRECATED } from './utils/slowOperations.js'
import { computeInitialTeamContext } from './utils/swarm/reconnection.js'
import { initializeWarningHandler } from './utils/warningHandler.js'
import { isInternalBuild } from './utils/envUtils.js'
import { isWorktreeModeEnabled } from './utils/worktreeModeEnabled.js'

// 延迟加载以避免循环依赖：teammate.ts -> AppState.tsx -> ... -> main.tsx
/* eslint-disable @typescript-eslint/no-require-imports */
const getTeammateUtils = () =>
  require('./utils/teammate.js') as typeof import('./utils/teammate.js')
const getTeammatePromptAddendum = () =>
  require('./utils/swarm/teammatePromptAddendum.js') as typeof import('./utils/swarm/teammatePromptAddendum.js')
const getTeammateModeSnapshot = () =>
  require('./utils/swarm/backends/teammateModeSnapshot.js') as typeof import('./utils/swarm/backends/teammateModeSnapshot.js')
/* eslint-enable @typescript-eslint/no-require-imports */
// 死代码消除：COORDINATOR_MODE 的条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? (require('./coordinator/coordinatorMode.js') as typeof import('./coordinator/coordinatorMode.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
// 死代码消除：KAIROS（助手模式）的条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
const assistantModule = feature('KAIROS')
  ? (require('./assistant/index.js') as typeof import('./assistant/index.js'))
  : null

// 辅助函数：在 KAIROS 已守卫的代码块中安全获取 assistant 模块
function getAssistant() {
  return assistantModule!
}
const kairosGate = feature('KAIROS')
  ? (require('./assistant/gate.js') as typeof import('./assistant/gate.js'))
  : null
import { relative, resolve } from 'path'
import { isAnalyticsDisabled } from 'src/services/analytics/config.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { initializeAnalyticsGates } from 'src/services/analytics/sink.js'
import {
  getOriginalCwd,
  setAdditionalDirectoriesForzyMd,
  setIsRemoteMode,
  setMainLoopModelOverride,
  setMainThreadAgentType,
  setTeleportedSessionInfo,
} from './bootstrap/state.js'
import { filterCommandsForRemoteMode, getCommands } from './commands.js'
import type { StatsStore } from './context/stats.js'
import {
  launchAssistantInstallWizard,
  launchAssistantSessionChooser,
  launchInvalidSettingsDialog,
  launchResumeChooser,
  launchSnapshotUpdateDialog,
  launchTeleportRepoMismatchDialog,
  launchTeleportResumeWrapper,
} from './dialogLaunchers.js'
import { SHOW_CURSOR } from './ink/termio/dec.js'
import {
  exitWithError,
  exitWithMessage,
  getRenderContext,
  renderAndRun,
  showSetupScreens,
} from './interactiveHelpers.js'
import { initBuiltinPlugins } from './plugins/bundled/index.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import { checkQuotaStatus } from './services/zyAiLimits.js'
import { getMcpToolsCommandsAndResources, prefetchAllMcpResources } from './services/mcp/client.js'
import {
  VALID_INSTALLABLE_SCOPES,
  VALID_UPDATE_SCOPES,
} from './services/plugins/pluginCliCommands.js'
import { initBundledSkills } from './skills/bundled/index.js'
import type { AgentColorName } from './tools/AgentTool/agentColorManager.js'
import {
  getActiveAgentsFromList,
  getAgentDefinitionsWithOverrides,
  isBuiltInAgent,
  isCustomAgent,
  parseAgentsFromJson,
} from './tools/AgentTool/loadAgentsDir.js'
import type { LogOption } from './types/logs.js'
import type { Message as MessageType } from './types/message.js'
import { assertMinVersion } from './utils/autoUpdater.js'
// @ts-ignore
import {
  CLAUDE_IN_CHROME_SKILL_HINT,
  CLAUDE_IN_CHROME_SKILL_HINT_WITH_WEBBROWSER,
} from './utils/claudeInChrome/prompt.js'
// @ts-ignore
import {
  setupClaudeInChrome,
  shouldAutoEnableClaudeInChrome,
  shouldEnableClaudeInChrome,
} from './utils/claudeInChrome/setup.js'
import { getContextWindowForModel } from './utils/context.js'
import { loadConversationForResume } from './utils/conversationRecovery.js'
import { buildDeepLinkBanner } from './utils/deepLink/banner.js'
import { hasNodeOption, isBareMode, isEnvTruthy, isInProtectedNamespace } from './utils/envUtils.js'
import { refreshExampleCommands } from './utils/exampleCommands.js'
import type { FpsMetrics } from './utils/fpsTracker.js'
import { getWorktreePaths } from './utils/getWorktreePaths.js'
import { findGitRoot, getBranch, getIsGit, getWorktreeCount } from './utils/git.js'
import { getGhAuthStatus } from './utils/github/ghAuthStatus.js'
import { safeParseJSON } from './utils/json.js'
import { logError } from './utils/log.js'
import {
  getDefaultMainLoopModel,
  getDefaultMainLoopModelSetting,
  getUserSpecifiedModelSetting,
  normalizeModelStringForAPI,
  parseUserSpecifiedModel,
  type ModelSetting,
} from './utils/model/model.js'
import { ensureModelStringsInitialized } from './utils/model/modelStrings.js'
import { PERMISSION_MODES } from './utils/permissions/PermissionMode.js'
import {
  checkAndDisableBypassPermissions,
  getAutoModeEnabledStateIfCached,
  initializeToolPermissionContext,
  initialPermissionModeFromCLI,
  isDefaultPermissionModeAuto,
  parseToolListFromCLI,
  removeDangerousPermissions,
  stripDangerousPermissionsForAutoMode,
  verifyAutoModeGateAccess,
} from './utils/permissions/permissionSetup.js'
import { cleanupOrphanedPluginVersionsInBackground } from './utils/plugins/cacheUtils.js'
import { initializeVersionedPlugins } from './utils/plugins/installedPluginsManager.js'
import { getManagedPluginNames } from './utils/plugins/managedPlugins.js'
import { getGlobExclusionsForPluginCache } from './utils/plugins/orphanedPluginFilter.js'
import { getPluginSeedDirs } from './utils/plugins/pluginDirectories.js'
import { countFilesRoundedRg } from './utils/ripgrep.js'
import { processSessionStartHooks, processSetupHooks } from './utils/sessionStart.js'
import {
  cacheSessionTitle,
  getSessionIdFromLog,
  loadTranscriptFromFile,
  saveAgentSetting,
  saveMode,
  searchSessionsByCustomTitle,
  sessionIdExists,
} from './utils/sessionStorage.js'
import { ensureMdmSettingsLoaded } from './utils/settings/mdm/settings.js'
import {
  getInitialSettings,
  getManagedSettingsKeysForLogging,
  getSettingsForSource,
  getSettingsWithErrors,
} from './utils/settings/settings.js'
import { resetSettingsCache } from './utils/settings/settingsCache.js'
import type { ValidationError } from './utils/settings/validation.js'
import { DEFAULT_TASKS_MODE_TASK_LIST_ID, TASK_STATUSES } from './utils/tasks.js'
import {
  logPluginLoadErrors,
  logPluginsEnabledForSession,
} from './utils/telemetry/pluginTelemetry.js'
import { logSkillsLoaded } from './utils/telemetry/skillLoadedEvent.js'
import { generateTempFilePath } from './utils/tempfile.js'
import { validateUuid } from './utils/uuid.js'
// 插件启动检查现在在 REPL.tsx 中以非阻塞方式处理

import { registerMcpAddCommand } from 'src/commands/mcp/addCommand.js'
import { registerMcpXaaIdpCommand } from 'src/commands/mcp/xaaIdpCommand.js'
import { logPermissionContextForAnts } from 'src/services/internalLogging.js'
import { fetchZyAIMcpConfigsIfEligible } from 'src/services/mcp/zyai.js'
import { clearServerCache } from 'src/services/mcp/client.js'
import {
  areMcpConfigsAllowedWithEnterpriseMcpConfig,
  dedupZyAIMcpServers,
  doesEnterpriseMcpConfigExist,
  filterMcpServersByPolicy,
  getZyCodeMcpConfigs,
  getMcpServerSignature,
  parseMcpConfig,
  parseMcpConfigFromFilePath,
} from 'src/services/mcp/config.js'
import { excludeCommandsByServer, excludeResourcesByServer } from 'src/services/mcp/utils.js'
import { isXaaEnabled } from 'src/services/mcp/xaaIdpLogin.js'
import { getRelevantTips } from 'src/services/tips/tipRegistry.js'
import { logContextMetrics } from 'src/utils/api.js'
// @ts-ignore
import {
  CLAUDE_IN_CHROME_MCP_SERVER_NAME,
  isClaudeInChromeMCPServer,
} from 'src/utils/claudeInChrome/common.js'
import { registerCleanup } from 'src/utils/cleanupRegistry.js'
import { eagerParseCliFlag } from 'src/utils/cliArgs.js'
import { createEmptyAttributionState } from 'src/utils/commitAttribution.js'
import {
  countConcurrentSessions,
  registerSession,
  updateSessionName,
} from 'src/utils/concurrentSessions.js'
import { getCwd } from 'src/utils/cwd.js'
import { logForDebugging, setHasFormattedOutput } from 'src/utils/debug.js'
import {
  errorMessage,
  getErrnoCode,
  isENOENT,
  TeleportOperationError,
  toError,
} from 'src/utils/errors.js'
import { getFsImplementation, safeResolvePath } from 'src/utils/fsOperations.js'
import { gracefulShutdown, gracefulShutdownSync } from 'src/utils/gracefulShutdown.js'
import { setAllHookEventsEnabled } from 'src/utils/hooks/hookEvents.js'
import { refreshModelCapabilities } from 'src/utils/model/modelCapabilities.js'
import { peekForStdinData, writeToStderr } from 'src/utils/process.js'
import { setCwd } from 'src/utils/Shell.js'
import { type ProcessedResume, processResumedConversation } from 'src/utils/sessionRestore.js'
import { parseSettingSourcesFlag } from 'src/utils/settings/constants.js'
import { plural } from 'src/utils/stringUtils.js'
import {
  type ChannelEntry,
  getInitialMainLoopModel,
  getIsNonInteractiveSession,
  getSdkBetas,
  getSessionId,
  getUserMsgOptIn,
  setAllowedChannels,
  setAllowedSettingSources,
  setChromeFlagOverride,
  setClientType,
  setCwdState,
  setDirectConnectServerUrl,
  setFlagSettingsPath,
  setInitialMainLoopModel,
  setInlinePlugins,
  setIsInteractive,
  setKairosActive,
  setOriginalCwd,
  setQuestionPreviewFormat,
  setSdkBetas,
  setSessionBypassPermissionsMode,
  setSessionPersistenceDisabled,
  setSessionSource,
  setUserMsgOptIn,
  switchSession,
} from './bootstrap/state.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('./utils/permissions/autoModeState.js') as typeof import('./utils/permissions/autoModeState.js'))
  : null

// TeleportRepoMismatchDialog、TeleportResumeWrapper 在调用处动态导入
import { createRemoteSessionConfig } from './remote/RemoteSessionManager.js'
/* eslint-enable @typescript-eslint/no-require-imports */
// teleportWithProgress 在调用处动态导入
import {
  createDirectConnectSession,
  DirectConnectError,
} from './server/createDirectConnectSession.js'
import { initializeLspServerManager } from './services/lsp/manager.js'
import { shouldEnablePromptSuggestion } from './services/PromptSuggestion/promptSuggestion.js'
import { type AppState, getDefaultAppState, IDLE_SPECULATION_STATE } from './state/AppStateStore.js'
import { onChangeAppState } from './state/onChangeAppState.js'
import { createStore } from './state/store.js'
import { asSessionId } from './types/ids.js'
import { filterAllowedSdkBetas } from './utils/betas.js'
import { isInBundledMode, isRunningWithBun } from './utils/bundledMode.js'
import { logForDiagnosticsNoPII } from './utils/diagLogs.js'
import { filterExistingPaths, getKnownPathsForRepo } from './utils/githubRepoPathMapping.js'
import { clearPluginCache, loadAllPluginsCacheOnly } from './utils/plugins/pluginLoader.js'
import { migrateChangelogFromConfig } from './utils/releaseNotes.js'
import { SandboxManager } from './utils/sandbox/sandbox-adapter.js'
import { fetchSession, prepareApiRequest } from './utils/teleport/api.js'
import {
  checkOutTeleportedSessionBranch,
  processMessagesForTeleportResume,
  teleportToRemoteWithErrorHandling,
  validateGitState,
  validateSessionRepository,
} from './utils/teleport.js'
import { shouldEnableThinkingByDefault, type ThinkingConfig } from './utils/thinking.js'
import { initUser, resetUserCache } from './utils/user.js'
import { getTmuxInstallInstructions, isTmuxAvailable, parsePRReference } from './utils/worktree.js'

// eslint-disable-next-line custom-rules/no-top-level-side-effects
profileCheckpoint('main_tsx_imports_loaded')

/**
 * 将托管设置键记录到 Statsig 用于分析。
 * 在 init() 完成后调用，以确保在模型解析之前
 * 设置已加载且环境变量已应用。
 */
function logManagedSettings(): void {
  try {
    const policySettings = getSettingsForSource('policySettings')
    if (policySettings) {
      const allKeys = getManagedSettingsKeysForLogging(policySettings)
      logEvent('zy_managed_settings_loaded', {
        keyCount: allKeys.length,
        keys: allKeys.join(
          ',',
        ) as unknown as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
  } catch {
    // 静默忽略错误 —— 这仅用于分析
  }
}

// 检查是否运行在调试/检查模式
function isBeingDebugged() {
  const isBun = isRunningWithBun()

  // 检查进程参数中的 inspect 标志（包括所有变体）
  const hasInspectArg = process.execArgv.some((arg) => {
    if (isBun) {
      // 注意：Bun 在单文件可执行模式下存在问题，process.argv 中的
      // 应用参数会泄漏到 process.execArgv 中（类似
      // https://github.com/oven-sh/bun/issues/11673）。如果省略此分支，
      // 会导致 --debug 模式不可用。跳过该检查没问题，因为 Bun
      // 不支持 Node.js 旧版 --debug 或 --debug-brk 标志
      return /--inspect(-brk)?/.test(arg)
    } else {
      // 在 Node.js 中，同时检查 --inspect 和旧版 --debug 标志
      return /--inspect(-brk)?|--debug(-brk)?/.test(arg)
    }
  })

  // 检查 NODE_OPTIONS 是否包含 inspect 标志
  const hasInspectEnv =
    process.env.NODE_OPTIONS && /--inspect(-brk)?|--debug(-brk)?/.test(process.env.NODE_OPTIONS)

  // 检查 inspector 是否可用且活跃（表示正在调试）
  try {
    // 动态导入更好但是异步的 —— 改用全局对象
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inspector = (global as any).require('inspector')
    const hasInspectorUrl = !!inspector.url()
    return hasInspectorUrl || hasInspectArg || hasInspectEnv
  } catch {
    // 忽略错误，回退到参数检测
    return hasInspectArg || hasInspectEnv
  }
}

// 如果检测到 node 调试或检查，则退出
if (!isInternalBuild() && isBeingDebugged()) {
  // 此处直接使用 process.exit，因为我们处于导入前的顶层代码
  // 且 gracefulShutdown 尚不可用
  // eslint-disable-next-line custom-rules/no-top-level-side-effects
  process.exit(1)
}

/**
 * 每个会话的技能/插件遥测。从交互路径和
 * 无头 -p 路径（在 runHeadless 之前）调用 —— 两者都经过
 * main.tsx 但在交互启动路径之前分支，所以需要两个
 * 调用点，而不是一个在这里 + 一个在 QueryEngine 中。
 */
function logSessionTelemetry(): void {
  const fallbackModel = getInitialMainLoopModel() ?? getDefaultMainLoopModel()
  if (!fallbackModel) return // 模型未配置时跳过遥测
  const model = parseUserSpecifiedModel(fallbackModel)
  void logSkillsLoaded(getCwd(), getContextWindowForModel(model))
  void loadAllPluginsCacheOnly()
    .then(({ enabled, errors }) => {
      const managedNames = getManagedPluginNames()
      logPluginsEnabledForSession(enabled, managedNames, getPluginSeedDirs())
      logPluginLoadErrors(errors, managedNames)
    })
    .catch((err) => logError(err))
}
function getCertEnvVarTelemetry(): Record<string, boolean> {
  const result: Record<string, boolean> = {}
  if (process.env.NODE_EXTRA_CA_CERTS) {
    result.has_node_extra_ca_certs = true
  }
  if (process.env.ZY_CODE_CLIENT_CERT) {
    result.has_client_cert = true
  }
  if (hasNodeOption('--use-system-ca')) {
    result.has_use_system_ca = true
  }
  if (hasNodeOption('--use-openssl-ca')) {
    result.has_use_openssl_ca = true
  }
  return result
}
async function logStartupTelemetry(): Promise<void> {
  if (isAnalyticsDisabled()) return
  const [isGit, worktreeCount, ghAuthStatus] = await Promise.all([
    getIsGit(),
    getWorktreeCount(),
    getGhAuthStatus(),
  ])
  logEvent('zy_startup_telemetry', {
    is_git: isGit,
    worktree_count: worktreeCount,
    gh_auth_status: ghAuthStatus as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    sandbox_enabled: SandboxManager.isSandboxingEnabled(),
    are_unsandboxed_commands_allowed: SandboxManager.areUnsandboxedCommandsAllowed(),
    is_auto_bash_allowed_if_sandbox_enabled: SandboxManager.isAutoAllowBashIfSandboxedEnabled(),
    auto_updater_disabled: isAutoUpdaterDisabled(),
    prefers_reduced_motion: getInitialSettings().prefersReducedMotion ?? false,
    ...getCertEnvVarTelemetry(),
  })
}

// 添加新的同步迁移时递增此值，以便现有用户重新运行迁移集。
const CURRENT_MIGRATION_VERSION = 13
function runMigrations(): void {
  if (getGlobalConfig().migrationVersion !== CURRENT_MIGRATION_VERSION) {
    saveGlobalConfig((prev) =>
      prev.migrationVersion === CURRENT_MIGRATION_VERSION
        ? prev
        : {
            ...prev,
            migrationVersion: CURRENT_MIGRATION_VERSION,
          },
    )
  }
  // 异步迁移 —— 触发后不等待，因为是非阻塞的
  migrateChangelogFromConfig().catch(() => {
    // 静默忽略迁移错误 —— 下次启动时重试
  })
}

/**
 * 仅在安全的情况下预取系统上下文（包括 git 状态）。
 * Git 命令可以通过钩子和配置执行任意代码（例如 core.fsmonitor、
 * diff.external），因此我们必须在建立信任后或在
 * 信任是隐式的非交互模式下才能运行它们。
 */
function prefetchSystemContextIfSafe(): void {
  const isNonInteractiveSession = getIsNonInteractiveSession()

  // 在非交互模式（--print）下，跳过信任对话框且
  // 执行被视为受信任的（如帮助文本中所述）
  if (isNonInteractiveSession) {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_non_interactive')
    void getSystemContext()
    return
  }

  // 在交互模式下，仅在已建立信任时才预取
  const hasTrust = checkHasTrustDialogAccepted()
  if (hasTrust) {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_has_trust')
    void getSystemContext()
  } else {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_skipped_no_trust')
  }
  // 否则，不预取 —— 等待信任建立后再进行
}

/**
 * 启动首次渲染不需要的后台预取和清理工作。
 * 这些从 setup() 中延迟出来，以减少事件循环竞争和
 * 关键启动路径中的子进程生成。
 * 在 REPL 渲染后调用此函数。
 */
export function startDeferredPrefetches(): void {
  // 此函数在首次渲染后运行，因此不会阻塞初始绘制。
  // 但是，生成的子进程和异步工作仍然会竞争 CPU 和事件
  // 循环时间，这会扭曲启动基准测试（CPU 配置文件、首次渲染时间
  // 测量）。仅在测量启动性能时跳过所有这些操作。
  if (
    isEnvTruthy(process.env.ZY_CODE_EXIT_AFTER_FIRST_RENDER) ||
    // --bare：跳过所有预取。这些是 REPL 首次响应性的缓存预热
    //（initUser、getUserContext、tips、countFiles、
    // modelCapabilities、change detectors）。脚本化的 -p 调用没有
    // "用户正在输入"的时间窗口来隐藏这些工作 —— 它是关键路径上的纯开销。
    isBareMode()
  ) {
    return
  }

  // 生成子进程的预取（在首次 API 调用时使用，用户仍在输入）
  void initUser()
  void getUserContext()
  prefetchSystemContextIfSafe()
  void getRelevantTips()
  void warmI18n()
  void countFilesRoundedRg(getCwd(), AbortSignal.timeout(3000), [])

  // 分析数据和功能标志初始化
  void initializeAnalyticsGates()
  void prefetchOfficialMcpUrls()
  void refreshModelCapabilities()

  // 文件变更检测器从 init() 延迟以不阻塞首次渲染
  void settingsChangeDetector.initialize()
  if (!isBareMode()) {
    void skillChangeDetector.initialize()
  }

  // 事件循环停顿检测器 —— 当主线程阻塞超过 500ms 时记录日志
  if (isInternalBuild()) {
    void import('./utils/eventLoopStallDetector.js').then((m: any) =>
      m.startEventLoopStallDetector(),
    )
  }
}
function loadSettingsFromFlag(settingsFile: string): void {
  try {
    const trimmedSettings = settingsFile.trim()
    const looksLikeJson = trimmedSettings.startsWith('{') && trimmedSettings.endsWith('}')
    let settingsPath: string
    if (looksLikeJson) {
      // 这是 JSON 字符串 —— 验证并创建临时文件
      const parsedJson = safeParseJSON(trimmedSettings)
      if (!parsedJson) {
        process.stderr.write(chalk.red('错误：提供给 --settings 的 JSON 无效\n'))
        process.exit(1)
      }

      // 创建临时文件并写入 JSON。
      // 使用基于内容哈希的路径而非随机 UUID，以避免破坏
      // Anthropic API 提示缓存。settings 路径最终会出现在
      // Bash 工具的 sandbox denyWithinAllow 列表中，该列表是
      // 发送给 API 的工具描述的一部分。每个子进程使用随机 UUID
      // 会在每次 query() 调用时更改工具描述，使缓存前缀失效，
      // 导致 12 倍的输入 token 成本惩罚。
      // 内容哈希确保相同的设置在进程边界之间生成相同路径
      //（每个 SDK query() 都会生成一个新进程）。
      settingsPath = generateTempFilePath('zy-settings', '.json', {
        contentHash: trimmedSettings,
      })
      writeFileSync_DEPRECATED(settingsPath, trimmedSettings, 'utf8')
    } else {
      // 这是一个文件路径 —— 解析并通过尝试读取来验证
      const { resolvedPath: resolvedSettingsPath } = safeResolvePath(
        getFsImplementation(),
        settingsFile,
      )
      try {
        readFileSync(resolvedSettingsPath, 'utf8')
      } catch (e) {
        if (isENOENT(e)) {
          process.stderr.write(chalk.red(`错误：找不到设置文件：${resolvedSettingsPath}\n`))
          process.exit(1)
        }
        throw e
      }
      settingsPath = resolvedSettingsPath
    }
    setFlagSettingsPath(settingsPath)
    resetSettingsCache()
  } catch (error) {
    if (error instanceof Error) {
      logError(error)
    }
    process.stderr.write(chalk.red(`处理设置时出错：${errorMessage(error)}\n`))
    process.exit(1)
  }
}
function loadSettingSourcesFromFlag(settingSourcesArg: string): void {
  try {
    const sources = parseSettingSourcesFlag(settingSourcesArg)
    setAllowedSettingSources(sources)
    resetSettingsCache()
  } catch (error) {
    if (error instanceof Error) {
      logError(error)
    }
    process.stderr.write(chalk.red(`处理 --setting-sources 时出错：${errorMessage(error)}\n`))
    process.exit(1)
  }
}

/**
 * 在 init() 之前早期解析并加载设置标志
 * 这确保从初始化开始就过滤设置
 */
function eagerLoadSettings(): void {
  profileCheckpoint('eagerLoadSettings_start')
  // 早期解析 --settings 标志以确保在 init() 之前加载设置
  const settingsFile = eagerParseCliFlag('--settings')
  if (settingsFile) {
    loadSettingsFromFlag(settingsFile)
  }

  // 早期解析 --setting-sources 标志以控制加载哪些来源
  const settingSourcesArg = eagerParseCliFlag('--setting-sources')
  if (settingSourcesArg !== undefined) {
    loadSettingSourcesFromFlag(settingSourcesArg)
  }
  profileCheckpoint('eagerLoadSettings_end')
}
function initializeEntrypoint(isNonInteractive: boolean): void {
  // 如果已设置则跳过（例如由 SDK 或其他入口点设置）
  if (process.env.ZY_CODE_ENTRYPOINT) {
    return
  }
  const cliArgs = process.argv.slice(2)

  // 检查 MCP serve 命令（处理 mcp serve 前的标志，例如 --debug mcp serve）
  const mcpIndex = cliArgs.indexOf('mcp')
  if (mcpIndex !== -1 && cliArgs[mcpIndex + 1] === 'serve') {
    process.env.ZY_CODE_ENTRYPOINT = 'mcp'
    return
  }
  if (isEnvTruthy(process.env.ZY_CODE_ACTION)) {
    process.env.ZY_CODE_ENTRYPOINT = 'zy-code-github-action'
    return
  }

  // 注意：'local-agent' 入口点由本地代理模式启动器
  // 通过 ZY_CODE_ENTRYPOINT 环境变量设置（由上方的提前返回处理）

  // 根据交互状态设置
  process.env.ZY_CODE_ENTRYPOINT = isNonInteractive ? 'sdk-cli' : 'cli'
}

// 当检测到 `zy open <url>` 时由早期 argv 处理设置（仅限交互模式）
type PendingConnect = {
  url: string | undefined
  authToken: string | undefined
  dangerouslySkipPermissions: boolean
}
const _pendingConnect: PendingConnect | undefined = feature('DIRECT_CONNECT')
  ? {
      url: undefined,
      authToken: undefined,
      dangerouslySkipPermissions: false,
    }
  : undefined

// 当检测到 `zy assistant [sessionId]` 时由早期 argv 处理设置
type PendingAssistantChat = {
  sessionId?: string
  discover: boolean
}
const _pendingAssistantChat: PendingAssistantChat | undefined = feature('KAIROS')
  ? {
      sessionId: undefined,
      discover: false,
    }
  : undefined

// `zy ssh <host> [dir]` —— 从 argv 早期解析（与上方
// DIRECT_CONNECT 相同的模式），以便主命令路径可以接收它并交给
// REPL 一个 SSH 支持的会话，而不是本地会话。
type PendingSSH = {
  host: string | undefined
  cwd: string | undefined
  permissionMode: string | undefined
  dangerouslySkipPermissions: boolean
  /** --local: spawn the child CLI directly, skip ssh/probe/deploy. e2e test mode. */
  local: boolean
  /** Extra CLI args to forward to the remote CLI on initial spawn (--resume, -c). */
  extraCliArgs: string[]
}
const _pendingSSH: PendingSSH | undefined = feature('SSH_REMOTE')
  ? {
      host: undefined,
      cwd: undefined,
      permissionMode: undefined,
      dangerouslySkipPermissions: false,
      local: false,
      extraCliArgs: [],
    }
  : undefined
export async function main() {
  profileCheckpoint('main_function_start')

  // 安全：防止 Windows 从当前目录执行命令
  // 必须在任何命令执行之前设置，以防止 PATH 劫持攻击
  // See: https://docs.microsoft.com/en-us/windows/win32/api/processenv/nf-processenv-searchpathw
  process.env.NoDefaultCurrentDirectoryInExePath = '1'

  // 早期初始化警告处理器以捕获警告
  initializeWarningHandler()
  process.on('exit', () => {
    resetCursor()
  })
  process.on('SIGINT', () => {
    // 在 print 模式下，print.ts 注册了自己的 SIGINT 处理器来中止
    // 进行中的查询并调用 gracefulShutdown；在此跳过以避免
    // 用同步的 process.exit() 抢占它。
    if (process.argv.includes('-p') || process.argv.includes('--print')) {
      return
    }
    process.exit(0)
  })
  profileCheckpoint('main_warning_handler_initialized')

  // 在 argv 中检查 cc:// 或 cc+unix:// URL —— 重写以便主命令
  // 处理它，提供完整的交互式 TUI 而不是精简的子命令。
  // 对于无头模式（-p），我们重写为内部的 `open` 子命令。
  if (feature('DIRECT_CONNECT')) {
    const rawCliArgs = process.argv.slice(2)
    const ccIdx = rawCliArgs.findIndex((a) => a.startsWith('cc://') || a.startsWith('cc+unix://'))
    if (ccIdx !== -1 && _pendingConnect) {
      const ccUrl = rawCliArgs[ccIdx]!
      const {
        // @ts-ignore
        parseConnectUrl,
      } = await import('./server/parseConnectUrl.js')
      const parsed = (parseConnectUrl as any)(ccUrl)
      _pendingConnect.dangerouslySkipPermissions = rawCliArgs.includes(
        '--dangerously-skip-permissions',
      )
      if (rawCliArgs.includes('-p') || rawCliArgs.includes('--print')) {
        // 无头模式：重写为内部 `open` 子命令
        const stripped = rawCliArgs.filter((_, i) => i !== ccIdx)
        const dspIdx = stripped.indexOf('--dangerously-skip-permissions')
        if (dspIdx !== -1) {
          stripped.splice(dspIdx, 1)
        }
        process.argv = [process.argv[0]!, process.argv[1]!, 'open', ccUrl, ...stripped]
      } else {
        // 交互模式：剥离 cc:// URL 和标志，运行主命令
        _pendingConnect.url = parsed.serverUrl
        _pendingConnect.authToken = parsed.authToken
        const stripped = rawCliArgs.filter((_, i) => i !== ccIdx)
        const dspIdx = stripped.indexOf('--dangerously-skip-permissions')
        if (dspIdx !== -1) {
          stripped.splice(dspIdx, 1)
        }
        process.argv = [process.argv[0]!, process.argv[1]!, ...stripped]
      }
    }
  }

  // 早期处理深度链接 URI —— 由操作系统协议处理器调用
  // 应该在完整 init 之前退出，因为它只需要解析 URI
  // 并打开终端。
  if (feature('LODESTONE')) {
    const handleUriIdx = process.argv.indexOf('--handle-uri')
    if (handleUriIdx !== -1 && process.argv[handleUriIdx + 1]) {
      const { enableConfigs } = await import('./utils/config.js')
      enableConfigs()
      const uri = process.argv[handleUriIdx + 1]!
      const { handleDeepLinkUri } = await import('./utils/deepLink/protocolHandler.js')
      const exitCode = await handleDeepLinkUri(uri)
      process.exit(exitCode)
    }

    // macOS URL 处理器：当 LaunchServices 启动我们的 .app bundle 时，
    // URL 通过 Apple Event 到达（而不是 argv）。LaunchServices 将
    // __CFBundleIdentifier 覆盖为启动 bundle 的 ID，这是一个精确的
    // 正面信号 —— 比用启发式方法导入和猜测更便宜。
    if (
      process.platform === 'darwin' &&
      process.env.__CFBundleIdentifier === 'com.anthropic.zy-code-url-handler'
    ) {
      const { enableConfigs } = await import('./utils/config.js')
      enableConfigs()
      const { handleUrlSchemeLaunch } = await import('./utils/deepLink/protocolHandler.js')
      const urlSchemeResult = await handleUrlSchemeLaunch()
      process.exit(urlSchemeResult ?? 1)
    }
  }

  // `zy assistant [sessionId]` —— 暂存并剥离，以便主命令
  // 处理它，提供完整的交互式 TUI。仅限位置 0（与下方
  // ssh 模式匹配）—— indexOf 会对 `zy -p "explain assistant"` 产生误判。
  // 根标志在子命令前（例如 `--debug assistant`）会透传到存根，
  // 打印用法说明。
  if (feature('KAIROS') && _pendingAssistantChat) {
    const rawArgs = process.argv.slice(2)
    if (rawArgs[0] === 'assistant') {
      const nextArg = rawArgs[1]
      if (nextArg && !nextArg.startsWith('-')) {
        _pendingAssistantChat.sessionId = nextArg
        rawArgs.splice(0, 2) // drop 'assistant' and sessionId
        process.argv = [process.argv[0]!, process.argv[1]!, ...rawArgs]
      } else if (!nextArg) {
        _pendingAssistantChat.discover = true
        rawArgs.splice(0, 1) // drop 'assistant'
        process.argv = [process.argv[0]!, process.argv[1]!, ...rawArgs]
      }
      // else: `zy assistant --help` → fall through to stub
    }
  }

  // `zy ssh <host> [dir]` —— 从 argv 剥离以便主命令处理器
  // 运行（完整交互式 TUI），暂存主机/目录供 REPL 分支在
  // ~line 3720 处接收。无头模式（-p）在 v1 中不受支持：SSH
  // 会话需要本地 REPL 来驱动（中断、权限）。
  if (feature('SSH_REMOTE') && _pendingSSH) {
    const rawCliArgs = process.argv.slice(2)
    // SSH 特定标志可以出现在主机位置参数之前（例如
    // `ssh --permission-mode auto host /tmp` —— 标准的 POSIX 标志在前
    // 位置参数）。在检查是否给出了主机之前将它们全部提取出来，
    // 这样 `zy ssh --permission-mode auto host` 和 `zy ssh host
    // --permission-mode auto` 是等价的。下方的主机检查只需要
    // 防御 `-h`/`--help`（commander 应该处理）。
    if (rawCliArgs[0] === 'ssh') {
      const localIdx = rawCliArgs.indexOf('--local')
      if (localIdx !== -1) {
        _pendingSSH.local = true
        rawCliArgs.splice(localIdx, 1)
      }
      const dspIdx = rawCliArgs.indexOf('--dangerously-skip-permissions')
      if (dspIdx !== -1) {
        _pendingSSH.dangerouslySkipPermissions = true
        rawCliArgs.splice(dspIdx, 1)
      }
      const pmIdx = rawCliArgs.indexOf('--permission-mode')
      if (pmIdx !== -1 && rawCliArgs[pmIdx + 1] && !rawCliArgs[pmIdx + 1]!.startsWith('-')) {
        _pendingSSH.permissionMode = rawCliArgs[pmIdx + 1]
        rawCliArgs.splice(pmIdx, 2)
      }
      const pmEqIdx = rawCliArgs.findIndex((a) => a.startsWith('--permission-mode='))
      if (pmEqIdx !== -1) {
        _pendingSSH.permissionMode = rawCliArgs[pmEqIdx]!.split('=')[1]
        rawCliArgs.splice(pmEqIdx, 1)
      }
      // 将会话恢复和模型标志转发给远程 CLI 的初始生成。
      // --continue/-c 和 --resume <uuid> 操作于远程会话历史
      // （持久化在远程的 ~/.zy/projects/<cwd>/ 下）。
      // --model 控制远程使用的模型。
      const extractFlag = (
        flag: string,
        opts: {
          hasValue?: boolean
          as?: string
        } = {},
      ) => {
        const i = rawCliArgs.indexOf(flag)
        if (i !== -1) {
          _pendingSSH.extraCliArgs.push(opts.as ?? flag)
          const val = rawCliArgs[i + 1]
          if (opts.hasValue && val && !val.startsWith('-')) {
            _pendingSSH.extraCliArgs.push(val)
            rawCliArgs.splice(i, 2)
          } else {
            rawCliArgs.splice(i, 1)
          }
        }
        const eqI = rawCliArgs.findIndex((a) => a.startsWith(`${flag}=`))
        if (eqI !== -1) {
          _pendingSSH.extraCliArgs.push(opts.as ?? flag, rawCliArgs[eqI]!.slice(flag.length + 1))
          rawCliArgs.splice(eqI, 1)
        }
      }
      extractFlag('-c', {
        as: '--continue',
      })
      extractFlag('--continue')
      extractFlag('--resume', {
        hasValue: true,
      })
      extractFlag('--model', {
        hasValue: true,
      })
    }
    // 提取后，[1] 处剩余的任何 dash 参数要么是 -h/--help
    //（commander 处理），要么是对 ssh 未知的标志（透传给 commander
    // 以便它显示正确的错误）。只有非 dash 参数才是主机。
    if (rawCliArgs[0] === 'ssh' && rawCliArgs[1] && !rawCliArgs[1].startsWith('-')) {
      _pendingSSH.host = rawCliArgs[1]
      // 可选的位置参数 cwd。
      let consumed = 2
      if (rawCliArgs[2] && !rawCliArgs[2].startsWith('-')) {
        _pendingSSH.cwd = rawCliArgs[2]
        consumed = 3
      }
      const rest = rawCliArgs.slice(consumed)

      // 无头模式（-p）在 v1 中不支持 SSH —— 提前拒绝
      // 以免标志静默导致本地执行。
      if (rest.includes('-p') || rest.includes('--print')) {
        process.stderr.write('Error: headless (-p/--print) mode is not supported with zy ssh\n')
        gracefulShutdownSync(1)
        return
      }

      // 重写 argv 以便主命令看到剩余标志但不包括 `ssh`。
      process.argv = [process.argv[0]!, process.argv[1]!, ...rest]
    }
  }

  // 早期检查 -p/--print 和 --init-only 标志以在 init() 之前设置 isInteractiveSession
  // 这是必需的，因为遥测初始化调用需要此标志的认证函数
  const cliArgs = process.argv.slice(2)
  const hasPrintFlag = cliArgs.includes('-p') || cliArgs.includes('--print')
  const hasInitOnlyFlag = cliArgs.includes('--init-only')
  const hasSdkUrl = cliArgs.some((arg) => arg.startsWith('--sdk-url'))
  const isNonInteractive = hasPrintFlag || hasInitOnlyFlag || hasSdkUrl || !process.stdout.isTTY

  // 停止为非交互模式捕获早期输入
  if (isNonInteractive) {
    stopCapturingEarlyInput()
  }

  // 设置简化的跟踪字段
  const isInteractive = !isNonInteractive
  setIsInteractive(isInteractive)

  // 根据模式初始化入口点 —— 需要在记录任何事件之前设置
  initializeEntrypoint(isNonInteractive)

  // 确定客户端类型
  const clientType = (() => {
    if (isEnvTruthy(process.env.GITHUB_ACTIONS)) return 'github-action'
    if (process.env.ZY_CODE_ENTRYPOINT === 'sdk-ts') return 'sdk-typescript'
    if (process.env.ZY_CODE_ENTRYPOINT === 'sdk-py') return 'sdk-python'
    if (process.env.ZY_CODE_ENTRYPOINT === 'sdk-cli') return 'sdk-cli'
    if (process.env.ZY_CODE_ENTRYPOINT === 'zy-vscode') return 'zy-vscode'
    if (process.env.ZY_CODE_ENTRYPOINT === 'local-agent') return 'local-agent'
    if (process.env.ZY_CODE_ENTRYPOINT === 'zy-desktop') return 'zy-desktop'

    // 检查是否提供了会话入口令牌（表示远程会话）
    const hasSessionIngressToken =
      process.env.ZY_CODE_SESSION_ACCESS_TOKEN || process.env.ZY_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR
    if (process.env.ZY_CODE_ENTRYPOINT === 'remote' || hasSessionIngressToken) {
      return 'remote'
    }
    return 'cli'
  })()
  setClientType(clientType)
  const previewFormat = process.env.ZY_CODE_QUESTION_PREVIEW_FORMAT
  if (previewFormat === 'markdown' || previewFormat === 'html') {
    setQuestionPreviewFormat(previewFormat)
  } else if (
    !clientType.startsWith('sdk-') &&
    // Desktop 和 CCR 通过 toolConfig 传递 previewFormat；当功能被
    // 关闭时它们传递 undefined —— 不要用 markdown 覆盖它。
    clientType !== 'zy-desktop' &&
    clientType !== 'local-agent' &&
    clientType !== 'remote'
  ) {
    setQuestionPreviewFormat('markdown')
  }

  // 标记通过 `zy remote-control` 创建的会话，以便后端识别它们
  if (process.env.ZY_CODE_ENVIRONMENT_KIND === 'bridge') {
    setSessionSource('remote-control')
  }
  profileCheckpoint('main_client_type_determined')

  // 早期解析并加载设置标志，在 init() 之前
  eagerLoadSettings()

  profileCheckpoint('main_before_run')
  await run()

  profileCheckpoint('main_after_run')
}
async function getInputPrompt(
  prompt: string,
  inputFormat: 'text' | 'stream-json',
): Promise<string | AsyncIterable<string>> {
  if (
    !process.stdin.isTTY &&
    // 输入劫持会破坏 MCP。
    !process.argv.includes('mcp')
  ) {
    if (inputFormat === 'stream-json') {
      return process.stdin
    }
    process.stdin.setEncoding('utf8')
    let data = ''
    const onData = (chunk: string) => {
      data += chunk
    }
    process.stdin.on('data', onData)
    // 如果 3 秒内没有数据到达，停止等待并发出警告。Stdin 可能是
    // 从没有写入的父进程继承的管道（子进程生成时
    // 没有明确的 stdin 处理）。3 秒覆盖了慢速生产者如 curl、
    // 大文件上的 jq、有导入开销的 python。警告使
    // 对于仍然更慢的罕见生产者，静默数据丢失可见。
    const timedOut = await peekForStdinData(process.stdin, 3000)
    process.stdin.off('data', onData)
    if (timedOut) {
      process.stderr.write(
        'Warning: no stdin data received in 3s, proceeding without it. ' +
          'If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.\n',
      )
    }
    return [prompt, data].filter(Boolean).join('\n')
  }
  return prompt
}
async function run(): Promise<CommanderCommand> {
  profileCheckpoint('run_function_start')

  // 创建帮助配置，按长选项名排序选项。
  // Commander 支持运行时 compareOptions，但 @commander-js/extra-typings
  // 的类型定义中不包含它，所以我们使用 Object.assign 来添加。
  function createSortedHelpConfig(): {
    sortSubcommands: true
    sortOptions: true
  } {
    const getOptionSortKey = (opt: Option): string =>
      opt.long?.replace(/^--/, '') ?? opt.short?.replace(/^-/, '') ?? ''
    return Object.assign(
      {
        sortSubcommands: true,
        sortOptions: true,
      } as const,
      {
        compareOptions: (a: Option, b: Option) =>
          getOptionSortKey(a).localeCompare(getOptionSortKey(b)),
      },
    )
  }
  const program = new CommanderCommand()
    .configureHelp(createSortedHelpConfig())
    .enablePositionalOptions()
  profileCheckpoint('run_commander_initialized')

  // 使用 preAction 钩子在执行命令时运行初始化，
  // 而不是在显示帮助时。这避免了需要环境变量信号。
  program.hook('preAction', async (thisCommand) => {
    profileCheckpoint('preAction_start')
    // 等待在模块评估时启动的异步子进程加载（第 12-20 行）。
    // 几乎免费 —— 子进程在上方约 135ms 的导入期间完成。
    // 必须在 init() 之前解析，init() 会触发第一次设置读取
    //（applySafeConfigEnvironmentVariables → getSettingsForSource('policySettings')
    // → isRemoteManagedSettingsEligible → 否则同步 keychain 读取约 65ms）。
    await Promise.all([ensureMdmSettingsLoaded(), ensureKeychainPrefetchCompleted()])
    profileCheckpoint('preAction_after_mdm')
    await init()
    profileCheckpoint('preAction_after_init')

    // Windows 上的 process.title 直接设置控制台标题；在 POSIX 上，
    // 终端 shell 集成可能会将进程名称镜像到标签页。
    // 在 init() 之后，以便 settings.json env 也可以控制此（gh-4765）。
    if (!isEnvTruthy(process.env.ZY_CODE_DISABLE_TERMINAL_TITLE)) {
      process.title = 'zy'
    }

    // 附加日志接收器以便子命令处理器可以使用 logEvent/logError。
    // PR #11106 之前 logEvent 直接分派；之后，事件排队直到
    // 接收器附加。setup() 为默认命令附加接收器，但
    // 子命令（doctor、mcp、plugin、auth）从不调用 setup()，会在
    // process.exit() 时静默丢弃事件。两个初始化都是幂等的。
    const { initSinks } = await import('./utils/sinks.js')
    initSinks()
    profileCheckpoint('preAction_after_sinks')

    // gh-33508：--plugin-dir 是顶级程序选项。默认
    // action 从自己的选项解构中读取它，但子命令
    //（plugin list、plugin install、mcp *）有自己的 action 且
    // 从不会看到它。在这里连接它以便 getInlinePlugins() 在任何地方都有效。
    // thisCommand.opts() 在这里类型为 {}，因为这个钩子附加在
    // .option('--plugin-dir', ...) 之前 —— extra-typings
    // 在添加选项时构建类型。用运行时守卫缩小范围；
    // collect 累加器 + [] 默认保证实践中为 string[]。
    const pluginDir = thisCommand.getOptionValue('pluginDir')
    if (
      Array.isArray(pluginDir) &&
      pluginDir.length > 0 &&
      pluginDir.every((p) => typeof p === 'string')
    ) {
      setInlinePlugins(pluginDir)
      clearPluginCache('preAction: --plugin-dir inline plugins')
    }
    runMigrations()
    profileCheckpoint('preAction_after_migrations')

    // 为企业客户加载远程托管设置（非阻塞）
    // 开放失败 —— 如果获取失败，继续而不使用远程设置
    // 设置到达时通过热重载应用
    // 必须在 init() 之后发生以确保允许读取配置
    void loadRemoteManagedSettings()
    void loadPolicyLimits()
    profileCheckpoint('preAction_after_remote_settings')

    // 同步加载设置（非阻塞，开放失败）
    // CLI：将本地设置上传到远程（CCR 下载由 print.ts 处理）
    if (feature('UPLOAD_USER_SETTINGS')) {
      void import('./services/settingsSync/index.js').then((m) =>
        m.uploadUserSettingsInBackground(),
      )
    }
    profileCheckpoint('preAction_after_settings_sync')
  })
  program
    .name('zy')
    .description(
      `ZY Code - starts an interactive session by default, use -p/--print for non-interactive output`,
    )
    .argument('[prompt]', 'Your prompt', String)
    // 子命令通过 commander 的 copyInheritedSettings 继承 helpOption ——
    // 在这里设置一次就覆盖了 mcp、plugin、auth 和所有其他子命令。
    .helpOption('-h, --help', 'Display help for command')
    .option(
      '-d, --debug [filter]',
      'Enable debug mode with optional category filtering (e.g., "api,hooks" or "!1p,!file")',
      (_value: string | true) => {
        // 如果提供了值，它将是过滤字符串
        // 如果没有提供但标志存在，值将为 true
        // 实际的过滤由 debug.ts 通过解析 process.argv 处理
        return true
      },
    )
    .addOption(
      new Option('--debug-to-stderr', 'Enable debug mode (to stderr)')
        .argParser(Boolean)
        .hideHelp(),
    )
    .option(
      '--debug-file <path>',
      'Write debug logs to a specific file path (implicitly enables debug mode)',
      () => true,
    )
    .option('--verbose', 'Override verbose mode setting from config', () => true)
    .option(
      '-p, --print',
      'Print response and exit (useful for pipes). Note: The workspace trust dialog is skipped when ZY is run with the -p mode. Only use this flag in directories you trust.',
      () => true,
    )
    .option(
      '--bare',
      'Minimal mode: skip hooks, LSP, plugin sync, attribution, auto-memory, background prefetches, keychain reads, and CLAUDE.md auto-discovery. Sets ZY_CODE_SIMPLE=1. Auth is strictly ZY_API_KEY or apiKeyHelper via --settings (OAuth and keychain are never read). 3P providers (Bedrock/Vertex/Foundry) use their own credentials. Skills still resolve via /skill-name. Explicitly provide context via: --system-prompt[-file], --append-system-prompt[-file], --add-dir (CLAUDE.md dirs), --mcp-config, --settings, --agents, --plugin-dir.',
      () => true,
    )
    .addOption(new Option('--init', 'Run Setup hooks with init trigger, then continue').hideHelp())
    .addOption(
      new Option('--init-only', 'Run Setup and SessionStart:startup hooks, then exit').hideHelp(),
    )
    .addOption(
      new Option(
        '--maintenance',
        'Run Setup hooks with maintenance trigger, then continue',
      ).hideHelp(),
    )
    .addOption(
      new Option(
        '--output-format <format>',
        'Output format (only works with --print): "text" (default), "json" (single result), or "stream-json" (realtime streaming)',
      ).choices(['text', 'json', 'stream-json']),
    )
    .addOption(
      new Option(
        '--json-schema <schema>',
        'JSON Schema for structured output validation. ' +
          'Example: {"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}',
      ).argParser(String),
    )
    .option(
      '--include-hook-events',
      'Include all hook lifecycle events in the output stream (only works with --output-format=stream-json)',
      () => true,
    )
    .option(
      '--include-partial-messages',
      'Include partial message chunks as they arrive (only works with --print and --output-format=stream-json)',
      () => true,
    )
    .addOption(
      new Option(
        '--input-format <format>',
        'Input format (only works with --print): "text" (default), or "stream-json" (realtime streaming input)',
      ).choices(['text', 'stream-json']),
    )
    .option(
      '--mcp-debug',
      '[DEPRECATED. Use --debug instead] Enable MCP debug mode (shows MCP server errors)',
      () => true,
    )
    .option(
      '--dangerously-skip-permissions',
      'Bypass all permission checks. Recommended only for sandboxes with no internet access.',
      () => true,
    )
    .option(
      '--allow-dangerously-skip-permissions',
      'Enable bypassing all permission checks as an option, without it being enabled by default. Recommended only for sandboxes with no internet access.',
      () => true,
    )
    .addOption(
      new Option('--thinking <mode>', 'Thinking mode: enabled (equivalent to adaptive), disabled')
        .choices(['enabled', 'adaptive', 'disabled'])
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--max-thinking-tokens <tokens>',
        '[DEPRECATED. Use --thinking instead for newer models] Maximum number of thinking tokens (only works with --print)',
      )
        .argParser(Number)
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--max-turns <turns>',
        'Maximum number of agentic turns in non-interactive mode. This will early exit the conversation after the specified number of turns. (only works with --print)',
      )
        .argParser(Number)
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--max-budget-usd <amount>',
        'Maximum dollar amount to spend on API calls (only works with --print)',
      ).argParser((value) => {
        const amount = Number(value)
        if (isNaN(amount) || amount <= 0) {
          throw new Error('--max-budget-usd must be a positive number greater than 0')
        }
        return amount
      }),
    )
    .addOption(
      new Option(
        '--task-budget <tokens>',
        'API-side task budget in tokens (output_config.task_budget)',
      )
        .argParser((value) => {
          const tokens = Number(value)
          if (isNaN(tokens) || tokens <= 0 || !Number.isInteger(tokens)) {
            throw new Error('--task-budget must be a positive integer')
          }
          return tokens
        })
        .hideHelp(),
    )
    .option(
      '--replay-user-messages',
      'Re-emit user messages from stdin back on stdout for acknowledgment (only works with --input-format=stream-json and --output-format=stream-json)',
      () => true,
    )
    .addOption(
      new Option('--enable-auth-status', 'Enable auth status messages in SDK mode')
        .default(false)
        .hideHelp(),
    )
    .option(
      '--allowedTools, --allowed-tools <tools...>',
      'Comma or space-separated list of tool names to allow (e.g. "Bash(git:*) Edit")',
    )
    .option(
      '--tools <tools...>',
      'Specify the list of available tools from the built-in set. Use "" to disable all tools, "default" to use all tools, or specify tool names (e.g. "Bash,Edit,Read").',
    )
    .option(
      '--disallowedTools, --disallowed-tools <tools...>',
      'Comma or space-separated list of tool names to deny (e.g. "Bash(git:*) Edit")',
    )
    .option(
      '--mcp-config <configs...>',
      'Load MCP servers from JSON files or strings (space-separated)',
    )
    .addOption(
      new Option(
        '--permission-prompt-tool <tool>',
        'MCP tool to use for permission prompts (only works with --print)',
      )
        .argParser(String)
        .hideHelp(),
    )
    .addOption(
      new Option('--system-prompt <prompt>', 'System prompt to use for the session').argParser(
        String,
      ),
    )
    .addOption(
      new Option('--system-prompt-file <file>', 'Read system prompt from a file')
        .argParser(String)
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--append-system-prompt <prompt>',
        'Append a system prompt to the default system prompt',
      ).argParser(String),
    )
    .addOption(
      new Option(
        '--append-system-prompt-file <file>',
        'Read system prompt from a file and append to the default system prompt',
      )
        .argParser(String)
        .hideHelp(),
    )
    .addOption(
      new Option('--permission-mode <mode>', 'Permission mode to use for the session')
        .argParser(String)
        .choices(PERMISSION_MODES),
    )
    .option(
      '-c, --continue',
      'Continue the most recent conversation in the current directory',
      () => true,
    )
    .option(
      '-r, --resume [value]',
      'Resume a conversation by session ID, or open interactive picker with optional search term',
      (value) => value || true,
    )
    .option(
      '--fork-session',
      'When resuming, create a new session ID instead of reusing the original (use with --resume or --continue)',
      () => true,
    )
    .addOption(
      new Option(
        '--prefill <text>',
        'Pre-fill the prompt input with text without submitting it',
      ).hideHelp(),
    )
    .addOption(
      new Option(
        '--deep-link-origin',
        'Signal that this session was launched from a deep link',
      ).hideHelp(),
    )
    .addOption(
      new Option(
        '--deep-link-repo <slug>',
        'Repo slug the deep link ?repo= parameter resolved to the current cwd',
      ).hideHelp(),
    )
    .addOption(
      new Option(
        '--deep-link-last-fetch <ms>',
        'FETCH_HEAD mtime in epoch ms, precomputed by the deep link trampoline',
      )
        .argParser((v) => {
          const n = Number(v)
          return Number.isFinite(n) ? n : undefined
        })
        .hideHelp(),
    )
    .option(
      '--from-pr [value]',
      'Resume a session linked to a PR by PR number/URL, or open interactive picker with optional search term',
      (value) => value || true,
    )
    .option(
      '--no-session-persistence',
      'Disable session persistence - sessions will not be saved to disk and cannot be resumed (only works with --print)',
    )
    .addOption(
      new Option(
        '--resume-session-at <message id>',
        'When resuming, only messages up to and including the assistant message with <message.id> (use with --resume in print mode)',
      )
        .argParser(String)
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--rewind-files <user-message-id>',
        'Restore files to state at the specified user message and exit (requires --resume)',
      ).hideHelp(),
    )
    // @[MODEL LAUNCH]: Update the example model ID in the --model help text.
    .option(
      '--model <model>',
      `Model for the current session. Specify a model (e.g. 'qwen3.6-plus').`,
    )
    .addOption(
      new Option(
        '--effort <level>',
        `Effort level for the current session (low, medium, high, max)`,
      ).argParser((rawValue: string) => {
        const value = rawValue.toLowerCase()
        const allowed = ['low', 'medium', 'high', 'max']
        if (!allowed.includes(value)) {
          throw new InvalidArgumentError(`It must be one of: ${allowed.join(', ')}`)
        }
        return value
      }),
    )
    .option('--agent <agent>', `Agent for the current session. Overrides the 'agent' setting.`)
    .option('--betas <betas...>', 'Beta headers to include in API requests (API key users only)')
    .option(
      '--fallback-model <model>',
      'Enable automatic fallback to specified model when default model is overloaded (only works with --print)',
    )
    .addOption(
      new Option(
        '--workload <tag>',
        'Workload tag for billing-header attribution (cc_workload). Process-scoped; set by SDK daemon callers that spawn subprocesses for cron work. (only works with --print)',
      ).hideHelp(),
    )
    .option(
      '--settings <file-or-json>',
      'Path to a settings JSON file or a JSON string to load additional settings from',
    )
    .option('--add-dir <directories...>', 'Additional directories to allow tool access to')
    .option(
      '--ide',
      'Automatically connect to IDE on startup if exactly one valid IDE is available',
      () => true,
    )
    .option(
      '--strict-mcp-config',
      'Only use MCP servers from --mcp-config, ignoring all other MCP configurations',
      () => true,
    )
    .option(
      '--session-id <uuid>',
      'Use a specific session ID for the conversation (must be a valid UUID)',
    )
    .option(
      '-n, --name <name>',
      'Set a display name for this session (shown in /resume and terminal title)',
    )
    .option(
      '--agents <json>',
      'JSON object defining custom agents (e.g. \'{"reviewer": {"description": "Reviews code", "prompt": "You are a code reviewer"}}\')',
    )
    .option(
      '--setting-sources <sources>',
      'Comma-separated list of setting sources to load (user, project, local).',
    )
    // gh-33508：<paths...>（可变参数）消费直到下一个
    // --flag。`zy --plugin-dir /path mcp add --transport http` 吞掉了
    // `mcp` 和 `add` 作为 paths，然后因为 --transport 作为未知
    // 顶级选项而报错。单值 + collect 累加器意味着每个
    // --plugin-dir 只接受一个参数；重复标志用于多个目录。
    .option(
      '--plugin-dir <path>',
      'Load plugins from a directory for this session only (repeatable: --plugin-dir A --plugin-dir B)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option('--disable-slash-commands', 'Disable all skills', () => true)
    .option('--chrome', 'Enable ZY in Chrome integration')
    .option('--no-chrome', 'Disable ZY in Chrome integration')
    .option(
      '--file <specs...>',
      'File resources to download at startup. Format: file_id:relative_path (e.g., --file file_abc:doc.txt file_def:img.png)',
    )
    .action(async (prompt, options) => {
      profileCheckpoint('action_handler_start')

      // --bare = 一键最小模式。设置 SIMPLE 以便所有现有的
      // 门控触发（ZY.md、skills、hooks 在 executeHooks 中、agent
      // 目录遍历）。必须在 setup() / 任何门控工作运行之前设置。
      if (
        (
          options as {
            bare?: boolean
          }
        ).bare
      ) {
        process.env.ZY_CODE_SIMPLE = '1'
      }

      // 忽略 "code" 作为提示 —— 与没有提示一样处理
      if (prompt === 'code') {
        logEvent('zy_code_prompt_ignored', {})
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.warn(chalk.yellow('Tip: You can launch ZY Code with just `zy`'))
        prompt = undefined
      }

      // 记录任何单字提示的事件
      if (prompt && typeof prompt === 'string' && !/\s/.test(prompt) && prompt.length > 0) {
        logEvent('zy_single_word_prompt', {
          length: prompt.length,
        })
      }

      // 助手模式：当 .zy/settings.json 有 assistant: true 且
      // zy_kairos GrowthBook 门控开启时，强制 brief 开启。权限
      // 模式留给用户 —— 设置 defaultMode 或 --permission-mode
      // 正常应用。REPL 输入的消息默认为 'next'
      // 优先级（messageQueueManager.enqueue），以便它们在工具调用之间
      // 中转中排空。SendUserMessage（BriefTool）通过 brief env
      // 变量启用。SleepTool 保持禁用（它的 isEnabled() 门控在 proactive 上）。
      // kairosEnabled 在这里计算一次并在下方
      // getAssistantSystemPromptAddendum() 调用处重用。
      //
      // 信任门：.zy/settings.json 在不可信的 clone 中是攻击者可控制的。
      // 我们在 showSetupScreens() 显示信任对话框之前运行约 1000 行代码，
      // 到那时我们已经将 .zy/agents/assistant.md 附加到了系统提示。
      // 在目录被明确信任之前拒绝激活。
      let kairosEnabled = false
      let assistantTeamContext:
        | Awaited<ReturnType<typeof getAssistant>['initializeAssistantTeam']>
        | undefined
      if (
        feature('KAIROS') &&
        (
          options as {
            assistant?: boolean
          }
        ).assistant &&
        assistantModule
      ) {
        // --assistant（Agent SDK 守护进程模式）：在
        // isAssistantMode() 在下面运行之前强制锁定。守护进程已经检查过
        // 权限 —— 不要让子进程重新检查 zy_kairos。
        assistantModule.markAssistantForced()
      }
      if (
        feature('KAIROS') &&
        assistantModule?.isAssistantMode() &&
        // 生成的队友共享领导者的 cwd + settings.json，所以
        // isAssistantMode() 对它们也为 true。--agent-id 被设置
        // 意味着我们是一个生成的队友（extractTeammateOptions 在
        // 约 170 行后运行，所以检查原始 commander 选项）—— 不要
        // 重新初始化团队或覆盖 teammateMode/proactive/brief。
        !(
          options as {
            agentId?: unknown
          }
        ).agentId &&
        kairosGate
      ) {
        if (!checkHasTrustDialogAccepted()) {
          // biome-ignore lint/suspicious/noConsole:: intentional console output
          console.warn(
            chalk.yellow(
              'Assistant mode disabled: directory is not trusted. Accept the trust dialog and restart.',
            ),
          )
        } else {
          // 阻塞门检查 —— 缓存的 `true` 立即返回；如果磁盘
          // 缓存为 false/缺失，延迟初始化 GrowthBook 并获取新鲜数据
          //（最多约 5 秒）。--assistant 完全跳过此门（守护进程是
          // 预先授权的）。
          kairosEnabled =
            getAssistant().isAssistantForced() || (await (kairosGate as any).isKairosEnabled())
          if (kairosEnabled) {
            const opts = options as {
              brief?: boolean
            }
            opts.brief = true
            setKairosActive(true)
            // 预播种一个进程内团队，以便 Agent(name: "foo") 生成
            // 队友时不需要 TeamCreate。必须在 setup() 捕获
            // teammateMode 快照之前运行（initializeAssistantTeam 内部调用
            // setCliTeammateModeOverride）。
            assistantTeamContext = await getAssistant().initializeAssistantTeam()
          }
        }
      }
      const {
        debug = false,
        debugToStderr = false,
        dangerouslySkipPermissions,
        allowDangerouslySkipPermissions = false,
        tools: baseTools = [],
        allowedTools = [],
        disallowedTools = [],
        mcpConfig = [],
        permissionMode: permissionModeCli,
        addDir = [],
        fallbackModel,
        betas = [],
        ide = false,
        sessionId,
        includeHookEvents,
        includePartialMessages,
      } = options
      if (options.prefill) {
        seedEarlyInput(options.prefill)
      }

      // Promise for file downloads - started early, awaited before REPL renders
      let fileDownloadPromise: Promise<DownloadResult[]> | undefined
      const agentsJson = options.agents
      const agentCli = options.agent
      if (feature('BG_SESSIONS') && agentCli) {
        process.env.ZY_CODE_AGENT = agentCli
      }

      // NOTE: LSP manager initialization is intentionally deferred until after
      // the trust dialog is accepted. This prevents plugin LSP servers from
      // executing code in untrusted directories before user consent.

      // 单独提取这些以便需要时可以修改
      let outputFormat = options.outputFormat
      let inputFormat = options.inputFormat
      let verbose = options.verbose ?? getGlobalConfig().verbose
      let print = options.print
      const init = options.init ?? false
      const initOnly = options.initOnly ?? false
      const maintenance = options.maintenance ?? false

      // 提取禁用斜杠命令标志
      const disableSlashCommands = options.disableSlashCommands || false

      // 提取任务模式选项（仅限 ant）
      const tasksOption =
        isInternalBuild() &&
        (
          options as {
            tasks?: boolean | string
          }
        ).tasks
      const taskListId = tasksOption
        ? typeof tasksOption === 'string'
          ? tasksOption
          : DEFAULT_TASKS_MODE_TASK_LIST_ID
        : undefined
      if (isInternalBuild() && taskListId) {
        process.env.ZY_CODE_TASK_LIST_ID = taskListId
      }

      // 提取 worktree 选项
      // worktree 可以是 true（不带值的标志）或字符串（自定义名称或 PR 引用）
      const worktreeOption = isWorktreeModeEnabled()
        ? (
            options as {
              worktree?: boolean | string
            }
          ).worktree
        : undefined
      let worktreeName = typeof worktreeOption === 'string' ? worktreeOption : undefined
      const worktreeEnabled = worktreeOption !== undefined

      // 检查 worktree 名称是否是 PR 引用（#N 或 GitHub PR URL）
      let worktreePRNumber: number | undefined
      if (worktreeName) {
        const prNum = parsePRReference(worktreeName)
        if (prNum !== null) {
          worktreePRNumber = prNum
          worktreeName = undefined // slug will be generated in setup()
        }
      }

      // 提取 tmux 选项（需要 --worktree）
      const tmuxEnabled =
        isWorktreeModeEnabled() &&
        (
          options as {
            tmux?: boolean
          }
        ).tmux === true

      // 验证 tmux 选项
      if (tmuxEnabled) {
        if (!worktreeEnabled) {
          process.stderr.write(chalk.red('Error: --tmux requires --worktree\n'))
          process.exit(1)
        }
        if (getPlatform() === 'windows') {
          process.stderr.write(chalk.red('Error: --tmux is not supported on Windows\n'))
          process.exit(1)
        }
        if (!(await isTmuxAvailable())) {
          process.stderr.write(
            chalk.red(`Error: tmux is not installed.\n${getTmuxInstallInstructions()}\n`),
          )
          process.exit(1)
        }
      }

      // 提取队友选项（用于 tmux 生成的代理）
      // 在 if 块外声明，以便稍后可用于系统提示附录
      let storedTeammateOpts: TeammateOptions | undefined
      if (isAgentSwarmsEnabled()) {
        // 提取代理身份选项（用于 tmux 生成的代理）
        // 这些替换了 ZY_CODE_* 环境变量
        const teammateOpts = extractTeammateOptions(options)
        storedTeammateOpts = teammateOpts

        // 如果提供了任何队友身份选项，则必须提供所有三个必需的选项
        const hasAnyTeammateOpt =
          teammateOpts.agentId || teammateOpts.agentName || teammateOpts.teamName
        const hasAllRequiredTeammateOpts =
          teammateOpts.agentId && teammateOpts.agentName && teammateOpts.teamName
        if (hasAnyTeammateOpt && !hasAllRequiredTeammateOpts) {
          process.stderr.write(
            chalk.red(
              'Error: --agent-id, --agent-name, and --team-name must all be provided together\n',
            ),
          )
          process.exit(1)
        }

        // 如果通过 CLI 提供了队友身份，则设置 dynamicTeamContext
        if (teammateOpts.agentId && teammateOpts.agentName && teammateOpts.teamName) {
          getTeammateUtils().setDynamicTeamContext?.({
            agentId: teammateOpts.agentId,
            agentName: teammateOpts.agentName,
            teamName: teammateOpts.teamName,
            color: teammateOpts.agentColor,
            planModeRequired: teammateOpts.planModeRequired ?? false,
            parentSessionId: teammateOpts.parentSessionId,
          })
        }

        // 如果提供了队友模式 CLI 覆盖，则设置
        // 这必须在 setup() 捕获快照之前完成
        if (teammateOpts.teammateMode) {
          getTeammateModeSnapshot().setCliTeammateModeOverride?.(teammateOpts.teammateMode)
        }
      }

      // 提取远程 SDK 选项
      const sdkUrl =
        (
          options as {
            sdkUrl?: string
          }
        ).sdkUrl ?? undefined

      // 允许环境变量启用部分消息（用于沙箱网关的 baku）
      const effectiveIncludePartialMessages =
        includePartialMessages || isEnvTruthy(process.env.ZY_CODE_INCLUDE_PARTIAL_MESSAGES)

      // 通过 SDK 选项明确要求时启用所有钩子事件类型
      // 或在 ZY_CODE_REMOTE 模式下运行时（CCR 需要它们）。
      // 否则，只发射 SessionStart 和 Setup 事件。
      if (includeHookEvents || isEnvTruthy(process.env.ZY_CODE_REMOTE)) {
        setAllHookEventsEnabled(true)
      }

      // 当提供 SDK URL 时自动设置输入/输出格式、详细模式和打印模式
      if (sdkUrl) {
        // 如果提供了 SDK URL，自动使用 stream-json 格式，除非明确设置
        if (!inputFormat) {
          inputFormat = 'stream-json'
        }
        if (!outputFormat) {
          outputFormat = 'stream-json'
        }
        // 自动启用详细模式，除非明确禁用或已设置
        if (options.verbose === undefined) {
          verbose = true
        }
        // 自动启用打印模式，除非明确禁用
        if (!options.print) {
          print = true
        }
      }

      // 提取 teleport 选项
      const teleport =
        (
          options as {
            teleport?: string | true
          }
        ).teleport ?? null

      // 提取 remote 选项（如果没有提供描述可以为 true，或为字符串）
      const remoteOption = (
        options as {
          remote?: string | true
        }
      ).remote
      const remote = remoteOption === true ? '' : (remoteOption ?? null)

      // 提取 --remote-control / --rc 标志（在交互会话中启用桥接）
      const remoteControlOption =
        (
          options as {
            remoteControl?: string | true
          }
        ).remoteControl ??
        (
          options as {
            rc?: string | true
          }
        ).rc
      // 实际的桥接检查延迟到 showSetupScreens() 之后，以便
      // 建立信任且 GrowthBook 有认证头。
      let remoteControl = false
      const remoteControlName =
        typeof remoteControlOption === 'string' && remoteControlOption.length > 0
          ? remoteControlOption
          : undefined

      // 如果提供了会话 ID，则验证它
      if (sessionId) {
        // 检查冲突的标志
        // --session-id 可以与 --continue 或 --resume 一起使用，当同时提供了 --fork-session 时
        //（用于指定叉会话的自定义 ID）
        if ((options.continue || options.resume) && !options.forkSession) {
          process.stderr.write(
            chalk.red(
              'Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.\n',
            ),
          )
          process.exit(1)
        }

        // 当提供 --sdk-url 时（桥接/远程模式），会话 ID 是
        // 服务器分配的标记 ID（例如 "session_local_01..."）而不是
        // UUID。跳过 UUID 验证和本地存在性检查。
        if (!sdkUrl) {
          const validatedSessionId = validateUuid(sessionId)
          if (!validatedSessionId) {
            process.stderr.write(chalk.red('Error: Invalid session ID. Must be a valid UUID.\n'))
            process.exit(1)
          }

          // 检查会话 ID 是否已存在
          if (sessionIdExists(validatedSessionId)) {
            process.stderr.write(
              chalk.red(`Error: Session ID ${validatedSessionId} is already in use.\n`),
            )
            process.exit(1)
          }
        }
      }

      // 如果通过 --file 标志指定了文件资源，则下载它们
      const fileSpecs = (
        options as {
          file?: string[]
        }
      ).file
      if (fileSpecs && fileSpecs.length > 0) {
        // 获取会话入口令牌（由 EnvManager 通过 ZY_CODE_SESSION_ACCESS_TOKEN 提供）
        const sessionToken = getSessionIngressAuthToken()
        if (!sessionToken) {
          process.stderr.write(
            chalk.red(
              'Error: Session token required for file downloads. ZY_CODE_SESSION_ACCESS_TOKEN must be set.\n',
            ),
          )
          process.exit(1)
        }

        // 解析会话 ID：优先使用远程会话 ID，回退到内部会话 ID
        const fileSessionId = process.env.ZY_CODE_REMOTE_SESSION_ID || getSessionId()
        const files = parseFileSpecs(fileSpecs)
        if (files.length > 0) {
          // 如果设置了 ANTHROPIC_BASE_URL（由 EnvManager 设置），否则使用 OAuth 配置
          // 这确保在所有环境中与会话入口 API 保持一致
          const config: FilesApiConfig = {
            baseUrl: process.env.ANTHROPIC_BASE_URL || getOauthConfig().BASE_API_URL,
            oauthToken: sessionToken,
            sessionId: fileSessionId,
          }

          // 开始下载而不阻塞启动 —— 在 REPL 渲染之前等待
          fileDownloadPromise = downloadSessionFiles(files, config)
        }
      }

      // 从状态获取 isNonInteractiveSession（在 init() 之前设置）
      const isNonInteractiveSession = getIsNonInteractiveSession()

      // 验证回退模型与主模型不同
      if (fallbackModel && options.model && fallbackModel === options.model) {
        process.stderr.write(
          chalk.red(
            'Error: Fallback model cannot be the same as the main model. Please specify a different model for --fallback-model.\n',
          ),
        )
        process.exit(1)
      }

      // 处理系统提示选项
      let systemPrompt = options.systemPrompt
      if (options.systemPromptFile) {
        if (options.systemPrompt) {
          process.stderr.write(
            chalk.red(
              'Error: Cannot use both --system-prompt and --system-prompt-file. Please use only one.\n',
            ),
          )
          process.exit(1)
        }
        try {
          const filePath = resolve(options.systemPromptFile)
          systemPrompt = readFileSync(filePath, 'utf8')
        } catch (error) {
          const code = getErrnoCode(error)
          if (code === 'ENOENT') {
            process.stderr.write(
              chalk.red(
                `Error: System prompt file not found: ${resolve(options.systemPromptFile)}\n`,
              ),
            )
            process.exit(1)
          }
          process.stderr.write(
            chalk.red(`Error reading system prompt file: ${errorMessage(error)}\n`),
          )
          process.exit(1)
        }
      }

      // 处理附加系统提示选项
      let appendSystemPrompt = options.appendSystemPrompt
      if (options.appendSystemPromptFile) {
        if (options.appendSystemPrompt) {
          process.stderr.write(
            chalk.red(
              'Error: Cannot use both --append-system-prompt and --append-system-prompt-file. Please use only one.\n',
            ),
          )
          process.exit(1)
        }
        try {
          const filePath = resolve(options.appendSystemPromptFile)
          appendSystemPrompt = readFileSync(filePath, 'utf8')
        } catch (error) {
          const code = getErrnoCode(error)
          if (code === 'ENOENT') {
            process.stderr.write(
              chalk.red(
                `Error: Append system prompt file not found: ${resolve(options.appendSystemPromptFile)}\n`,
              ),
            )
            process.exit(1)
          }
          process.stderr.write(
            chalk.red(`Error reading append system prompt file: ${errorMessage(error)}\n`),
          )
          process.exit(1)
        }
      }

      // 为 tmux 队友添加队友特定的系统提示附录
      if (
        isAgentSwarmsEnabled() &&
        storedTeammateOpts?.agentId &&
        storedTeammateOpts?.agentName &&
        storedTeammateOpts?.teamName
      ) {
        const addendum = getTeammatePromptAddendum().TEAMMATE_SYSTEM_PROMPT_ADDENDUM
        appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${addendum}` : addendum
      }
      const { mode: permissionMode, notification: permissionModeNotification } =
        initialPermissionModeFromCLI({
          permissionModeCli,
          dangerouslySkipPermissions,
        })

      // 存储会话绕过权限模式以进行信任对话框检查
      setSessionBypassPermissionsMode(permissionMode === 'bypassPermissions')
      if (feature('TRANSCRIPT_CLASSIFIER')) {
        // autoModeFlagCli 是"用户本次会话是否打算使用 auto"的信号。
        // 当以下情况时设置：--enable-auto-mode、--permission-mode auto、解析的
        // 模式是 auto，或设置 defaultMode 是 auto 但门拒绝它
        //（permissionMode 解析为默认，没有明确的 CLI 覆盖）。
        // 由 verifyAutoModeGateAccess 决定是否在
        // auto-unavailable 时通知，以及由 zy_auto_mode_config opt-in carousel 使用。
        if (
          (
            options as {
              enableAutoMode?: boolean
            }
          ).enableAutoMode ||
          permissionModeCli === 'auto' ||
          permissionMode === 'auto' ||
          (!permissionModeCli && isDefaultPermissionModeAuto())
        ) {
          autoModeStateModule?.setAutoModeFlagCli(true)
        }
      }

      // 如果提供了 MCP 配置文件/字符串，则解析它们
      let dynamicMcpConfig: Record<string, ScopedMcpServerConfig> = {}
      if (mcpConfig && mcpConfig.length > 0) {
        // 处理 mcpConfig 数组
        const processedConfigs = mcpConfig
          .map((config) => config.trim())
          .filter((config) => config.length > 0)
        let allConfigs: Record<string, McpServerConfig> = {}
        const allErrors: ValidationError[] = []
        for (const configItem of processedConfigs) {
          let configs: Record<string, McpServerConfig> | null = null
          let errors: ValidationError[] = []

          // 首先尝试解析为 JSON 字符串
          const parsedJson = safeParseJSON(configItem)
          if (parsedJson) {
            const result = parseMcpConfig({
              configObject: parsedJson,
              filePath: 'command line',
              expandVars: true,
              scope: 'dynamic',
            })
            if (result.config) {
              configs = result.config.mcpServers
            } else {
              errors = result.errors
            }
          } else {
            // 尝试作为文件路径
            const configPath = resolve(configItem)
            const result = parseMcpConfigFromFilePath({
              filePath: configPath,
              expandVars: true,
              scope: 'dynamic',
            })
            if (result.config) {
              configs = result.config.mcpServers
            } else {
              errors = result.errors
            }
          }
          if (errors.length > 0) {
            allErrors.push(...errors)
          } else if (configs) {
            // 合并配置，后面的覆盖前面的
            allConfigs = {
              ...allConfigs,
              ...configs,
            }
          }
        }
        if (allErrors.length > 0) {
          const formattedErrors = allErrors
            .map((err) => `${err.path ? err.path + ': ' : ''}${err.message}`)
            .join('\n')
          logForDebugging(
            `--mcp-config validation failed (${allErrors.length} errors): ${formattedErrors}`,
            {
              level: 'error',
            },
          )
          process.stderr.write(`Error: Invalid MCP configuration:\n${formattedErrors}\n`)
          process.exit(1)
        }
        if (Object.keys(allConfigs).length > 0) {
          // SDK 主机（Nest/Desktop）拥有自己的服务器命名权，并且可以重用
          // 内置名称 —— 跳过 type:'sdk' 的保留名称检查。
          const nonSdkConfigNames = Object.entries(allConfigs)
            .filter(([, config]) => config.type !== 'sdk')
            .map(([name]) => name)
          let reservedNameError: string | null = null
          if (nonSdkConfigNames.some(isClaudeInChromeMCPServer)) {
            reservedNameError = `Invalid MCP configuration: "${CLAUDE_IN_CHROME_MCP_SERVER_NAME}" is a reserved MCP name.`
          } else if (feature('CHICAGO_MCP')) {
            const { isComputerUseMCPServer, COMPUTER_USE_MCP_SERVER_NAME } = await import(
              'src/utils/computerUse/common.js'
            )
            if (nonSdkConfigNames.some(isComputerUseMCPServer)) {
              reservedNameError = `Invalid MCP configuration: "${COMPUTER_USE_MCP_SERVER_NAME}" is a reserved MCP name.`
            }
          }
          if (reservedNameError) {
            // stderr+exit(1) — a throw here becomes a silent unhandled
            // rejection in stream-json mode (void main() in cli.tsx).
            process.stderr.write(`Error: ${reservedNameError}\n`)
            process.exit(1)
          }

          // 向所有配置添加动态范围。type:'sdk' 条目直接传递
          // 不变 —— 它们在下游被提取到 sdkMcpConfigs 中并
          // 传递给 print.ts。Python SDK 依赖此路径（它不在
          // 初始化消息中发送 sdkMcpServers）。在此处丢弃它们会
          // 破坏 Coworker（inc-5122）。策略过滤器下面已经豁免了
          // type:'sdk'，并且没有 SDK 传输时这些条目在 stdin 上是
          // 无效的，所以让它们通过不会有绕过风险。
          const scopedConfigs = mapValues(allConfigs, (config) => ({
            ...config,
            scope: 'dynamic' as const,
          }))

          // 对 --mcp-config 服务器执行托管策略（allowedMcpServers / deniedMcpServers）。
          // 没有这个，CLI 标志会绕过 user/project/local 配置在
          // getZyCodeMcpConfigs 中通过的企业允许列表 —— 调用者将 dynamicMcpConfig
          // 扩展回过滤后的结果之上。在此源处过滤以便所有
          // 下游消费者看到经过策略过滤的集合。
          const { allowed, blocked } = filterMcpServersByPolicy(scopedConfigs)
          if (blocked.length > 0) {
            process.stderr.write(
              `Warning: MCP ${plural(blocked.length, 'server')} blocked by enterprise policy: ${blocked.join(', ')}\n`,
            )
          }
          dynamicMcpConfig = {
            ...dynamicMcpConfig,
            ...allowed,
          }
        }
      }

      // 提取 Claude in Chrome 选项并强制 zy.ai 订阅者检查（除非用户是 ant）
      const chromeOpts = options as {
        chrome?: boolean
      }
      // 存储明确的 CLI 标志以便队友可以继承它
      setChromeFlagOverride(chromeOpts.chrome)
      const enableClaudeInChrome =
        shouldEnableClaudeInChrome(chromeOpts.chrome) && isInternalBuild()
      const autoEnableClaudeInChrome = !enableClaudeInChrome && shouldAutoEnableClaudeInChrome()
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
          const hint =
            feature('WEB_BROWSER_TOOL') && typeof Bun !== 'undefined' && 'WebView' in Bun
              ? CLAUDE_IN_CHROME_SKILL_HINT_WITH_WEBBROWSER
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
            chalk.red(
              'You cannot use --strict-mcp-config when an enterprise MCP config is present',
            ),
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
      if (feature('CHICAGO_MCP') && getPlatform() === 'macos' && !getIsNonInteractiveSession()) {
        try {
          const { getChicagoEnabled } = await import('src/utils/computerUse/gates.js')
          if (getChicagoEnabled()) {
            const { setupComputerUseMCP } = await import('src/utils/computerUse/setup.js')
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

      // 存储额外目录用于 CLAUDE.md 加载（由 env var 控制）
      setAdditionalDirectoriesForzyMd(addDir)

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
        const channelOpts = options as {
          channels?: string[]
          dangerouslyLoadDevelopmentChannels?: string[]
        }
        const rawChannels = channelOpts.channels
        const rawDev = channelOpts.dangerouslyLoadDevelopmentChannels
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
          require('./tools/BriefTool/prompt.js') as typeof import('./tools/BriefTool/prompt.js')
        const { isBriefEntitled } =
          require('./tools/BriefTool/BriefTool.js') as typeof import('./tools/BriefTool/BriefTool.js')
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
      if (feature('TRANSCRIPT_CLASSIFIER') && dangerousPermissions.length > 0) {
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
      let inputPrompt = await getInputPrompt(
        effectivePrompt,
        (inputFormat ?? 'text') as 'text' | 'stream-json',
      )

      profileCheckpoint('action_after_input_prompt')

      // 在 getTools() 之前激活主动模式，以便 SleepTool.isEnabled()
      //（返回 isProactiveActive()）通过并包含 Sleep。
      // 稍后 REPL 路径的 maybeActivateProactive() 调用是幂等的。
      maybeActivateProactive(options)
      let tools = getTools(toolPermissionContext)

      // 为无头路径应用协调器模式工具过滤
      //（镜像 useMergedTools.ts 对 REPL/交互路径的过滤）
      if (feature('COORDINATOR_MODE') && isEnvTruthy(process.env.ZY_CODE_COORDINATOR_MODE)) {
        const { applyCoordinatorToolFilter } = await import('./utils/toolPool.js')
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
            schema_property_count: Object.keys(
              (jsonSchema.properties as Record<string, unknown>) || {},
            ).length as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            has_required_fields: Boolean(
              jsonSchema.required,
            ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
        } else {
          logEvent('zy_structured_output_failure', {
            error:
              'Invalid JSON schema' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
        }
      }

      // 重要：setup() 必须在任何其他依赖 cwd 或 worktree 设置的代码之前调用

      profileCheckpoint('action_before_setup')
      logForDebugging('[STARTUP] Running setup()...')
      const setupStart = Date.now()
      const { setup } = await import('./setup.js')
      const messagingSocketPath = feature('UDS_INBOX')
        ? (
            options as {
              messagingSocketPath?: string
            }
          ).messagingSocketPath
        : undefined
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
      const agentDefsPromise = worktreeEnabled
        ? null
        : getAgentDefinitionsWithOverrides(preSetupCwd)
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
          effectiveReplayUserMessages = !!(
            options as {
              messagingSocketPath?: string
            }
          ).messagingSocketPath
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
        // managedEnv.ts:86 的 getSettings_DEPRECATED，它合并了所有启用的
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
        // 中的 fs.readFile）自然让出，所以 CLAUDE.md 目录遍历
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
        getGlobalConfig().cachedGrowthBookFeatures?.['zy_ant_model_override'] == null
      ) {
        await initializeGrowthBook()
      }

      // 用 null 关键字特殊处理默认模型
      // NOTE: Model resolution happens after setup() to ensure trust is established before AWS auth
      const userSpecifiedModel =
        options.model === 'default' ? getDefaultMainLoopModel() : options.model
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
      if (agentSetting) {
        mainThreadAgentDefinition = agentDefinitions.activeAgents.find(
          (agent) => agent.agentType === agentSetting,
        )
        if (!mainThreadAgentDefinition) {
          logForDebugging(
            `Warning: agent "${agentSetting}" not found. ` +
              `Available agents: ${agentDefinitions.activeAgents.map((a) => a.agentType).join(', ')}. ` +
              `Using default behavior.`,
          )
        }
      }

      // 将主线程代理类型存储在引导状态中，以便钩子可以访问它
      setMainThreadAgentType(mainThreadAgentDefinition?.agentType)

      // 记录代理标志使用情况 —— 仅为内置代理记录代理名称，以避免泄露自定义代理名称
      if (mainThreadAgentDefinition) {
        logEvent('zy_agent_flag', {
          agentType: isBuiltInAgent(mainThreadAgentDefinition)
            ? (mainThreadAgentDefinition.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
            : ('custom' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
          ...(agentCli && {
            source: 'cli' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          }),
        })
      }

      // 将代理设置持久化到会话转录中，以便恢复视图显示和恢复
      if (mainThreadAgentDefinition?.agentType) {
        saveAgentSetting(mainThreadAgentDefinition.agentType)
      }

      // 为非交互会话应用代理的系统提示
      //（交互模式使用 buildEffectiveSystemPrompt）
      if (
        isNonInteractiveSession &&
        mainThreadAgentDefinition &&
        !systemPrompt &&
        !isBuiltInAgent(mainThreadAgentDefinition)
      ) {
        const agentSystemPrompt = mainThreadAgentDefinition.getSystemPrompt()
        if (agentSystemPrompt) {
          systemPrompt = agentSystemPrompt
        }
      }

      // initialPrompt 放在前面以便其斜杠命令（如果有）被处理；
      // 用户提供的文本变成尾部上下文。
      // 仅在 inputPrompt 是字符串时连接。当它是
      // AsyncIterable（SDK stream-json 模式）时，模板插值会
      // 调用 .toString() 产生 "[object Object]"。AsyncIterable 情况
      // 在 print.ts 中通过 structuredIO.prependUserMessage() 处理。
      if (mainThreadAgentDefinition?.initialPrompt) {
        if (typeof inputPrompt === 'string') {
          inputPrompt = inputPrompt
            ? `${mainThreadAgentDefinition.initialPrompt}\n\n${inputPrompt}`
            : mainThreadAgentDefinition.initialPrompt
        } else if (!inputPrompt) {
          inputPrompt = mainThreadAgentDefinition.initialPrompt
        }
      }

      // 早期计算有效模型，以便钩子可以与 MCP 并行运行
      // 如果用户没有指定模型但代理有一个，使用代理的模型
      let effectiveModel = userSpecifiedModel
      if (
        !effectiveModel &&
        mainThreadAgentDefinition?.model &&
        mainThreadAgentDefinition.model !== 'inherit'
      ) {
        effectiveModel = parseUserSpecifiedModel(mainThreadAgentDefinition.model)
      }
      setMainLoopModelOverride(effectiveModel)

      // 为钩子计算解析的模型（使用启动时用户指定的模型）
      setInitialMainLoopModel(getUserSpecifiedModelSetting() || null)
      const initialMainLoopModel = getInitialMainLoopModel()
      const resolvedInitialModelInput = initialMainLoopModel ?? getDefaultMainLoopModel()
      const resolvedInitialModel = resolvedInitialModelInput
        ? parseUserSpecifiedModel(resolvedInitialModelInput)
        : ''
      let advisorModel: string | undefined
      if (isAdvisorEnabled()) {
        const advisorOption = canUserConfigureAdvisor()
          ? (
              options as {
                advisor?: string
              }
            ).advisor
          : undefined
        if (advisorOption) {
          logForDebugging(`[AdvisorTool] --advisor ${advisorOption}`)
          if (!modelSupportsAdvisor(resolvedInitialModel)) {
            process.stderr.write(
              chalk.red(
                `Error: The model "${resolvedInitialModel}" does not support the advisor tool.\n`,
              ),
            )
            process.exit(1)
          }
          const normalizedAdvisorModel = normalizeModelStringForAPI(
            parseUserSpecifiedModel(advisorOption),
          )
          if (!isValidAdvisorModel(normalizedAdvisorModel)) {
            process.stderr.write(
              chalk.red(`Error: The model "${advisorOption}" cannot be used as an advisor.\n`),
            )
            process.exit(1)
          }
        }
        advisorModel = canUserConfigureAdvisor()
          ? (advisorOption ?? getInitialAdvisorSetting())
          : advisorOption
        if (advisorModel) {
          logForDebugging(`[AdvisorTool] Advisor model: ${advisorModel}`)
        }
      }

      // 对于带有 --agent-type 的 tmux 队友，附加自定义代理的提示
      if (
        isAgentSwarmsEnabled() &&
        storedTeammateOpts?.agentId &&
        storedTeammateOpts?.agentName &&
        storedTeammateOpts?.teamName &&
        storedTeammateOpts?.agentType
      ) {
        // 查找自定义代理定义
        const customAgent = agentDefinitions.activeAgents.find(
          (a) => a.agentType === storedTeammateOpts.agentType,
        )
        if (customAgent) {
          // 获取提示 —— 需要处理内置和自定义代理
          let customPrompt: string | undefined
          if (customAgent.source === 'built-in') {
            // 内置代理有接受 toolUseContext 的 getSystemPrompt
            // 我们在这里无法访问完整的 toolUseContext，所以暂时跳过
            logForDebugging(
              `[teammate] Built-in agent ${storedTeammateOpts.agentType} - skipping custom prompt (not supported)`,
            )
          } else {
            // 自定义代理有不接受参数的 getSystemPrompt
            customPrompt = customAgent.getSystemPrompt()
          }

          // 为 tmux 队友记录代理内存加载事件
          if (customAgent.memory) {
            logEvent('zy_agent_memory_loaded', {
              ...(isInternalBuild() && {
                agent_type:
                  customAgent.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              }),
              scope:
                customAgent.memory as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              source: 'teammate' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
          }
          if (customPrompt) {
            const customInstructions = `\n# Custom Agent Instructions\n${customPrompt}`
            appendSystemPrompt = appendSystemPrompt
              ? `${appendSystemPrompt}\n\n${customInstructions}`
              : customInstructions
          }
        } else {
          logForDebugging(
            `[teammate] Custom agent ${storedTeammateOpts.agentType} not found in available agents`,
          )
        }
      }
      maybeActivateBrief(options)
      // defaultView: 'chat' 是持久化的选择加入 —— 检查授权并设置
      // userMsgOptIn 以便工具 + 提示部分激活。仅限交互：
      // defaultView 是显示偏好；SDK 会话没有显示，并且
      // 助手安装程序将 defaultView:'chat' 写入 settings.local.json
      // 否则会泄漏到同一目录中的 --print 会话。
      // 在 maybeActivateBrief() 之后立即运行，以便所有启动选择加入路径触发
      // 在任何 isBriefEnabled() 读取之前（主动提示的
      // briefVisibility）。GB 关闭开关后的持久化 'chat' 会
      // 透传（授权失败）。
      if (
        (feature('KAIROS') || feature('KAIROS_BRIEF')) &&
        !getIsNonInteractiveSession() &&
        !getUserMsgOptIn() &&
        getInitialSettings().defaultView === 'chat'
      ) {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const { isBriefEntitled } =
          require('./tools/BriefTool/BriefTool.js') as typeof import('./tools/BriefTool/BriefTool.js')
        /* eslint-enable @typescript-eslint/no-require-imports */
        if (isBriefEntitled()) {
          setUserMsgOptIn(true)
        }
      }
      // 协调器模式有自己的系统提示并过滤掉 Sleep，所以
      // 通用主动提示会告诉它调用它无法访问的工具
      // 并与委托指令冲突。
      if (
        (feature('PROACTIVE') || feature('KAIROS')) &&
        ((
          options as {
            proactive?: boolean
          }
        ).proactive ||
          isEnvTruthy(process.env.ZY_CODE_PROACTIVE)) &&
        !coordinatorModeModule?.isCoordinatorMode()
      ) {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const briefVisibility =
          feature('KAIROS') || feature('KAIROS_BRIEF')
            ? (
                require('./tools/BriefTool/BriefTool.js') as typeof import('./tools/BriefTool/BriefTool.js')
              ).isBriefEnabled()
              ? 'Call SendUserMessage at checkpoints to mark where things stand.'
              : 'The user will see any text you output.'
            : 'The user will see any text you output.'
        /* eslint-enable @typescript-eslint/no-require-imports */
        const proactivePrompt = `\n# Proactive Mode\n\nYou are in proactive mode. Take initiative — explore, act, and make progress without waiting for instructions.\n\nStart by briefly greeting the user.\n\nYou will receive periodic <tick> prompts. These are check-ins. Do whatever seems most useful, or call Sleep if there's nothing to do. ${briefVisibility}`
        appendSystemPrompt = appendSystemPrompt
          ? `${appendSystemPrompt}\n\n${proactivePrompt}`
          : proactivePrompt
      }
      if (feature('KAIROS') && kairosEnabled && assistantModule) {
        const assistantAddendum = assistantModule.getAssistantSystemPromptAddendum()
        appendSystemPrompt = appendSystemPrompt
          ? `${appendSystemPrompt}\n\n${assistantAddendum}`
          : assistantAddendum
      }

      // Ink 根仅在交互会话中需要 —— Ink 构造函数中的
      // patchConsole 会在无头模式下吞掉控制台输出。
      let root!: Root
      let getFpsMetrics!: () => FpsMetrics | undefined
      let stats!: StatsStore

      // 在命令加载后显示设置屏幕
      if (!isNonInteractiveSession) {
        const ctx = getRenderContext(false)
        getFpsMetrics = ctx.getFpsMetrics
        stats = ctx.stats
        // 在 Ink 挂载之前安装 asciicast 录制器（仅限 ant，通过 ZY_CODE_TERMINAL_RECORDING=1 选择加入）
        if (isInternalBuild()) {
          installAsciicastRecorder()
        }

        const { createRoot } = await import('./ink.js')
        root = await createRoot(ctx.renderOptions)

        // 现在记录启动时间，在任何阻塞对话框渲染之前。从
        // REPL 首次渲染（旧位置）记录包括了用户坐在
        // 信任/OAuth/入门/恢复选择器上的时间 —— p99 约 70s
        // 由对话框等待时间主导，而不是代码路径启动时间。
        logEvent('zy_timer', {
          event: 'startup' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          durationMs: Math.round(process.uptime() * 1000),
        })
        logForDebugging('[STARTUP] Running showSetupScreens()...')

        const setupScreensStart = Date.now()
        const onboardingShown = await showSetupScreens(
          root,
          permissionMode,
          allowDangerouslySkipPermissions,
          commands,
          enableClaudeInChrome,
          devChannels,
        )

        logForDebugging(
          `[STARTUP] showSetupScreens() completed in ${Date.now() - setupScreensStart}ms`,
        )

        // 现在信任已建立且 GrowthBook 有认证头，
        // 解析 --remote-control / --rc 授权门。
        if (feature('BRIDGE_MODE') && remoteControlOption !== undefined) {
          const { getBridgeDisabledReason } = await import('./bridge/bridgeEnabled.js')
          const disabledReason = await getBridgeDisabledReason()
          remoteControl = disabledReason === null
          if (disabledReason) {
            process.stderr.write(chalk.yellow(`${disabledReason}\n--rc flag ignored.\n`))
          }
        }

        // 检查待处理的代理内存快照更新（仅限 --agent 模式，仅限 ant）
        if (
          feature('AGENT_MEMORY_SNAPSHOT') &&
          mainThreadAgentDefinition &&
          isCustomAgent(mainThreadAgentDefinition) &&
          mainThreadAgentDefinition.memory &&
          mainThreadAgentDefinition.pendingSnapshotUpdate
        ) {
          const agentDef = mainThreadAgentDefinition
          const choice = await launchSnapshotUpdateDialog(root, {
            agentType: agentDef.agentType,
            scope: agentDef.memory!,
            snapshotTimestamp: agentDef.pendingSnapshotUpdate!.snapshotTimestamp,
          })
          if (choice === 'merge') {
            const {
              // @ts-ignore
              buildMergePrompt,
            } = await import('./components/agents/SnapshotUpdateDialog.js')
            const mergePrompt = (buildMergePrompt as any)(agentDef.agentType, agentDef.memory!)
            inputPrompt = inputPrompt ? `${mergePrompt}\n\n${inputPrompt}` : mergePrompt
          }
          agentDef.pendingSnapshotUpdate = undefined
        }

        // 如果刚刚完成了入门培训，则跳过执行 /login
        if (onboardingShown && prompt?.trim().toLowerCase() === '/login') {
          prompt = ''
        }
        if (onboardingShown) {
          // 现在刷新认证依赖的服务，因为用户在入门培训期间已登录
          // 与 src/commands/login.tsx 中的登录后逻辑保持一致
          void refreshRemoteManagedSettings()
          void refreshPolicyLimits()
          // 在 GrowthBook 刷新之前清除用户数据缓存，以便它获取新鲜凭证
          resetUserCache()
          // 登录后刷新 GrowthBook 以获取更新的功能标志（例如用于 zy.ai MCP）
          refreshGrowthBookAfterAuthChange()
          // 清除任何过时的受信任设备令牌，然后注册远程控制。
          // 两者都在内部通过 zy_sessions_elevated_auth_enforcement 自门控
          // —— enrollTrustedDevice() 通过 checkGate_CACHED_OR_BLOCKING（等待
          // 上方的 GrowthBook 重新初始化），clearTrustedDeviceToken() 通过
          // 同步缓存检查（可接受，因为清除是幂等的）。
          void import('./bridge/trustedDevice.js').then((m) => {
            m.clearTrustedDeviceToken()
            return m.enrollTrustedDevice()
          })
          // Onboarding 写入了 settings.json（包括 models 和 mainLoopModel），
          // 需要刷新 settings 缓存并重新解析模型。
          resetSettingsCache()
          const postOnboardingModel = getDefaultMainLoopModelSetting()
          setInitialMainLoopModel(postOnboardingModel as ModelSetting)
        }

        // 验证活动令牌的 org 是否匹配 forceLoginOrgUUID（如果在托管设置中设置）。
        // 在入门培训之后运行，以便托管设置和登录状态完全加载。
        const orgValidation = await validateForceLoginOrg()
        if (!orgValidation.valid) {
          await exitWithError(root, (orgValidation as any).message)
        }
      }

      // 如果启动了 gracefulShutdown（例如用户拒绝了信任对话框），
      // process.exitCode 将被设置。跳过所有可能触发代码执行的后续操作
      // 在进程退出之前（例如，如果未建立信任，我们不希望 apiKeyHelper 运行）。
      if (process.exitCode !== undefined) {
        logForDebugging('Graceful shutdown initiated, skipping further initialization')
        return
      }

      // 在建立信任后初始化 LSP 管理器（或在非交互模式中
      // 信任是隐式的）。这防止插件 LSP 服务器在用户同意之前
      // 在不可信的目录中执行代码。
      // 必须在设置内联插件之后（如果有）以便 --plugin-dir LSP 服务器被包含。
      initializeLspServerManager()

      // 在建立信任后显示设置验证错误
      // MCP 配置错误不会阻止设置加载，所以排除它们
      if (!isNonInteractiveSession) {
        const { errors } = getSettingsWithErrors()
        const nonMcpErrors = errors.filter((e) => !e.mcpErrorMetadata)
        if (nonMcpErrors.length > 0) {
          await launchInvalidSettingsDialog(root, {
            settingsErrors: nonMcpErrors,
            onExit: () => gracefulShutdownSync(1),
          })
        }
      }

      // 在建立信任后检查配额状态、passes 资格和引导数据
      // 这些进行 API 调用，可能触发 apiKeyHelper 执行。
      // --bare / SIMPLE：跳过 —— 这些是 REPL 首次响应性的缓存预热
      //（配额、passes、引导数据）。
      const bgRefreshThrottleMs = getFeatureValue_CACHED_MAY_BE_STALE('zy_cicada_nap_ms', 0)
      const lastPrefetched = getGlobalConfig().startupPrefetchedAt ?? 0
      const skipStartupPrefetches =
        isBareMode() ||
        (bgRefreshThrottleMs > 0 && Date.now() - lastPrefetched < bgRefreshThrottleMs)
      if (!skipStartupPrefetches) {
        const lastPrefetchedInfo =
          lastPrefetched > 0
            ? ` last ran ${Math.round((Date.now() - lastPrefetched) / 1000)}s ago`
            : ''
        logForDebugging(`Starting background startup prefetches${lastPrefetchedInfo}`)
        checkQuotaStatus().catch((error) => logError(error))

        // 从服务器获取引导数据并更新所有缓存值。
        void fetchBootstrapData()

        // TODO: Consolidate other prefetches into a single bootstrap request.
        if (bgRefreshThrottleMs > 0) {
          saveGlobalConfig((current) => ({
            ...current,
            startupPrefetchedAt: Date.now(),
          }))
        }
      } else {
        logForDebugging(
          `Skipping startup prefetches, last ran ${Math.round((Date.now() - lastPrefetched) / 1000)}s ago`,
        )
      }
      if (!isNonInteractiveSession) {
        void refreshExampleCommands() // 预取示例命令（运行 git log，无 API 调用）
      }

      // 解析 MCP 配置（早期启动，与 setup/信任对话框工作重叠）
      const { servers: existingMcpConfigs } = await mcpConfigPromise
      logForDebugging(
        `[STARTUP] MCP configs resolved in ${mcpConfigResolvedMs}ms (awaited at +${Date.now() - mcpConfigStart}ms)`,
      )
      // CLI 标志（--mcp-config）应覆盖基于文件的配置，与设置优先级匹配
      const allMcpConfigs = {
        ...existingMcpConfigs,
        ...dynamicMcpConfig,
      }

      // 将 SDK 配置与普通 MCP 配置分开
      const sdkMcpConfigs: Record<string, McpSdkServerConfig> = {}
      const regularMcpConfigs: Record<string, ScopedMcpServerConfig> = {}
      for (const [name, config] of Object.entries(allMcpConfigs)) {
        const typedConfig = config as ScopedMcpServerConfig | McpSdkServerConfig
        if (typedConfig.type === 'sdk') {
          sdkMcpConfigs[name] = typedConfig as McpSdkServerConfig
        } else {
          regularMcpConfigs[name] = typedConfig as ScopedMcpServerConfig
        }
      }

      profileCheckpoint('action_mcp_configs_loaded')

      // 在信任对话框之后预取 MCP 资源（这是执行发生的地方）。
      // 仅限交互模式：打印模式延迟连接直到 headlessStore 存在
      // 并按服务器推送（下方），所以 ToolSearch 的 pending-client 处理有效
      // 且一个慢速服务器不会阻塞批次。
      const localMcpPromise = isNonInteractiveSession
        ? Promise.resolve({
            clients: [],
            tools: [],
            commands: [],
          })
        : prefetchAllMcpResources(regularMcpConfigs)
      const zyaiMcpPromise = isNonInteractiveSession
        ? Promise.resolve({
            clients: [],
            tools: [],
            commands: [],
          })
        : zyaiConfigPromise.then((configs) =>
            Object.keys(configs).length > 0
              ? prefetchAllMcpResources(configs)
              : {
                  clients: [],
                  tools: [],
                  commands: [],
                },
          )
      // 按名称去重合并：每个 prefetchAllMcpResources 调用独立
      // 添加帮助工具（ListMcpResourcesTool、ReadMcpResourceTool）通过
      // 本地去重标志，所以合并两个调用可能产生重复。print.ts
      // 已经对最终工具池进行 uniqBy 处理，但在此去重保持 appState 干净。
      const mcpPromise = Promise.all([localMcpPromise, zyaiMcpPromise]).then(([local, zyai]) => ({
        clients: [...local.clients, ...zyai.clients],
        tools: uniqBy([...local.tools, ...zyai.tools], 'name'),
        commands: uniqBy([...local.commands, ...zyai.commands], 'name'),
      }))

      // 早期启动钩子以便它们与 MCP 连接并行运行。
      // 跳过 initOnly/init/maintenance（单独处理）、非交互
      //（通过 setupTrigger 处理）和 resume/continue（conversationRecovery.ts
      // 改为触发 'resume' —— 没有这个守卫，钩子在 /resume 上触发两次
      // 且第二个 systemMessage 覆盖第一个。gh-30825）
      const hooksPromise =
        initOnly ||
        init ||
        maintenance ||
        isNonInteractiveSession ||
        options.continue ||
        options.resume
          ? null
          : processSessionStartHooks('startup', {
              agentType: mainThreadAgentDefinition?.agentType,
              model: resolvedInitialModel,
            })

      // MCP 从不阻塞 REPL 渲染或第 1 轮 TTFT。useManageMCPConnections
      // 在服务器连接时异步填充 appState.mcp（connectToServer 是
      // 缓存的 —— 上方的预取调用和钩子汇聚到相同的
      // 连接）。getToolUseContext 通过 computeTools() 新鲜读取 store.getState()，
      // 所以第 1 轮看到查询时已连接的任何内容。
      // 慢速服务器为第 2+ 轮填充。匹配交互无提示
      // 行为。打印模式：按服务器推送到 headlessStore（下方）。
      const hookMessages: Awaited<NonNullable<typeof hooksPromise>> = []
      // 抑制瞬态 unhandledRejection —— 预取预热
      // 缓存的 connectToServer 缓存，但在交互模式下没有人等待它。
      mcpPromise.catch(() => {})
      const mcpClients: Awaited<typeof mcpPromise>['clients'] = []
      const mcpTools: Awaited<typeof mcpPromise>['tools'] = []
      const mcpCommands: Awaited<typeof mcpPromise>['commands'] = []
      let thinkingEnabled = shouldEnableThinkingByDefault()
      let thinkingConfig: ThinkingConfig =
        thinkingEnabled !== false
          ? {
              type: 'adaptive',
            }
          : {
              type: 'disabled',
            }
      if (options.thinking === 'adaptive' || options.thinking === 'enabled') {
        thinkingEnabled = true
        thinkingConfig = {
          type: 'adaptive',
        }
      } else if (options.thinking === 'disabled') {
        thinkingEnabled = false
        thinkingConfig = {
          type: 'disabled',
        }
      } else {
        const maxThinkingTokens = process.env.MAX_THINKING_TOKENS
          ? parseInt(process.env.MAX_THINKING_TOKENS, 10)
          : options.maxThinkingTokens
        if (maxThinkingTokens !== undefined) {
          if (maxThinkingTokens > 0) {
            thinkingEnabled = true
            thinkingConfig = {
              type: 'enabled',
              budgetTokens: maxThinkingTokens,
            }
          } else if (maxThinkingTokens === 0) {
            thinkingEnabled = false
            thinkingConfig = {
              type: 'disabled',
            }
          }
        }
      }
      logForDiagnosticsNoPII('info', 'started', {
        version: MACRO.VERSION,
        is_native_binary: isInBundledMode(),
      })
      registerCleanup(async () => {
        logForDiagnosticsNoPII('info', 'exited')
      })
      void logTenguInit({
        hasInitialPrompt: Boolean(prompt),
        hasStdin: Boolean(inputPrompt),
        verbose,
        debug,
        debugToStderr,
        print: print ?? false,
        outputFormat: outputFormat ?? 'text',
        inputFormat: inputFormat ?? 'text',
        numAllowedTools: allowedTools.length,
        numDisallowedTools: disallowedTools.length,
        mcpClientCount: Object.keys(allMcpConfigs).length,
        worktreeEnabled,
        skipWebFetchPreflight: getInitialSettings().skipWebFetchPreflight,
        githubActionInputs: process.env.GITHUB_ACTION_INPUTS,
        dangerouslySkipPermissionsPassed: dangerouslySkipPermissions ?? false,
        permissionMode,
        modeIsBypass: permissionMode === 'bypassPermissions',
        allowDangerouslySkipPermissionsPassed: allowDangerouslySkipPermissions,
        systemPromptFlag: systemPrompt ? (options.systemPromptFile ? 'file' : 'flag') : undefined,
        appendSystemPromptFlag: appendSystemPrompt
          ? options.appendSystemPromptFile
            ? 'file'
            : 'flag'
          : undefined,
        thinkingConfig,
        assistantActivationPath:
          feature('KAIROS') && kairosEnabled
            ? assistantModule?.getAssistantActivationPath()
            : undefined,
      })

      // 初始化时记录一次上下文指标
      void logContextMetrics(regularMcpConfigs, toolPermissionContext)
      void logPermissionContextForAnts(null, 'initialization')
      logManagedSettings()

      // 注册 PID 文件用于并发会话检测（~/.zy/sessions/）
      // 并触发多 clauding 遥测。放在这里（不是 init.ts）以便只有
      // REPL 路径注册 —— 不是 `zy doctor` 等子命令。链式：
      // count 必须在 register 的写入完成后运行，否则它会错过我们自己的文件。
      void registerSession().then((registered) => {
        if (!registered) return
        if (sessionNameArg) {
          void updateSessionName(sessionNameArg)
        }
        void countConcurrentSessions().then((count) => {
          if (count >= 2) {
            logEvent('zy_concurrent_sessions', {
              num_sessions: count,
            })
          }
        })
      })

      // 初始化版本化插件系统（如果需要触发 V1→V2 迁移）。
      // 然后运行孤儿 GC，再预热 Grep/Glob 排除缓存。
      // 顺序很重要：预热扫描磁盘查找 .orphaned_at 标记，
      // 所以它必须看到 GC 的 Pass 1（从重新安装的版本中移除标记）
      // 和 Pass 2（标记未标记的孤儿）已应用。
      // 预热还在自动更新之前落地（在 REPL 中首次提交时触发）
      // 不会在我们下面孤立此会话的活跃版本。
      // --bare / SIMPLE：跳过插件版本同步 + 孤儿清理。这些是
      // 脚本化调用不需要的安装/升级簿记 ——
      // 下次交互会话将协调。此处的 await 之前
      // 阻塞了 -p 在市场往返上。
      if (isBareMode()) {
        // skip — no-op
      } else if (isNonInteractiveSession) {
        // 在无头模式下，等待以确保插件同步在 CLI 退出之前完成
        await initializeVersionedPlugins()
        profileCheckpoint('action_after_plugins_init')
        void cleanupOrphanedPluginVersionsInBackground().then(() =>
          getGlobExclusionsForPluginCache(),
        )
      } else {
        // 在交互模式下，触发后不等待 —— 这纯粹是
        // 不影响当前会话运行时行为的簿记
        void initializeVersionedPlugins().then(async () => {
          profileCheckpoint('action_after_plugins_init')
          await cleanupOrphanedPluginVersionsInBackground()
          void getGlobExclusionsForPluginCache()
        })
      }
      const setupTrigger = initOnly || init ? 'init' : maintenance ? 'maintenance' : null
      if (initOnly) {
        applyConfigEnvironmentVariables()
        await processSetupHooks('init', {
          forceSyncExecution: true,
        })
        await processSessionStartHooks('startup', {
          forceSyncExecution: true,
        })
        gracefulShutdownSync(0)
        return
      }

      // --print 模式
      if (isNonInteractiveSession) {
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
          process.stderr.write((orgValidation as any).message + '\n')
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
          effortValue: parseEffortValue(options.effort) ?? getInitialEffortSetting(),
          ...(isAdvisorEnabled() &&
            advisorModel && {
              advisorModel,
            }),
          // kairosEnabled 门控 executeForkedSlashCommand 中的异步 fire-and-forget 路径
          //（processSlashCommand.tsx:132）和 AgentTool 的 shouldRunAsync。
          // REPL initialState 在约 3459 处设置此；无头默认为 false，
          // 所以守护进程子计划的任务和 Agent-tool 调用同步运行
          // —— 生成时 N 个逾期的 cron 任务 = N 个串行子代理回合阻塞用户输入。
          // 在此分支之前于 :1620 计算。
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
        if (feature('TRANSCRIPT_CLASSIFIER')) {
          void verifyAutoModeGateAccess(toolPermissionContext).then(({ updateContext }) => {
            headlessStore.setState((prev) => {
              const nextCtx = updateContext(prev.toolPermissionContext)
              if (nextCtx === prev.toolPermissionContext) return prev
              return {
                ...prev,
                toolPermissionContext: nextCtx,
              }
            })
          })
        }

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
          if (Object.keys(configs).length === 0) return Promise.resolve()
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
        // 获取很早就启动了（约第 2558 行）所以只有剩余时间阻塞
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
              if (sig) zyaiSigs.add(sig)
            }
            const suppressed = new Set<string>()
            for (const [name, config] of Object.entries(regularMcpConfigs)) {
              if (!name.startsWith('plugin:')) continue
              const sig = getMcpServerSignature(config)
              if (sig && zyaiSigs.has(sig)) suppressed.add(name)
            }
            if (suppressed.size > 0) {
              logForDebugging(
                `[MCP] Lazy dedup: suppressing ${suppressed.size} plugin server(s) that duplicate zy.ai connectors: ${[...suppressed].join(', ')}`,
              )
              // Disconnect before filtering from state. Only connected
              // servers need cleanup — clearServerCache on a never-connected
              // server triggers a real connect just to kill it (memoize
              // cache-miss path, see useManageMCPConnections.ts:870).
              for (const c of headlessStore.getState().mcp.clients) {
                if (!suppressed.has(c.name) || c.type !== 'connected') continue
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
        if (zyaiTimer) clearTimeout(zyaiTimer)
        if (zyaiTimedOut) {
          logForDebugging(
            `[MCP] zy.ai connectors not ready after ${ZY_AI_MCP_TIMEOUT_MS}ms — proceeding; background connection continues`,
          )
        }
        profileCheckpoint('after_connectMcp_zyai')

        // 在无头模式下，立即启动延迟预取（没有用户输入延迟）
        // --bare / SIMPLE：startDeferredPrefetches 在内部早期返回。
        // backgroundHousekeeping（initExtractMemories、pruneShellSnapshots、
        // cleanupOldMessageFiles）和 sdkHeapDumpMonitor 都是脚本化调用
        // 不需要的簿记 —— 下次交互会话将协调。
        if (!isBareMode()) {
          startDeferredPrefetches()
          void import('./utils/backgroundHousekeeping.js').then((m) =>
            m.startBackgroundHousekeeping(),
          )
          if (isInternalBuild()) {
            void import('./utils/sdkHeapDumpMonitor.js').then((m: any) => m.startSdkMemoryMonitor())
          }
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
          agentDefinitions.activeAgents,
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
        return
      }

      // 启动时记录模型配置
      logEvent('zy_startup_manual_model_config', {
        cli_flag: options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        env_var: process.env
          .ZY_CODE_MODEL as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        settings_file: (getInitialSettings() || {})
          .model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        agent: agentSetting as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      // 构建初始通知队列
      const initialNotifications: Array<{
        key: string
        text: string
        color?: 'warning'
        priority: 'high'
      }> = []
      if (permissionModeNotification) {
        initialNotifications.push({
          key: 'permission-mode-notification',
          text: permissionModeNotification,
          priority: 'high',
        })
      }
      if (overlyBroadBashPermissions.length > 0) {
        const displayList = uniq(overlyBroadBashPermissions.map((p) => p.ruleDisplay))
        const displays = displayList.join(', ')
        const sources = uniq(overlyBroadBashPermissions.map((p) => p.sourceDisplay)).join(', ')
        const n = displayList.length
        initialNotifications.push({
          key: 'overly-broad-bash-notification',
          text: `${displays} allow ${plural(n, 'rule')} from ${sources} ${plural(n, 'was', 'were')} ignored \u2014 not available for Ants, please use auto-mode instead`,
          color: 'warning',
          priority: 'high',
        })
      }
      const effectiveToolPermissionContext = {
        ...toolPermissionContext,
        mode:
          isAgentSwarmsEnabled() && getTeammateUtils().isPlanModeRequired()
            ? ('plan' as const)
            : toolPermissionContext.mode,
      }
      // 所有启动选择加入路径（--tools、--brief、defaultView）已在上方触发；
      // initialIsBriefOnly 仅读取结果状态。
      const initialIsBriefOnly =
        feature('KAIROS') || feature('KAIROS_BRIEF') ? getUserMsgOptIn() : false
      const fullRemoteControl = remoteControl || getRemoteControlAtStartup() || kairosEnabled
      let ccrMirrorEnabled = false
      if (feature('CCR_MIRROR') && !fullRemoteControl) {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const { isCcrMirrorEnabled } =
          require('./bridge/bridgeEnabled.js') as typeof import('./bridge/bridgeEnabled.js')
        /* eslint-enable @typescript-eslint/no-require-imports */
        ccrMirrorEnabled = isCcrMirrorEnabled()
      }
      const initialState: AppState = {
        settings: getInitialSettings(),
        tasks: {},
        agentNameRegistry: new Map(),
        verbose: verbose ?? getGlobalConfig().verbose ?? false,
        mainLoopModel: initialMainLoopModel,
        mainLoopModelForSession: null,
        isBriefOnly: initialIsBriefOnly,
        expandedView: getGlobalConfig().showSpinnerTree
          ? 'teammates'
          : getGlobalConfig().showExpandedTodos
            ? 'tasks'
            : 'none',
        showTeammateMessagePreview: isAgentSwarmsEnabled() ? false : undefined,
        selectedIPAgentIndex: -1,
        coordinatorTaskIndex: -1,
        viewSelectionMode: 'none',
        footerSelection: null,
        toolPermissionContext: effectiveToolPermissionContext,
        agent: mainThreadAgentDefinition?.agentType,
        agentDefinitions,
        mcp: {
          clients: [],
          tools: [],
          commands: [],
          resources: {},
          pluginReconnectKey: 0,
        },
        plugins: {
          enabled: [],
          disabled: [],
          commands: [],
          errors: [],
          installationStatus: {
            marketplaces: [],
            plugins: [],
          },
          needsRefresh: false,
        },
        kairosEnabled,
        remoteSessionUrl: undefined,
        remoteConnectionStatus: 'connecting',
        remoteBackgroundTaskCount: 0,
        replBridgeEnabled: fullRemoteControl || ccrMirrorEnabled,
        replBridgeExplicit: remoteControl,
        replBridgeOutboundOnly: ccrMirrorEnabled,
        replBridgeConnected: false,
        replBridgeSessionActive: false,
        replBridgeReconnecting: false,
        replBridgeConnectUrl: undefined,
        replBridgeSessionUrl: undefined,
        replBridgeEnvironmentId: undefined,
        replBridgeSessionId: undefined,
        replBridgeError: undefined,
        replBridgeInitialName: remoteControlName,
        showRemoteCallout: false,
        notifications: {
          current: null,
          queue: initialNotifications,
        },
        elicitation: {
          queue: [],
        },
        todos: {},
        remoteAgentTaskSuggestions: [],
        fileHistory: {
          snapshots: [],
          trackedFiles: new Set(),
          snapshotSequence: 0,
        },
        attribution: createEmptyAttributionState(),
        thinkingEnabled,
        promptSuggestionEnabled: shouldEnablePromptSuggestion(),
        sessionHooks: new Map(),
        inbox: {
          messages: [],
        },
        promptSuggestion: {
          text: null,
          promptId: null,
          shownAt: 0,
          acceptedAt: 0,
          generationRequestId: null,
        },
        speculation: IDLE_SPECULATION_STATE,
        speculationSessionTimeSavedMs: 0,
        skillImprovement: {
          suggestion: null,
        },
        workerSandboxPermissions: {
          queue: [],
          selectedIndex: 0,
        },
        pendingWorkerRequest: null,
        pendingSandboxRequest: null,
        authVersion: 0,
        initialMessage: inputPrompt
          ? {
              message: createUserMessage({
                content: String(inputPrompt),
              }),
            }
          : null,
        effortValue: parseEffortValue(options.effort) ?? getInitialEffortSetting(),
        activeOverlays: new Set<string>(),
        ...(isAdvisorEnabled() &&
          advisorModel && {
            advisorModel,
          }),
        // 同步计算 teamContext 以避免渲染期间的 useEffect setState。
        // KAIROS：assistantTeamContext 优先 —— 在
        // KAIROS 块中更早设置，以便 Agent(name: "foo") 可以生成进程内队友
        // 而不需要 TeamCreate。computeInitialTeamContext() 用于 tmux 生成的
        // 队友读取自己的身份，而不是助手模式领导者。
        teamContext: (feature('KAIROS')
          ? (assistantTeamContext ?? computeInitialTeamContext?.())
          : computeInitialTeamContext?.()) as AppState['teamContext'],
      }

      // 将 CLI 初始提示添加到历史记录
      if (inputPrompt) {
        addToHistory(String(inputPrompt))
      }
      const initialTools = mcpTools

      // 同步递增 numStartups，仅延迟遥测。
      saveGlobalConfig((current) => ({
        ...current,
        numStartups: (current.numStartups ?? 0) + 1,
      }))
      setImmediate(() => {
        void logStartupTelemetry()
        logSessionTelemetry()
      })

      // 设置每轮会话环境数据上传器（仅限 ant 构建）。
      // 在 Anthropic 拥有的仓库中工作时为所有 ant 用户默认启用。
      // 在每轮捕获 git/文件系统状态（不是转录），以便
      // 可以在任何用户消息索引处重新创建环境。门控：
      //   - 构建时：此导入在外部构建中是存根。
      //   - 运行时：上传者检查 github.com/anthropics/* 远程 + gcloud 认证。
      //   - 安全：ZY_CODE_DISABLE_SESSION_DATA_UPLOAD=1 绕过（测试设置此）。
      // 导入是动态 + 异步的，以避免增加启动延迟。
      const sessionUploaderPromise = isInternalBuild()
        ? import('./utils/sessionDataUploader.js')
        : null

      // 将会话上传器解析延迟到 onTurnComplete 回调，以避免
      // 在 main.tsx 中添加新的顶级 await（性能关键路径）。
      // sessionDataUploader.ts 中的每轮认证逻辑优雅地处理未认证
      // 状态（每轮重新检查，所以会话中间的认证恢复有效）。
      const uploaderReady = sessionUploaderPromise
        ? sessionUploaderPromise
            .then((mod: any) => mod.createSessionTurnUploader())
            .catch(() => null)
        : null
      const sessionConfig = {
        debug: debug || debugToStderr,
        commands: [...commands, ...mcpCommands],
        initialTools,
        mcpClients,
        autoConnectIdeFlag: ide,
        mainThreadAgentDefinition,
        disableSlashCommands,
        dynamicMcpConfig,
        strictMcpConfig,
        systemPrompt,
        appendSystemPrompt,
        taskListId,
        thinkingConfig,
        ...(uploaderReady && {
          onTurnComplete: (messages: MessageType[]) => {
            void uploaderReady.then((uploader) => uploader?.(messages))
          },
        }),
      }

      // 用于 processResumedConversation 调用的共享上下文
      const resumeContext = {
        modeApi: coordinatorModeModule,
        mainThreadAgentDefinition,
        agentDefinitions,
        currentCwd,
        cliAgents,
        initialState,
      }
      if (options.continue) {
        // 直接继续最近的对话
        let resumeSucceeded = false
        try {
          const resumeStart = performance.now()

          // 在恢复之前清除过时的缓存，以确保新鲜的文件/技能发现
          const { clearSessionCaches } = await import('./commands/clear/caches.js')
          clearSessionCaches()
          const result = await loadConversationForResume(
            undefined /* sessionId */,
            undefined /* sourceFile */,
          )
          if (!result) {
            logEvent('zy_continue', {
              success: false,
            })
            return await exitWithError(root, 'No conversation found to continue')
          }
          const loaded = await processResumedConversation(
            result,
            {
              forkSession: !!options.forkSession,
              includeAttribution: true,
              transcriptPath: result.fullPath,
            },
            resumeContext,
          )
          if (loaded.restoredAgentDef) {
            mainThreadAgentDefinition = loaded.restoredAgentDef
          }
          maybeActivateProactive(options)
          maybeActivateBrief(options)
          logEvent('zy_continue', {
            success: true,
            resume_duration_ms: Math.round(performance.now() - resumeStart),
          })
          resumeSucceeded = true
          await launchRepl(
            root,
            {
              getFpsMetrics,
              stats,
              initialState: loaded.initialState,
            },
            {
              ...sessionConfig,
              mainThreadAgentDefinition: loaded.restoredAgentDef ?? mainThreadAgentDefinition,
              initialMessages: loaded.messages,
              initialFileHistorySnapshots: loaded.fileHistorySnapshots,
              initialContentReplacements: loaded.contentReplacements,
              initialAgentName: loaded.agentName,
              initialAgentColor: loaded.agentColor,
            },
            renderAndRun,
          )
        } catch (error) {
          if (!resumeSucceeded) {
            logEvent('zy_continue', {
              success: false,
            })
          }
          logError(error)
          process.exit(1)
        }
      } else if (feature('DIRECT_CONNECT') && _pendingConnect?.url) {
        // `zy connect <url>` —— 完整交互式 TUI 连接到远程服务器
        let directConnectConfig
        try {
          const session = await createDirectConnectSession({
            serverUrl: _pendingConnect.url,
            authToken: _pendingConnect.authToken,
            cwd: getOriginalCwd(),
            dangerouslySkipPermissions: _pendingConnect.dangerouslySkipPermissions,
          })
          if (session.workDir) {
            setOriginalCwd(session.workDir)
            setCwdState(session.workDir)
          }
          setDirectConnectServerUrl(_pendingConnect.url)
          directConnectConfig = session.config
        } catch (err) {
          return await exitWithError(
            root,
            err instanceof DirectConnectError ? err.message : String(err),
            () => gracefulShutdown(1),
          )
        }
        const connectInfoMessage = createSystemMessage(
          `Connected to server at ${_pendingConnect.url}\nSession: ${directConnectConfig.sessionId}`,
          'info',
        )
        await launchRepl(
          root,
          {
            getFpsMetrics,
            stats,
            initialState,
          },
          {
            debug: debug || debugToStderr,
            commands,
            initialTools: [],
            initialMessages: [connectInfoMessage],
            mcpClients: [],
            autoConnectIdeFlag: ide,
            mainThreadAgentDefinition,
            disableSlashCommands,
            directConnectConfig,
            thinkingConfig,
          },
          renderAndRun,
        )
        return
      } else if (feature('SSH_REMOTE') && _pendingSSH?.host) {
        // `zy ssh <host> [dir]` —— 探测远程，如果需要则部署二进制文件，
        // 生成带有 unix-socket -R 转发到本地认证代理的 ssh，将
        // SSHSession 交给 REPL。工具在远程运行，UI 在本地渲染。
        // `--local` 跳过探测/部署/ssh 并直接生成当前二进制文件
        // 使用相同的环境 —— 代理/认证管道的 e2e 测试。
        const {
          // @ts-ignore
          createSSHSession,
          // @ts-ignore
          createLocalSSHSession,
          // @ts-ignore
          SSHSessionError,
        } = await import('./ssh/createSSHSession.js')
        let sshSession
        try {
          if (_pendingSSH.local) {
            process.stderr.write('Starting local ssh-proxy test session...\n')
            sshSession = createLocalSSHSession({
              cwd: _pendingSSH.cwd,
              permissionMode: _pendingSSH.permissionMode,
              dangerouslySkipPermissions: _pendingSSH.dangerouslySkipPermissions,
            })
          } else {
            process.stderr.write(`Connecting to ${_pendingSSH.host}…\n`)
            // 原位进度：\r + EL0（擦除到行尾）。成功时最终 \n
            // 以便下一条消息落在新行上。当 stderr
            // 不是 TTY 时无操作（管道/重定向）—— \r 只会发出噪音。
            const isTTY = process.stderr.isTTY
            let hadProgress = false
            sshSession = await createSSHSession(
              {
                host: _pendingSSH.host,
                cwd: _pendingSSH.cwd,
                localVersion: MACRO.VERSION,
                permissionMode: _pendingSSH.permissionMode,
                dangerouslySkipPermissions: _pendingSSH.dangerouslySkipPermissions,
                extraCliArgs: _pendingSSH.extraCliArgs,
              },
              isTTY
                ? {
                    onProgress: (msg) => {
                      hadProgress = true
                      process.stderr.write(`\r  ${msg}\x1b[K`)
                    },
                  }
                : {},
            )
            if (hadProgress) process.stderr.write('\n')
          }
          setOriginalCwd(sshSession.remoteCwd)
          setCwdState(sshSession.remoteCwd)
          setDirectConnectServerUrl(_pendingSSH.local ? 'local' : _pendingSSH.host)
        } catch (err) {
          return await exitWithError(
            root,
            err instanceof SSHSessionError ? err.message : String(err),
            () => gracefulShutdown(1),
          )
        }
        const sshInfoMessage = createSystemMessage(
          _pendingSSH.local
            ? `Local ssh-proxy test session\ncwd: ${sshSession.remoteCwd}\nAuth: unix socket → local proxy`
            : `SSH session to ${_pendingSSH.host}\nRemote cwd: ${sshSession.remoteCwd}\nAuth: unix socket -R → local proxy`,
          'info',
        )
        await launchRepl(
          root,
          {
            getFpsMetrics,
            stats,
            initialState,
          },
          {
            debug: debug || debugToStderr,
            commands,
            initialTools: [],
            initialMessages: [sshInfoMessage],
            mcpClients: [],
            autoConnectIdeFlag: ide,
            mainThreadAgentDefinition,
            disableSlashCommands,
            sshSession,
            thinkingConfig,
          },
          renderAndRun,
        )
        return
      } else if (
        feature('KAIROS') &&
        _pendingAssistantChat &&
        (_pendingAssistantChat.sessionId || _pendingAssistantChat.discover)
      ) {
        // `zy assistant [sessionId]` —— REPL 作为纯查看器客户端
        // 连接远程助手会话。代理循环在远程运行；此
        // 进程流式传输实时事件并 POST 消息。历史是懒惰
        // 加载的，由 useAssistantHistory 在滚动向上时加载（此处无阻塞获取）。
        const { discoverAssistantSessions } = await import('./assistant/sessionDiscovery.js' as any)
        let targetSessionId = _pendingAssistantChat.sessionId

        // 发现流程 —— 列出桥接环境，过滤会话
        if (!targetSessionId) {
          let sessions
          try {
            sessions = await discoverAssistantSessions()
          } catch (e) {
            return await exitWithError(
              root,
              `Failed to discover sessions: ${e instanceof Error ? e.message : e}`,
              () => gracefulShutdown(1),
            )
          }
          if (sessions.length === 0) {
            let installedDir: string | null
            try {
              installedDir = await launchAssistantInstallWizard(root)
            } catch (e) {
              return await exitWithError(
                root,
                `Assistant installation failed: ${e instanceof Error ? e.message : e}`,
                () => gracefulShutdown(1),
              )
            }
            if (installedDir === null) {
              await gracefulShutdown(0)
              process.exit(0)
            }
            // The daemon needs a few seconds to spin up its worker and
            // establish a bridge session before discovery will find it.
            return await exitWithMessage(
              root,
              `Assistant installed in ${installedDir}. The daemon is starting up — run \`zy assistant\` again in a few seconds to connect.`,
              {
                exitCode: 0,
                beforeExit: () => gracefulShutdown(0),
              },
            )
          }
          if (sessions.length === 1) {
            targetSessionId = sessions[0]!.id
          } else {
            const picked = await launchAssistantSessionChooser(root, {
              sessions,
            })
            if (!picked) {
              await gracefulShutdown(0)
              process.exit(0)
            }
            targetSessionId = picked
          }
        }

        // 认证 —— 调用 prepareApiRequest() 一次获取 orgUUID，但使用
        // getAccessToken 闭包获取令牌，以便重新连接获取新鲜令牌。
        const { checkAndRefreshOAuthTokenIfNeeded, getZyAIOAuthTokens } = await import(
          './utils/auth.js'
        )
        await checkAndRefreshOAuthTokenIfNeeded()
        let apiCreds
        try {
          apiCreds = await prepareApiRequest()
        } catch (e) {
          return await exitWithError(
            root,
            `Error: ${e instanceof Error ? e.message : 'Failed to authenticate'}`,
            () => gracefulShutdown(1),
          )
        }
        const getAccessToken = (): string =>
          getZyAIOAuthTokens()?.accessToken ?? apiCreds.accessToken

        // Brief 模式激活：setKairosActive(true) 满足 isBriefEnabled() 的选择加入
        // 和授权（BriefTool.ts:124-132）。
        setKairosActive(true)
        setUserMsgOptIn(true)
        setIsRemoteMode(true)
        const remoteSessionConfig = createRemoteSessionConfig(
          targetSessionId,
          getAccessToken,
          apiCreds.orgUUID,
          /* hasInitialPrompt */ false,
          /* viewerOnly */ true,
        )
        const infoMessage = createSystemMessage(
          `Attached to assistant session ${targetSessionId.slice(0, 8)}…`,
          'info',
        )
        const assistantInitialState: AppState = {
          ...initialState,
          isBriefOnly: true,
          kairosEnabled: false,
          replBridgeEnabled: false,
        }
        const remoteCommands = filterCommandsForRemoteMode(commands)
        await launchRepl(
          root,
          {
            getFpsMetrics,
            stats,
            initialState: assistantInitialState,
          },
          {
            debug: debug || debugToStderr,
            commands: remoteCommands,
            initialTools: [],
            initialMessages: [infoMessage],
            mcpClients: [],
            autoConnectIdeFlag: ide,
            mainThreadAgentDefinition,
            disableSlashCommands,
            remoteSessionConfig,
            thinkingConfig,
          },
          renderAndRun,
        )
        return
      } else if (options.resume || options.fromPr || teleport || remote !== null) {
        // 处理恢复流程 —— 从文件（仅限 ant）、会话 ID 或交互式选择器恢复

        // Clear stale caches before resuming to ensure fresh file/skill discovery
        const { clearSessionCaches } = await import('./commands/clear/caches.js')
        clearSessionCaches()
        let messages: MessageType[] | null = null
        let processedResume: ProcessedResume | undefined = undefined
        let maybeSessionId = validateUuid(options.resume)
        let searchTerm: string | undefined = undefined
        // 按自定义标题找到时存储完整的 LogOption（用于跨 worktree 恢复）
        let matchedLog: LogOption | null = null
        // --from-pr 标志的 PR 过滤
        let filterByPr: boolean | number | string | undefined = undefined

        // 处理 --from-pr 标志
        if (options.fromPr) {
          if (options.fromPr === true) {
            // Show all sessions with linked PRs
            filterByPr = true
          } else if (typeof options.fromPr === 'string') {
            // Could be a PR number or URL
            filterByPr = options.fromPr
          }
        }

        // 如果恢复值不是 UUID，首先尝试按自定义标题精确匹配
        if (options.resume && typeof options.resume === 'string' && !maybeSessionId) {
          const trimmedValue = options.resume.trim()
          if (trimmedValue) {
            const matches = await searchSessionsByCustomTitle(trimmedValue, {
              exact: true,
            })
            if (matches.length === 1) {
              // 精确匹配找到 —— 存储完整的 LogOption 用于跨 worktree 恢复
              matchedLog = matches[0]!
              maybeSessionId = getSessionIdFromLog(matchedLog) ?? null
            } else {
              // 无匹配或多个匹配 —— 用作选择器的搜索词
              searchTerm = trimmedValue
            }
          }
        }

        // --remote and --teleport both create/resume ZY Code Web (ZYR) sessions.
        // Remote Control (--rc) is a separate feature gated in initReplBridge.ts.
        if (remote !== null || teleport) {
          await waitForPolicyLimitsToLoad()
          if (!isPolicyAllowed('allow_remote_sessions')) {
            return await exitWithError(
              root,
              "Error: Remote sessions are disabled by your organization's policy.",
              () => gracefulShutdown(1),
            )
          }
        }
        if (remote !== null) {
          // 创建远程会话（可选带初始提示）
          const hasInitialPrompt = remote.length > 0

          // 检查是否启用了 TUI 模式 —— 描述仅在 TUI 模式下是可选的
          const isRemoteTuiEnabled = getFeatureValue_CACHED_MAY_BE_STALE('zy_remote_backend', false)
          if (!isRemoteTuiEnabled && !hasInitialPrompt) {
            return await exitWithError(
              root,
              'Error: --remote requires a description.\nUsage: zy --remote "your task description"',
              () => gracefulShutdown(1),
            )
          }
          logEvent('zy_remote_create_session', {
            has_initial_prompt: String(
              hasInitialPrompt,
            ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })

          // 传递当前分支以便 CCR 在正确的修订版克隆仓库
          const currentBranch = await getBranch()
          const createdSession = await teleportToRemoteWithErrorHandling(
            root,
            hasInitialPrompt ? remote : null,
            new AbortController().signal,
            currentBranch || undefined,
          )
          if (!createdSession) {
            logEvent('zy_remote_create_session_error', {
              error:
                'unable_to_create_session' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
            return await exitWithError(root, 'Error: Unable to create remote session', () =>
              gracefulShutdown(1),
            )
          }
          logEvent('zy_remote_create_session_success', {
            session_id:
              createdSession.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })

          // 通过功能门检查是否启用了新的远程 TUI 模式
          if (!isRemoteTuiEnabled) {
            // 原始行为：打印会话信息并退出
            process.stdout.write(`Created remote session: ${createdSession.title}\n`)
            process.stdout.write(`View: ${getRemoteSessionUrl(createdSession.id)}?m=0\n`)
            process.stdout.write(`Resume with: zy --teleport ${createdSession.id}\n`)
            await gracefulShutdown(0)
            process.exit(0)
          }

          // 新行为：启动带 CCR 引擎的本地 TUI
          // 标记我们处于远程模式以进行命令可见性
          setIsRemoteMode(true)
          switchSession(asSessionId(createdSession.id))

          // 获取远程会话的 OAuth 凭证
          let apiCreds: {
            accessToken: string
            orgUUID: string
          }
          try {
            apiCreds = await prepareApiRequest()
          } catch (error) {
            logError(toError(error))
            return await exitWithError(
              root,
              `Error: ${errorMessage(error) || 'Failed to authenticate'}`,
              () => gracefulShutdown(1),
            )
          }

          // 为 REPL 创建远程会话配置
          const { getZyAIOAuthTokens: getTokensForRemote } = await import('./utils/auth.js')
          const getAccessTokenForRemote = (): string =>
            getTokensForRemote()?.accessToken ?? apiCreds.accessToken
          const remoteSessionConfig = createRemoteSessionConfig(
            createdSession.id,
            getAccessTokenForRemote,
            apiCreds.orgUUID,
            hasInitialPrompt,
          )

          // 将远程会话信息作为初始系统消息添加
          const remoteSessionUrl = `${getRemoteSessionUrl(createdSession.id)}?m=0`
          const remoteInfoMessage = createSystemMessage(
            `/remote-control is active. Code in CLI or at ${remoteSessionUrl}`,
            'info',
          )

          // 如果提供了提示，从提示创建初始用户消息（CCR 回显它但我们忽略）
          const initialUserMessage = hasInitialPrompt
            ? createUserMessage({
                content: remote,
              })
            : null

          // 在应用状态中设置远程会话 URL 用于底部指示器
          const remoteInitialState = {
            ...initialState,
            remoteSessionUrl,
          }

          // 预过滤命令以仅包含远程安全的命令。
          // CCR 的初始化响应可能进一步细化列表（通过 REPL 中的 handleRemoteInit）。
          const remoteCommands = filterCommandsForRemoteMode(commands)
          await launchRepl(
            root,
            {
              getFpsMetrics,
              stats,
              initialState: remoteInitialState,
            },
            {
              debug: debug || debugToStderr,
              commands: remoteCommands,
              initialTools: [],
              initialMessages: initialUserMessage
                ? [remoteInfoMessage, initialUserMessage]
                : [remoteInfoMessage],
              mcpClients: [],
              autoConnectIdeFlag: ide,
              mainThreadAgentDefinition,
              disableSlashCommands,
              remoteSessionConfig,
              thinkingConfig,
            },
            renderAndRun,
          )
          return
        } else if (teleport) {
          if (teleport === true || teleport === '') {
            // 交互模式：显示任务选择器并处理恢复
            logEvent('zy_teleport_interactive_mode', {})
            logForDebugging('selectAndResumeTeleportTask: Starting teleport flow...')
            const teleportResult = await launchTeleportResumeWrapper(root)
            if (!teleportResult) {
              // 用户取消或发生错误
              await gracefulShutdown(0)
              process.exit(0)
            }
            const { branchError } = await checkOutTeleportedSessionBranch(teleportResult.branch)
            messages = processMessagesForTeleportResume(teleportResult.log, branchError)
          } else if (typeof teleport === 'string') {
            logEvent('zy_teleport_resume_session', {
              mode: 'direct' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
            try {
              // 首先，在检查 git 状态之前获取会话并验证仓库
              const sessionData = await fetchSession(teleport)
              const repoValidation = await validateSessionRepository(sessionData)

              // 处理仓库不匹配或不在仓库中的情况
              if (repoValidation.status === 'mismatch' || repoValidation.status === 'not_in_repo') {
                const sessionRepo = repoValidation.sessionRepo
                if (sessionRepo) {
                  // 检查已知路径
                  const knownPaths = getKnownPathsForRepo(sessionRepo)
                  const existingPaths = await filterExistingPaths(knownPaths)
                  if (existingPaths.length > 0) {
                    // 显示目录切换对话框
                    const selectedPath = await launchTeleportRepoMismatchDialog(root, {
                      targetRepo: sessionRepo,
                      initialPaths: existingPaths,
                    })
                    if (selectedPath) {
                      // 切换到选定的目录
                      process.chdir(selectedPath)
                      setCwd(selectedPath)
                      setOriginalCwd(selectedPath)
                    } else {
                      // 用户取消
                      await gracefulShutdown(0)
                    }
                  } else {
                    // 没有已知路径 —— 显示原始错误
                    throw new TeleportOperationError(
                      `You must run zy --teleport ${teleport} from a checkout of ${sessionRepo}.`,
                      chalk.red(
                        `You must run zy --teleport ${teleport} from a checkout of ${chalk.bold(sessionRepo)}.\n`,
                      ),
                    )
                  }
                }
              } else if (repoValidation.status === 'error') {
                throw new TeleportOperationError(
                  repoValidation.errorMessage || 'Failed to validate session',
                  chalk.red(
                    `Error: ${repoValidation.errorMessage || 'Failed to validate session'}\n`,
                  ),
                )
              }
              await validateGitState()

              // 使用进度 UI 进行 teleport
              const { teleportWithProgress } = await import('./components/TeleportProgress.js')
              const result = await teleportWithProgress(root, teleport)
              // 跟踪 teleported 会话用于可靠性日志
              setTeleportedSessionInfo({
                sessionId: teleport,
              })
              messages = result.messages
            } catch (error) {
              if (error instanceof TeleportOperationError) {
                process.stderr.write(error.formattedMessage + '\n')
              } else {
                logError(error)
                process.stderr.write(chalk.red(`Error: ${errorMessage(error)}\n`))
              }
              await gracefulShutdown(1)
            }
          }
        }
        if (isInternalBuild()) {
          if (options.resume && typeof options.resume === 'string' && !maybeSessionId) {
            // Check for ccshare URL (e.g. https://go/ccshare/boris-20260311-211036)
            const {
              // @ts-ignore
              parseCcshareId,
              // @ts-ignore
              loadCcshare,
            } = await import('./utils/ccshareResume.js')
            const ccshareId = parseCcshareId(options.resume)
            if (ccshareId) {
              try {
                const resumeStart = performance.now()
                const logOption = await loadCcshare(ccshareId)
                const result = await loadConversationForResume(logOption, undefined)
                if (result) {
                  processedResume = await processResumedConversation(
                    result,
                    {
                      forkSession: true,
                      transcriptPath: result.fullPath,
                    },
                    resumeContext,
                  )
                  if (processedResume.restoredAgentDef) {
                    mainThreadAgentDefinition = processedResume.restoredAgentDef
                  }
                  logEvent('zy_session_resumed', {
                    entrypoint:
                      'ccshare' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    success: true,
                    resume_duration_ms: Math.round(performance.now() - resumeStart),
                  })
                } else {
                  logEvent('zy_session_resumed', {
                    entrypoint:
                      'ccshare' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    success: false,
                  })
                }
              } catch (error) {
                logEvent('zy_session_resumed', {
                  entrypoint:
                    'ccshare' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  success: false,
                })
                logError(error)
                await exitWithError(
                  root,
                  `Unable to resume from ccshare: ${errorMessage(error)}`,
                  () => gracefulShutdown(1),
                )
              }
            } else {
              const resolvedPath = resolve(options.resume)
              try {
                const resumeStart = performance.now()
                let logOption
                try {
                  // Attempt to load as a transcript file; ENOENT falls through to session-ID handling
                  logOption = await loadTranscriptFromFile(resolvedPath)
                } catch (error) {
                  if (!isENOENT(error)) throw error
                  // ENOENT: not a file path — fall through to session-ID handling
                }
                if (logOption) {
                  const result = await loadConversationForResume(
                    logOption,
                    undefined /* sourceFile */,
                  )
                  if (result) {
                    processedResume = await processResumedConversation(
                      result,
                      {
                        forkSession: !!options.forkSession,
                        transcriptPath: result.fullPath,
                      },
                      resumeContext,
                    )
                    if (processedResume.restoredAgentDef) {
                      mainThreadAgentDefinition = processedResume.restoredAgentDef
                    }
                    logEvent('zy_session_resumed', {
                      entrypoint:
                        'file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      success: true,
                      resume_duration_ms: Math.round(performance.now() - resumeStart),
                    })
                  } else {
                    logEvent('zy_session_resumed', {
                      entrypoint:
                        'file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      success: false,
                    })
                  }
                }
              } catch (error) {
                logEvent('zy_session_resumed', {
                  entrypoint: 'file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  success: false,
                })
                logError(error)
                await exitWithError(
                  root,
                  `Unable to load transcript from file: ${options.resume}`,
                  () => gracefulShutdown(1),
                )
              }
            }
          }
        }

        // 如果未作为文件加载，尝试作为会话 ID
        if (maybeSessionId) {
          // 按 ID 恢复特定会话
          const sessionId = maybeSessionId
          try {
            const resumeStart = performance.now()
            // 如果可用使用 matchedLog（用于按自定义标题跨 worktree 恢复）
            // 否则回退到 sessionId 字符串（用于直接 UUID 恢复）
            const result = await loadConversationForResume(matchedLog ?? sessionId, undefined)
            if (!result) {
              logEvent('zy_session_resumed', {
                entrypoint:
                  'cli_flag' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                success: false,
              })
              return await exitWithError(
                root,
                `No conversation found with session ID: ${sessionId}`,
              )
            }
            const fullPath = matchedLog?.fullPath ?? result.fullPath
            processedResume = await processResumedConversation(
              result,
              {
                forkSession: !!options.forkSession,
                sessionIdOverride: sessionId,
                transcriptPath: fullPath,
              },
              resumeContext,
            )
            if (processedResume.restoredAgentDef) {
              mainThreadAgentDefinition = processedResume.restoredAgentDef
            }
            logEvent('zy_session_resumed', {
              entrypoint: 'cli_flag' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              success: true,
              resume_duration_ms: Math.round(performance.now() - resumeStart),
            })
          } catch (error) {
            logEvent('zy_session_resumed', {
              entrypoint: 'cli_flag' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              success: false,
            })
            logError(error)
            await exitWithError(root, `Failed to resume session ${sessionId}`)
          }
        }

        // 在渲染 REPL 之前等待文件下载（文件必须可用）
        if (fileDownloadPromise) {
          try {
            const results = await fileDownloadPromise
            const failedCount = count(results, (r) => !r.success)
            if (failedCount > 0) {
              process.stderr.write(
                chalk.yellow(
                  `Warning: ${failedCount}/${results.length} file(s) failed to download.\n`,
                ),
              )
            }
          } catch (error) {
            return await exitWithError(root, `Error downloading files: ${errorMessage(error)}`)
          }
        }

        // 如果我们有处理过的恢复或 teleport 消息，渲染 REPL
        const resumeData =
          processedResume ??
          (Array.isArray(messages)
            ? {
                messages,
                fileHistorySnapshots: undefined,
                agentName: undefined,
                agentColor: undefined as AgentColorName | undefined,
                restoredAgentDef: mainThreadAgentDefinition,
                initialState,
                contentReplacements: undefined,
              }
            : undefined)
        if (resumeData) {
          maybeActivateProactive(options)
          maybeActivateBrief(options)
          await launchRepl(
            root,
            {
              getFpsMetrics,
              stats,
              initialState: resumeData.initialState,
            },
            {
              ...sessionConfig,
              mainThreadAgentDefinition: resumeData.restoredAgentDef ?? mainThreadAgentDefinition,
              initialMessages: resumeData.messages,
              initialFileHistorySnapshots: resumeData.fileHistorySnapshots,
              initialContentReplacements: resumeData.contentReplacements,
              initialAgentName: resumeData.agentName,
              initialAgentColor: resumeData.agentColor,
            },
            renderAndRun,
          )
        } else {
          // 显示交互式选择器（包括同仓库 worktrees）
          // Note: ResumeConversation loads logs internally to ensure proper GC after selection
          await launchResumeChooser(
            root,
            {
              getFpsMetrics,
              stats,
              initialState,
            },
            getWorktreePaths(getOriginalCwd()),
            {
              ...sessionConfig,
              initialSearchQuery: searchTerm,
              forkSession: options.forkSession,
              filterByPr,
            },
          )
        }
      } else {
        // 将未解决的钩子 promise 传递给 REPL，以便它可以立即渲染
        // 而不是阻塞约 500ms 等待 SessionStart 钩子完成。
        // REPL 将在钩子解析时注入钩子消息，并在
        // 首次 API 调用之前等待它们，以便模型始终看到钩子上下文。
        const pendingHookMessages =
          hooksPromise && hookMessages.length === 0 ? hooksPromise : undefined

        profileCheckpoint('action_after_hooks')
        maybeActivateProactive(options)
        maybeActivateBrief(options)
        // 为新会话持久化当前模式，以便未来的恢复知道使用了什么模式
        if (feature('COORDINATOR_MODE')) {
          saveMode(coordinatorModeModule?.isCoordinatorMode() ? 'coordinator' : 'normal')
        }

        // 如果通过深度链接启动，显示来源横幅以便用户
        // 知道会话是从外部启动的。Linux xdg-open 和
        // 设置了"始终允许"的浏览器在没有操作系统级别
        // 确认的情况下分派链接，所以这是用户得到的唯一信号
        // 提示 —— 以及它暗示的工作目录 / CLAUDE.md —— 来自
        // 外部来源，而不是他们输入的内容。
        let deepLinkBanner: ReturnType<typeof createSystemMessage> | null = null
        if (feature('LODESTONE')) {
          if (options.deepLinkOrigin) {
            logEvent('zy_deep_link_opened', {
              has_prefill: Boolean(options.prefill),
              has_repo: Boolean(options.deepLinkRepo),
            })
            deepLinkBanner = createSystemMessage(
              buildDeepLinkBanner({
                cwd: getCwd(),
                prefillLength: options.prefill?.length,
                repo: options.deepLinkRepo,
                lastFetch:
                  options.deepLinkLastFetch !== undefined
                    ? new Date(options.deepLinkLastFetch)
                    : undefined,
              }),
              'warning' as any,
            )
          } else if (options.prefill) {
            deepLinkBanner = createSystemMessage(
              'Launched with a pre-filled prompt — review it before pressing Enter.',
              'warning' as any,
            )
          }
        }
        const initialMessages = deepLinkBanner
          ? [deepLinkBanner, ...hookMessages]
          : hookMessages.length > 0
            ? hookMessages
            : undefined
        await launchRepl(
          root,
          {
            getFpsMetrics,
            stats,
            initialState,
          },
          {
            ...sessionConfig,
            initialMessages,
            pendingHookMessages,
          },
          renderAndRun,
        )
      }
    })
    .version(`${MACRO.VERSION} (ZY Code)`, '-v, --version', 'Output the version number')

  // worktree 标志
  program.option(
    '-w, --worktree [name]',
    'Create a new git worktree for this session (optionally specify a name)',
  )
  program.option(
    '--tmux',
    'Create a tmux session for the worktree (requires --worktree). Uses iTerm2 native panes when available; use --tmux=classic for traditional tmux.',
  )
  if (canUserConfigureAdvisor()) {
    program.addOption(
      new Option(
        '--advisor <model>',
        'Enable the server-side advisor tool with the specified model (alias or full ID).',
      ).hideHelp(),
    )
  }
  if (isInternalBuild()) {
    program.addOption(
      new Option(
        '--delegate-permissions',
        '[INNER-ONLY] Alias for --permission-mode auto.',
      ).implies({
        permissionMode: 'auto',
      }),
    )
    program.addOption(
      new Option(
        '--dangerously-skip-permissions-with-classifiers',
        '[INNER-ONLY] Deprecated alias for --permission-mode auto.',
      )
        .hideHelp()
        .implies({
          permissionMode: 'auto',
        }),
    )
    program.addOption(
      new Option('--afk', '[INNER-ONLY] Deprecated alias for --permission-mode auto.')
        .hideHelp()
        .implies({
          permissionMode: 'auto',
        }),
    )
    program.addOption(
      new Option(
        '--tasks [id]',
        '[INNER-ONLY] Tasks mode: watch for tasks and auto-process them. Optional id is used as both the task list ID and agent ID (defaults to "tasklist").',
      )
        .argParser(String)
        .hideHelp(),
    )
    program.option(
      '--agent-teams',
      '[INNER-ONLY] Force ZY to use multi-agent mode for solving problems',
      () => true,
    )
  }
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    program.addOption(new Option('--enable-auto-mode', 'Opt in to auto mode').hideHelp())
  }
  if (feature('PROACTIVE') || feature('KAIROS')) {
    program.addOption(new Option('--proactive', 'Start in proactive autonomous mode'))
  }
  if (feature('UDS_INBOX')) {
    program.addOption(
      new Option(
        '--messaging-socket-path <path>',
        'Unix domain socket path for the UDS messaging server (defaults to a tmp path)',
      ),
    )
  }
  if (feature('KAIROS') || feature('KAIROS_BRIEF')) {
    program.addOption(
      new Option('--brief', 'Enable SendUserMessage tool for agent-to-user communication'),
    )
  }
  if (feature('KAIROS')) {
    program.addOption(
      new Option('--assistant', 'Force assistant mode (Agent SDK daemon use)').hideHelp(),
    )
  }
  if (feature('KAIROS') || feature('KAIROS_CHANNELS')) {
    program.addOption(
      new Option(
        '--channels <servers...>',
        'MCP servers whose channel notifications (inbound push) should register this session. Space-separated server names.',
      ).hideHelp(),
    )
    program.addOption(
      new Option(
        '--dangerously-load-development-channels <servers...>',
        'Load channel servers not on the approved allowlist. For local channel development only. Shows a confirmation dialog at startup.',
      ).hideHelp(),
    )
  }

  // 队友身份选项（由领导者在生成 tmux 队友时设置）
  // 这些替换了 ZY_CODE_* 环境变量
  program.addOption(new Option('--agent-id <id>', 'Teammate agent ID').hideHelp())
  program.addOption(new Option('--agent-name <name>', 'Teammate display name').hideHelp())
  program.addOption(new Option('--team-name <name>', 'Team name for swarm coordination').hideHelp())
  program.addOption(new Option('--agent-color <color>', 'Teammate UI color').hideHelp())
  program.addOption(
    new Option('--plan-mode-required', 'Require plan mode before implementation').hideHelp(),
  )
  program.addOption(
    new Option(
      '--parent-session-id <id>',
      'Parent session ID for analytics correlation',
    ).hideHelp(),
  )
  program.addOption(
    new Option('--teammate-mode <mode>', 'How to spawn teammates: "tmux", "in-process", or "auto"')
      .choices(['auto', 'tmux', 'in-process'])
      .hideHelp(),
  )
  program.addOption(
    new Option('--agent-type <type>', 'Custom agent type for this teammate').hideHelp(),
  )

  // 为所有构建启用 SDK URL 但从帮助中隐藏
  program.addOption(
    new Option(
      '--sdk-url <url>',
      'Use remote WebSocket endpoint for SDK I/O streaming (only with -p and stream-json format)',
    ).hideHelp(),
  )

  // 为所有构建启用 teleport/remote 标志，但在 GA 之前保持未文档化
  program.addOption(
    new Option(
      '--teleport [session]',
      'Resume a teleport session, optionally specify session ID',
    ).hideHelp(),
  )
  program.addOption(
    new Option(
      '--remote [description]',
      'Create a remote session with the given description',
    ).hideHelp(),
  )
  if (feature('BRIDGE_MODE')) {
    program.addOption(
      new Option(
        '--remote-control [name]',
        'Start an interactive session with Remote Control enabled (optionally named)',
      )
        .argParser((value) => value || true)
        .hideHelp(),
    )
    program.addOption(
      new Option('--rc [name]', 'Alias for --remote-control')
        .argParser((value) => value || true)
        .hideHelp(),
    )
  }
  if (feature('HARD_FAIL')) {
    program.addOption(
      new Option('--hard-fail', 'Crash on logError calls instead of silently logging').hideHelp(),
    )
  }
  profileCheckpoint('run_main_options_built')

  // -p/--print 模式：跳过子命令注册。52 个子命令
  //（mcp、auth、plugin、skill、task、config、doctor、update 等）
  // 在打印模式下从不调度 —— commander 将提示路由到
  // 默认 action。子命令注册路径在基线上测量约 65ms
  // —— 主要是 isBridgeEnabled() 调用（25ms 设置 Zod 解析
  // + 40ms 同步 keychain 子进程），两者都被 try/catch 隐藏，
  // 在 enableConfigs() 之前总是返回 false。cc:// URL 在 main() 约第 851 行
  // 在此运行之前重写为 `open`，所以此处的 argv 检查是安全的。
  const isPrintMode = process.argv.includes('-p') || process.argv.includes('--print')
  const isCcUrl = process.argv.some((a) => a.startsWith('cc://') || a.startsWith('cc+unix://'))
  if (isPrintMode && !isCcUrl) {
    profileCheckpoint('run_before_parse')
    await program.parseAsync(process.argv)
    profileCheckpoint('run_after_parse')
    return program
  }

  // zy mcp

  const mcp = program
    .command('mcp')
    .description('Configure and manage MCP servers')
    .configureHelp(createSortedHelpConfig())
    .enablePositionalOptions()
  mcp
    .command('serve')
    .description(`Start the ZY Code MCP server`)
    .option('-d, --debug', 'Enable debug mode', () => true)
    .option('--verbose', 'Override verbose mode setting from config', () => true)
    .action(async ({ debug, verbose }: { debug?: boolean; verbose?: boolean }) => {
      const { mcpServeHandler } = await import('./cli/handlers/mcp.js')
      await mcpServeHandler({
        debug,
        verbose,
      })
    })

  // 注册 mcp add 子命令（为可测试性提取）
  registerMcpAddCommand(mcp)
  if (isXaaEnabled()) {
    registerMcpXaaIdpCommand(mcp)
  }
  mcp
    .command('remove <name>')
    .description('Remove an MCP server')
    .option(
      '-s, --scope <scope>',
      'Configuration scope (local, user, or project) - if not specified, removes from whichever scope it exists in',
    )
    .action(
      async (
        name: string,
        options: {
          scope?: string
        },
      ) => {
        const { mcpRemoveHandler } = await import('./cli/handlers/mcp.js')
        await mcpRemoveHandler(name, options)
      },
    )
  mcp
    .command('list')
    .description(
      'List configured MCP servers. Note: The workspace trust dialog is skipped and stdio servers from .mcp.json are spawned for health checks. Only use this command in directories you trust.',
    )
    .action(async () => {
      const { mcpListHandler } = await import('./cli/handlers/mcp.js')
      await mcpListHandler()
    })
  mcp
    .command('get <name>')
    .description(
      'Get details about an MCP server. Note: The workspace trust dialog is skipped and stdio servers from .mcp.json are spawned for health checks. Only use this command in directories you trust.',
    )
    .action(async (name: string) => {
      const { mcpGetHandler } = await import('./cli/handlers/mcp.js')
      await mcpGetHandler(name)
    })
  mcp
    .command('add-json <name> <json>')
    .description('Add an MCP server (stdio or SSE) with a JSON string')
    .option('-s, --scope <scope>', 'Configuration scope (local, user, or project)', 'local')
    .option('--client-secret', 'Prompt for OAuth client secret (or set MCP_CLIENT_SECRET env var)')
    .action(
      async (
        name: string,
        json: string,
        options: {
          scope?: string
          clientSecret?: true
        },
      ) => {
        const { mcpAddJsonHandler } = await import('./cli/handlers/mcp.js')
        await mcpAddJsonHandler(name, json, options)
      },
    )
  mcp
    .command('add-from-zy-desktop')
    .description('Import MCP servers from Zy Desktop (Mac and WSL only)')
    .option('-s, --scope <scope>', 'Configuration scope (local, user, or project)', 'local')
    .action(async (options: { scope?: string }) => {
      const { mcpAddFromDesktopHandler } = await import('./cli/handlers/mcp.js')
      await mcpAddFromDesktopHandler(options)
    })
  mcp
    .command('reset-project-choices')
    .description(
      'Reset all approved and rejected project-scoped (.mcp.json) servers within this project',
    )
    .action(async () => {
      const { mcpResetChoicesHandler } = await import('./cli/handlers/mcp.js')
      await mcpResetChoicesHandler()
    })

  // zy server
  if (feature('DIRECT_CONNECT')) {
    program
      .command('server')
      .description('Start a ZY Code session server')
      .option('--port <number>', 'HTTP port', '0')
      .option('--host <string>', 'Bind address', '0.0.0.0')
      .option('--auth-token <token>', 'Bearer token for auth')
      .option('--unix <path>', 'Listen on a unix domain socket')
      .option('--workspace <dir>', 'Default working directory for sessions that do not specify cwd')
      .option(
        '--idle-timeout <ms>',
        'Idle timeout for detached sessions in ms (0 = never expire)',
        '600000',
      )
      .option('--max-sessions <n>', 'Maximum concurrent sessions (0 = unlimited)', '32')
      .action(
        async (opts: {
          port: string
          host: string
          authToken?: string
          unix?: string
          workspace?: string
          idleTimeout: string
          maxSessions: string
        }) => {
          const { randomBytes } = await import('crypto')
          const {
            // @ts-ignore
            startServer,
          } = await import('./server/server.js')
          const {
            // @ts-ignore
            SessionManager,
          } = await import('./server/sessionManager.js')
          const {
            // @ts-ignore
            DangerousBackend,
          } = await import('./server/backends/dangerousBackend.js')
          const {
            // @ts-ignore
            printBanner,
          } = await import('./server/serverBanner.js')
          const {
            // @ts-ignore
            createServerLogger,
          } = await import('./server/serverLog.js')
          const {
            // @ts-ignore
            writeServerLock,
            // @ts-ignore
            removeServerLock,
            // @ts-ignore
            probeRunningServer,
          } = await import('./server/lockfile.js')
          const existing = await probeRunningServer()
          if (existing) {
            process.stderr.write(
              `A ZY server is already running (pid ${existing.pid}) at ${existing.httpUrl}\n`,
            )
            process.exit(1)
          }
          const authToken = opts.authToken ?? `sk-ant-cc-${randomBytes(16).toString('base64url')}`
          const config = {
            port: parseInt(opts.port, 10),
            host: opts.host,
            authToken,
            unix: opts.unix,
            workspace: opts.workspace,
            idleTimeoutMs: parseInt(opts.idleTimeout, 10),
            maxSessions: parseInt(opts.maxSessions, 10),
          }
          const backend = new DangerousBackend()
          const sessionManager = new SessionManager(backend, {
            idleTimeoutMs: config.idleTimeoutMs,
            maxSessions: config.maxSessions,
          })
          const logger = createServerLogger()
          const server = startServer(config, sessionManager, logger)
          const actualPort = server.port ?? config.port
          printBanner(config, authToken, actualPort)
          await writeServerLock({
            pid: process.pid,
            port: actualPort,
            host: config.host,
            httpUrl: config.unix ? `unix:${config.unix}` : `http://${config.host}:${actualPort}`,
            startedAt: Date.now(),
          })
          let shuttingDown = false
          const shutdown = async () => {
            if (shuttingDown) return
            shuttingDown = true
            // 在拆除会话之前停止接受新连接。
            server.stop(true)
            await sessionManager.destroyAll()
            await removeServerLock()
            process.exit(0)
          }
          process.once('SIGINT', () => void shutdown())
          process.once('SIGTERM', () => void shutdown())
        },
      )
  }

  // `zy ssh <host> [dir]` —— 仅在此处注册以便 --help 显示它。
  // 实际的交互流程由 main() 中的早期 argv 重写处理
  //（与上方的 DIRECT_CONNECT/cc:// 模式并行）。如果 commander 到达
  // 此 action 意味着 argv 重写没有触发（例如用户运行
  // `zy ssh` 没有主机）—— 只打印用法。
  if (feature('SSH_REMOTE')) {
    program
      .command('ssh <host> [dir]')
      .description(
        'Run ZY Code on a remote host over SSH. Deploys the binary and ' +
          'tunnels API auth back through your local machine — no remote setup needed.',
      )
      .option('--permission-mode <mode>', 'Permission mode for the remote session')
      .option(
        '--dangerously-skip-permissions',
        'Skip all permission prompts on the remote (dangerous)',
      )
      .option(
        '--local',
        'e2e test mode — spawn the child CLI locally (skip ssh/deploy). ' +
          'Exercises the auth proxy and unix-socket plumbing without a remote host.',
      )
      .action(async () => {
        // main() 中的 argv 重写应该在 commander 运行之前消费 `ssh <host>`。
        // 到达这里意味着主机缺失或
        // 重写谓词不匹配。
        process.stderr.write(
          'Usage: zy ssh <user@host | ssh-config-alias> [dir]\n\n' +
            "Runs ZY Code on a remote Linux host. You don't need to install\n" +
            'anything on the remote or run `zy auth login` there — the binary is\n' +
            'deployed over SSH and API auth tunnels back through your local machine.\n',
        )
        process.exit(1)
      })
  }

  // zy connect —— 子命令仅处理 -p（无头）模式。
  // 交互模式（不带 -p）由 main() 中的早期 argv 重写处理
  // 重定向到主命令，具有完整 TUI 支持。
  if (feature('DIRECT_CONNECT')) {
    // @ts-ignore
    program
      .command('open <cc-url>')
      .description('Connect to a ZY Code server (internal — use cc:// URLs)')
      .option('-p, --print [prompt]', 'Print mode (headless)')
      .option('--output-format <format>', 'Output format: text, json, stream-json', 'text')
      .action(
        async (
          ccUrl: string,
          opts: {
            print?: string | boolean
            outputFormat?: string
          },
        ) => {
          const {
            // @ts-ignore
            parseConnectUrl,
          } = await import('./server/parseConnectUrl.js')
          const { serverUrl, authToken } = (parseConnectUrl as any)(ccUrl)
          let connectConfig
          try {
            const session = await createDirectConnectSession({
              serverUrl,
              authToken,
              cwd: getOriginalCwd(),
              dangerouslySkipPermissions: _pendingConnect?.dangerouslySkipPermissions,
            })
            if (session.workDir) {
              setOriginalCwd(session.workDir)
              setCwdState(session.workDir)
            }
            setDirectConnectServerUrl(serverUrl)
            connectConfig = session.config
          } catch (err) {
            // biome-ignore lint/suspicious/noConsole: intentional error output
            console.error(err instanceof DirectConnectError ? err.message : String(err))
            process.exit(1)
          }
          const {
            // @ts-ignore
            runConnectHeadless,
          } = await import('./server/connectHeadless.js')
          const prompt = typeof opts.print === 'string' ? opts.print : ''
          const interactive = opts.print === true
          await runConnectHeadless(connectConfig, prompt, opts.outputFormat, interactive)
        },
      )
  }

  // zy auth

  const auth = program
    .command('auth')
    .description('Manage authentication')
    .configureHelp(createSortedHelpConfig())
  auth
    .command('login')
    .description('Sign in to your account')
    .option('--email <email>', 'Pre-populate email address on the login page')
    .option('--sso', 'Force SSO login flow')
    .option('--console', 'Use Console (API usage billing) instead of Zy subscription')
    .option('--zyai', 'Use Zy subscription (default)')
    .action(
      async ({
        email,
        sso,
        console: useConsole,
        zyai,
      }: {
        email?: string
        sso?: boolean
        console?: boolean
        zyai?: boolean
      }) => {
        const { authLogin } = await import('./cli/handlers/auth.js')
        await authLogin({
          email,
          sso,
          console: useConsole,
          zyai,
        })
      },
    )
  auth
    .command('status')
    .description('Show authentication status')
    .option('--json', 'Output as JSON (default)')
    .option('--text', 'Output as human-readable text')
    .action(async (opts: { json?: boolean; text?: boolean }) => {
      const { authStatus } = await import('./cli/handlers/auth.js')
      await authStatus(opts)
    })
  auth
    .command('logout')
    .description('Log out from your account')
    .action(async () => {
      const { authLogout } = await import('./cli/handlers/auth.js')
      await authLogout()
    })

  /**
   * Helper function to handle marketplace command errors consistently.
   * Logs the error and exits the process with status 1.
   * @param error The error that occurred
   * @param action Description of the action that failed
   */
  // 在所有插件/市场子命令上的隐藏标志，以 targeting cowork_plugins。
  const coworkOption = () => new Option('--cowork', 'Use cowork_plugins directory').hideHelp()

  // Plugin validate command
  const pluginCmd = program
    .command('plugin')
    .alias('plugins')
    .description('Manage ZY Code plugins')
    .configureHelp(createSortedHelpConfig())
  pluginCmd
    .command('validate <path>')
    .description('Validate a plugin or marketplace manifest')
    .addOption(coworkOption())
    .action(
      async (
        manifestPath: string,
        options: {
          cowork?: boolean
        },
      ) => {
        const { pluginValidateHandler } = await import('./cli/handlers/plugins.js')
        await pluginValidateHandler(manifestPath, options)
      },
    )

  // Plugin list command
  pluginCmd
    .command('list')
    .description('List installed plugins')
    .option('--json', 'Output as JSON')
    .option('--available', 'Include available plugins from marketplaces (requires --json)')
    .addOption(coworkOption())
    .action(async (options: { json?: boolean; available?: boolean; cowork?: boolean }) => {
      const { pluginListHandler } = await import('./cli/handlers/plugins.js')
      await pluginListHandler(options)
    })

  // Marketplace subcommands
  const marketplaceCmd = pluginCmd
    .command('marketplace')
    .description('Manage ZY Code marketplaces')
    .configureHelp(createSortedHelpConfig())
  marketplaceCmd
    .command('add <source>')
    .description('Add a marketplace from a URL, path, or GitHub repo')
    .addOption(coworkOption())
    .option(
      '--sparse <paths...>',
      'Limit checkout to specific directories via git sparse-checkout (for monorepos). Example: --sparse .zy-plugin plugins',
    )
    .option(
      '--scope <scope>',
      'Where to declare the marketplace: user (default), project, or local',
    )
    .action(
      async (
        source: string,
        options: {
          cowork?: boolean
          sparse?: string[]
          scope?: string
        },
      ) => {
        const { marketplaceAddHandler } = await import('./cli/handlers/plugins.js')
        await marketplaceAddHandler(source, options)
      },
    )
  marketplaceCmd
    .command('list')
    .description('List all configured marketplaces')
    .option('--json', 'Output as JSON')
    .addOption(coworkOption())
    .action(async (options: { json?: boolean; cowork?: boolean }) => {
      const { marketplaceListHandler } = await import('./cli/handlers/plugins.js')
      await marketplaceListHandler(options)
    })
  marketplaceCmd
    .command('remove <name>')
    .alias('rm')
    .description('Remove a configured marketplace')
    .addOption(coworkOption())
    .action(
      async (
        name: string,
        options: {
          cowork?: boolean
        },
      ) => {
        const { marketplaceRemoveHandler } = await import('./cli/handlers/plugins.js')
        await marketplaceRemoveHandler(name, options)
      },
    )
  marketplaceCmd
    .command('update [name]')
    .description('Update marketplace(s) from their source - updates all if no name specified')
    .addOption(coworkOption())
    .action(
      async (
        name: string | undefined,
        options: {
          cowork?: boolean
        },
      ) => {
        const { marketplaceUpdateHandler } = await import('./cli/handlers/plugins.js')
        await marketplaceUpdateHandler(name, options)
      },
    )

  // Plugin install command
  pluginCmd
    .command('install <plugin>')
    .alias('i')
    .description(
      'Install a plugin from available marketplaces (use plugin@marketplace for specific marketplace)',
    )
    .option('-s, --scope <scope>', 'Installation scope: user, project, or local', 'user')
    .addOption(coworkOption())
    .action(
      async (
        plugin: string,
        options: {
          scope?: string
          cowork?: boolean
        },
      ) => {
        const { pluginInstallHandler } = await import('./cli/handlers/plugins.js')
        await pluginInstallHandler(plugin, options)
      },
    )

  // Plugin uninstall command
  pluginCmd
    .command('uninstall <plugin>')
    .alias('remove')
    .alias('rm')
    .description('Uninstall an installed plugin')
    .option('-s, --scope <scope>', 'Uninstall from scope: user, project, or local', 'user')
    .option(
      '--keep-data',
      "Preserve the plugin's persistent data directory (~/.zy/plugins/data/{id}/)",
    )
    .addOption(coworkOption())
    .action(
      async (
        plugin: string,
        options: {
          scope?: string
          cowork?: boolean
          keepData?: boolean
        },
      ) => {
        const { pluginUninstallHandler } = await import('./cli/handlers/plugins.js')
        await pluginUninstallHandler(plugin, options)
      },
    )

  // Plugin enable command
  pluginCmd
    .command('enable <plugin>')
    .description('Enable a disabled plugin')
    .option(
      '-s, --scope <scope>',
      `Installation scope: ${VALID_INSTALLABLE_SCOPES.join(', ')} (default: auto-detect)`,
    )
    .addOption(coworkOption())
    .action(
      async (
        plugin: string,
        options: {
          scope?: string
          cowork?: boolean
        },
      ) => {
        const { pluginEnableHandler } = await import('./cli/handlers/plugins.js')
        await pluginEnableHandler(plugin, options)
      },
    )

  // Plugin disable command
  pluginCmd
    .command('disable [plugin]')
    .description('Disable an enabled plugin')
    .option('-a, --all', 'Disable all enabled plugins')
    .option(
      '-s, --scope <scope>',
      `Installation scope: ${VALID_INSTALLABLE_SCOPES.join(', ')} (default: auto-detect)`,
    )
    .addOption(coworkOption())
    .action(
      async (
        plugin: string | undefined,
        options: {
          scope?: string
          cowork?: boolean
          all?: boolean
        },
      ) => {
        const { pluginDisableHandler } = await import('./cli/handlers/plugins.js')
        await pluginDisableHandler(plugin, options)
      },
    )

  // Plugin update command
  pluginCmd
    .command('update <plugin>')
    .description('Update a plugin to the latest version (restart required to apply)')
    .option(
      '-s, --scope <scope>',
      `Installation scope: ${VALID_UPDATE_SCOPES.join(', ')} (default: user)`,
    )
    .addOption(coworkOption())
    .action(
      async (
        plugin: string,
        options: {
          scope?: string
          cowork?: boolean
        },
      ) => {
        const { pluginUpdateHandler } = await import('./cli/handlers/plugins.js')
        await pluginUpdateHandler(plugin, options)
      },
    )
  // END ANT-ONLY

  // Setup token command
  program
    .command('setup-token')
    .description('Set up a long-lived authentication token (requires ZY subscription)')
    .action(async () => {
      const [{ setupTokenHandler }, { createRoot }] = await Promise.all([
        import('./cli/handlers/util.js'),
        import('./ink.js'),
      ])
      const root = await createRoot(getBaseRenderOptions(false))
      await setupTokenHandler(root)
    })

  // Agents command - list configured agents
  program
    .command('agents')
    .description('List configured agents')
    .option(
      '--setting-sources <sources>',
      'Comma-separated list of setting sources to load (user, project, local).',
    )
    .action(async () => {
      const { agentsHandler } = await import('./cli/handlers/agents.js')
      await agentsHandler()
      process.exit(0)
    })
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    // Skip when zy_auto_mode_config.enabled === 'disabled' (circuit breaker).
    // Reads from disk cache — GrowthBook isn't initialized at registration time.
    if (getAutoModeEnabledStateIfCached() !== 'disabled') {
      const autoModeCmd = program
        .command('auto-mode')
        .description('Inspect auto mode classifier configuration')
      autoModeCmd
        .command('defaults')
        .description('Print the default auto mode environment, allow, and deny rules as JSON')
        .action(async () => {
          const { autoModeDefaultsHandler } = await import('./cli/handlers/autoMode.js')
          autoModeDefaultsHandler()
          process.exit(0)
        })
      autoModeCmd
        .command('config')
        .description(
          'Print the effective auto mode config as JSON: your settings where set, defaults otherwise',
        )
        .action(async () => {
          const { autoModeConfigHandler } = await import('./cli/handlers/autoMode.js')
          autoModeConfigHandler()
          process.exit(0)
        })
      autoModeCmd
        .command('critique')
        .description('Get AI feedback on your custom auto mode rules')
        .option('--model <model>', 'Override which model is used')
        .action(async (options) => {
          const { autoModeCritiqueHandler } = await import('./cli/handlers/autoMode.js')
          await autoModeCritiqueHandler(options)
          process.exit()
        })
    }
  }

  // Remote Control command — connect local environment to zy.ai/code.
  // The actual command is intercepted by the fast-path in cli.tsx before
  // Commander.js runs, so this registration exists only for help output.
  // Always hidden: isBridgeEnabled() at this point (before enableConfigs)
  // would throw → getGlobalConfig and return
  // false via the try/catch — but not before paying ~65ms of side effects
  // (25ms settings Zod parse + 40ms sync `security` keychain subprocess).
  // The dynamic visibility never worked; the command was always hidden.
  if (feature('BRIDGE_MODE')) {
    program
      .command('remote-control', {
        hidden: true,
      })
      .alias('rc')
      .description('Connect your local environment for remote-control sessions via zy.ai/code')
      .action(async () => {
        // Unreachable — cli.tsx fast-path handles this command before main.tsx loads.
        // If somehow reached, delegate to bridgeMain.
        const { bridgeMain } = await import('./bridge/bridgeMain.js')
        await bridgeMain(process.argv.slice(3))
      })
  }
  if (feature('KAIROS')) {
    program
      .command('assistant [sessionId]')
      .description(
        'Attach the REPL as a client to a running bridge session. Discovers sessions via API if no sessionId given.',
      )
      .action(() => {
        // Argv rewriting above should have consumed `assistant [id]`
        // before commander runs. Reaching here means a root flag came first
        // (e.g. `--debug assistant`) and the position-0 predicate
        // didn't match. Print usage like the ssh stub does.
        process.stderr.write(
          'Usage: zy assistant [sessionId]\n\n' +
            'Attach the REPL as a viewer client to a running bridge session.\n' +
            'Omit sessionId to discover and pick from available sessions.\n',
        )
        process.exit(1)
      })
  }

  // 医生命令 —— 检查安装健康状态
  program
    .command('doctor')
    .description(
      'Check the health of your ZY Code auto-updater. Note: The workspace trust dialog is skipped and stdio servers from .mcp.json are spawned for health checks. Only use this command in directories you trust.',
    )
    .action(async () => {
      const [{ doctorHandler }, { createRoot }] = await Promise.all([
        import('./cli/handlers/util.js'),
        import('./ink.js'),
      ])
      const root = await createRoot(getBaseRenderOptions(false))
      await doctorHandler(root)
    })

  // zy update
  //
  // 对于符合 SemVer 的版本控制带构建元数据（X.X.X+SHA）：
  // - 我们执行精确字符串比较（包括 SHA）以检测任何更改
  // - 这确保用户始终获得最新构建，即使只有 SHA 更改
  // - UI 显示两个版本包括构建元数据以便清晰
  program
    .command('update')
    .alias('upgrade')
    .description('Check for updates and install if available')
    .action(async () => {
      const { update } = await import('src/cli/update.js')
      await update()
    })

  // zy up — run the project's CLAUDE.md "# zy up" setup instructions.
  if (isInternalBuild()) {
    program
      .command('up')
      .description(
        '[INNER-ONLY] Initialize or upgrade the local dev environment using the "# zy up" section of the nearest CLAUDE.md',
      )
      .action(async () => {
        const {
          // @ts-ignore
          up,
        } = await import('src/cli/up.js')
        await up()
      })
  }

  // zy rollback（仅限 ant）
  // 回滚到之前的版本
  if (isInternalBuild()) {
    program
      .command('rollback [target]')
      .description(
        '[INNER-ONLY] Roll back to a previous release\n\nExamples:\n  zy rollback                                    Go 1 version back from current\n  zy rollback 3                                  Go 3 versions back from current\n  zy rollback 2.0.73-dev.20251217.t190658        Roll back to a specific version',
      )
      .option('-l, --list', 'List recent published versions with ages')
      .option('--dry-run', 'Show what would be installed without installing')
      .option(
        '--safe',
        'Roll back to the server-pinned safe version (set by oncall during incidents)',
      )
      .action(
        async (
          target?: string,
          options?: {
            list?: boolean
            dryRun?: boolean
            safe?: boolean
          },
        ) => {
          const {
            // @ts-ignore
            rollback,
          } = await import('src/cli/rollback.js')
          await rollback(target, options)
        },
      )
  }

  // zy install
  program
    .command('install [target]')
    .description(
      'Install ZY Code native build. Use [target] to specify version (stable, latest, or specific version)',
    )
    .option('--force', 'Force installation even if already installed')
    .action(
      async (
        target: string | undefined,
        options: {
          force?: boolean
        },
      ) => {
        const { installHandler } = await import('./cli/handlers/util.js')
        await installHandler(target, options)
      },
    )

  // 仅限 ant 的命令
  if (isInternalBuild()) {
    const validateLogId = (value: string) => {
      const maybeSessionId = validateUuid(value)
      if (maybeSessionId) return maybeSessionId
      return Number(value)
    }
    // zy log
    program
      .command('log')
      .description('[INNER-ONLY] Manage conversation logs.')
      .argument(
        '[number|sessionId]',
        'A number (0, 1, 2, etc.) to display a specific log, or the sesssion ID (uuid) of a log',
        validateLogId,
      )
      .action(async (logId: string | number | undefined) => {
        const {
          // @ts-ignore
          logHandler,
        } = await import('./cli/handlers/ant.js')
        await logHandler(logId)
      })

    // zy error
    program
      .command('error')
      .description(
        '[INNER-ONLY] View error logs. Optionally provide a number (0, -1, -2, etc.) to display a specific log.',
      )
      .argument('[number]', 'A number (0, 1, 2, etc.) to display a specific log', parseInt)
      .action(async (number: number | undefined) => {
        const {
          // @ts-ignore
          errorHandler,
        } = await import('./cli/handlers/ant.js')
        await errorHandler(number)
      })

    // zy export
    program
      .command('export')
      .description('[INNER-ONLY] Export a conversation to a text file.')
      .usage('<source> <outputFile>')
      .argument(
        '<source>',
        'Session ID, log index (0, 1, 2...), or path to a .json/.jsonl log file',
      )
      .argument('<outputFile>', 'Output file path for the exported text')
      .addHelpText(
        'after',
        `
Examples:
  $ zy export 0 conversation.txt                Export conversation at log index 0
  $ zy export <uuid> conversation.txt           Export conversation by session ID
  $ zy export input.json output.txt             Render JSON log file to text
  $ zy export <uuid>.jsonl output.txt           Render JSONL session file to text`,
      )
      .action(async (source: string, outputFile: string) => {
        const {
          // @ts-ignore
          exportHandler,
        } = await import('./cli/handlers/ant.js')
        await exportHandler(source, outputFile)
      })
    if (isInternalBuild()) {
      const taskCmd = program.command('task').description('[INNER-ONLY] Manage task list tasks')
      taskCmd
        .command('create <subject>')
        .description('Create a new task')
        .option('-d, --description <text>', 'Task description')
        .option('-l, --list <id>', 'Task list ID (defaults to "tasklist")')
        .action(
          async (
            subject: string,
            opts: {
              description?: string
              list?: string
            },
          ) => {
            const {
              // @ts-ignore
              taskCreateHandler,
            } = await import('./cli/handlers/ant.js')
            await taskCreateHandler(subject, opts)
          },
        )
      taskCmd
        .command('list')
        .description('List all tasks')
        .option('-l, --list <id>', 'Task list ID (defaults to "tasklist")')
        .option('--pending', 'Show only pending tasks')
        .option('--json', 'Output as JSON')
        .action(async (opts: { list?: string; pending?: boolean; json?: boolean }) => {
          const {
            // @ts-ignore
            taskListHandler,
          } = await import('./cli/handlers/ant.js')
          await taskListHandler(opts)
        })
      taskCmd
        .command('get <id>')
        .description('Get details of a task')
        .option('-l, --list <id>', 'Task list ID (defaults to "tasklist")')
        .action(
          async (
            id: string,
            opts: {
              list?: string
            },
          ) => {
            const {
              // @ts-ignore
              taskGetHandler,
            } = await import('./cli/handlers/ant.js')
            await taskGetHandler(id, opts)
          },
        )
      taskCmd
        .command('update <id>')
        .description('Update a task')
        .option('-l, --list <id>', 'Task list ID (defaults to "tasklist")')
        .option('-s, --status <status>', `Set status (${TASK_STATUSES.join(', ')})`)
        .option('--subject <text>', 'Update subject')
        .option('-d, --description <text>', 'Update description')
        .option('--owner <agentId>', 'Set owner')
        .option('--clear-owner', 'Clear owner')
        .action(
          async (
            id: string,
            opts: {
              list?: string
              status?: string
              subject?: string
              description?: string
              owner?: string
              clearOwner?: boolean
            },
          ) => {
            const {
              // @ts-ignore
              taskUpdateHandler,
            } = await import('./cli/handlers/ant.js')
            await taskUpdateHandler(id, opts)
          },
        )
      taskCmd
        .command('dir')
        .description('Show the tasks directory path')
        .option('-l, --list <id>', 'Task list ID (defaults to "tasklist")')
        .action(async (opts: { list?: string }) => {
          const {
            // @ts-ignore
            taskDirHandler,
          } = await import('./cli/handlers/ant.js')
          await taskDirHandler(opts)
        })
    }

    // zy completion <shell>
    program
      .command('completion <shell>', {
        hidden: true,
      })
      .description('Generate shell completion script (bash, zsh, or fish)')
      .option('--output <file>', 'Write completion script directly to a file instead of stdout')
      .action(
        async (
          shell: string,
          opts: {
            output?: string
          },
        ) => {
          const {
            // @ts-ignore
            completionHandler,
          } = await import('./cli/handlers/ant.js')
          await completionHandler(shell, opts, program)
        },
      )
  }

  profileCheckpoint('run_before_parse')
  await program.parseAsync(process.argv)

  profileCheckpoint('run_after_parse')

  // 记录最终checkpoint 用于 total_time 计算
  profileCheckpoint('main_after_run')

  // 将启动性能记录到 Statsig（采样）并在启用时输出详细报告
  profileReport()
  return program
}
async function logTenguInit({
  hasInitialPrompt,
  hasStdin,
  verbose,
  debug,
  debugToStderr,
  print,
  outputFormat,
  inputFormat,
  numAllowedTools,
  numDisallowedTools,
  mcpClientCount,
  worktreeEnabled,
  skipWebFetchPreflight,
  githubActionInputs,
  dangerouslySkipPermissionsPassed,
  permissionMode,
  modeIsBypass,
  allowDangerouslySkipPermissionsPassed,
  systemPromptFlag,
  appendSystemPromptFlag,
  thinkingConfig,
  assistantActivationPath,
}: {
  hasInitialPrompt: boolean
  hasStdin: boolean
  verbose: boolean
  debug: boolean
  debugToStderr: boolean
  print: boolean
  outputFormat: string
  inputFormat: string
  numAllowedTools: number
  numDisallowedTools: number
  mcpClientCount: number
  worktreeEnabled: boolean
  skipWebFetchPreflight: boolean | undefined
  githubActionInputs: string | undefined
  dangerouslySkipPermissionsPassed: boolean
  permissionMode: string
  modeIsBypass: boolean
  allowDangerouslySkipPermissionsPassed: boolean
  systemPromptFlag: 'file' | 'flag' | undefined
  appendSystemPromptFlag: 'file' | 'flag' | undefined
  thinkingConfig: ThinkingConfig
  assistantActivationPath: string | undefined
}): Promise<void> {
  try {
    logEvent('zy_init', {
      entrypoint: 'zy' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      hasInitialPrompt,
      hasStdin,
      verbose,
      debug,
      debugToStderr,
      print,
      outputFormat: outputFormat as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      inputFormat: inputFormat as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      numAllowedTools,
      numDisallowedTools,
      mcpClientCount,
      worktree: worktreeEnabled,
      skipWebFetchPreflight,
      ...(githubActionInputs && {
        githubActionInputs:
          githubActionInputs as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      dangerouslySkipPermissionsPassed,
      permissionMode: permissionMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      modeIsBypass,
      inProtectedNamespace: isInProtectedNamespace(),
      allowDangerouslySkipPermissionsPassed,
      thinkingType:
        thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...(systemPromptFlag && {
        systemPromptFlag:
          systemPromptFlag as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...(appendSystemPromptFlag && {
        appendSystemPromptFlag:
          appendSystemPromptFlag as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      is_simple: isBareMode() || undefined,
      is_coordinator:
        feature('COORDINATOR_MODE') && coordinatorModeModule?.isCoordinatorMode()
          ? true
          : undefined,
      ...(assistantActivationPath && {
        assistantActivationPath:
          assistantActivationPath as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      autoUpdatesChannel: (getInitialSettings().autoUpdatesChannel ??
        'latest') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...(isInternalBuild()
        ? (() => {
            const cwd = getCwd()
            const gitRoot = findGitRoot(cwd)
            const rp = gitRoot ? relative(gitRoot, cwd) || '.' : undefined
            return rp
              ? {
                  relativeProjectPath:
                    rp as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                }
              : {}
          })()
        : {}),
    })
  } catch (error) {
    logError(error)
  }
}
function maybeActivateProactive(options: unknown): void {
  if (
    (feature('PROACTIVE') || feature('KAIROS')) &&
    ((
      options as {
        proactive?: boolean
      }
    ).proactive ||
      isEnvTruthy(process.env.ZY_CODE_PROACTIVE))
  ) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const proactiveModule = require('./proactive/index.js')
    if (!proactiveModule.isProactiveActive()) {
      proactiveModule.activateProactive('command')
    }
  }
}
function maybeActivateBrief(options: unknown): void {
  if (!(feature('KAIROS') || feature('KAIROS_BRIEF'))) return
  const briefFlag = (
    options as {
      brief?: boolean
    }
  ).brief
  const briefEnv = isEnvTruthy(process.env.ZY_CODE_BRIEF)
  if (!briefFlag && !briefEnv) return
  // --brief / ZY_CODE_BRIEF 是显式选择加入：检查授权，
  // 然后设置 userMsgOptIn 以激活工具 + 提示部分。env
  // 变量也授予授权（isBriefEntitled() 读取它），所以设置
  // ZY_CODE_BRIEF=1  alone 为开发/测试强制启用 —— 不需要 GB 门
  //。initialIsBriefOnly 直接读取 getUserMsgOptIn()。
  // 条件导入：静态导入会将工具名称字符串泄漏到
  // 外部构建中，通过 BriefTool.ts → prompt.ts。
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { isBriefEntitled } =
    require('./tools/BriefTool/BriefTool.js') as typeof import('./tools/BriefTool/BriefTool.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const entitled = isBriefEntitled()
  if (entitled) {
    setUserMsgOptIn(true)
  }
  // 一旦看到意图就无条件触发：enabled=false 在 Datadog 中捕获
  // "用户尝试但被门控"的失败模式。
  logEvent('zy_brief_mode_enabled', {
    enabled: entitled,
    gated: !entitled,
    source: (briefEnv
      ? 'env'
      : 'flag') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}
function resetCursor() {
  const terminal = process.stderr.isTTY
    ? process.stderr
    : process.stdout.isTTY
      ? process.stdout
      : undefined
  terminal?.write(SHOW_CURSOR)
}
type TeammateOptions = {
  agentId?: string
  agentName?: string
  teamName?: string
  agentColor?: string
  planModeRequired?: boolean
  parentSessionId?: string
  teammateMode?: 'auto' | 'tmux' | 'in-process'
  agentType?: string
}
function extractTeammateOptions(options: unknown): TeammateOptions {
  if (typeof options !== 'object' || options === null) {
    return {}
  }
  const opts = options as Record<string, unknown>
  const teammateMode = opts.teammateMode
  return {
    agentId: typeof opts.agentId === 'string' ? opts.agentId : undefined,
    agentName: typeof opts.agentName === 'string' ? opts.agentName : undefined,
    teamName: typeof opts.teamName === 'string' ? opts.teamName : undefined,
    agentColor: typeof opts.agentColor === 'string' ? opts.agentColor : undefined,
    planModeRequired:
      typeof opts.planModeRequired === 'boolean' ? opts.planModeRequired : undefined,
    parentSessionId: typeof opts.parentSessionId === 'string' ? opts.parentSessionId : undefined,
    teammateMode:
      teammateMode === 'auto' || teammateMode === 'tmux' || teammateMode === 'in-process'
        ? teammateMode
        : undefined,
    agentType: typeof opts.agentType === 'string' ? opts.agentType : undefined,
  }
}
