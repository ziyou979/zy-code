import { relative } from 'node:path'
import { getInitialMainLoopModel } from 'src/bootstrap/runtime/runtimeContext.js'
import { isAnalyticsDisabled } from '../../services/analytics/config.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { getGhAuthStatus } from '../../services/github/ghAuthStatus.js'
import { getDefaultMainLoopModel, parseUserSpecifiedModel } from '../../services/model/model.js'
import { SandboxManager } from '../../services/sandbox/sandboxAdapter.js'
import {
  logPluginLoadErrors,
  logPluginsEnabledForSession,
} from '../../services/telemetry/pluginTelemetry.js'
import { logSkillsLoaded } from '../../services/telemetry/skillLoadedEvent.js'
import type { LoadedPlugin, PluginError, PluginLoadResult } from '../../services/plugins/types.js'
import { isAutoUpdaterDisabled } from '../../services/config/config.js'
import { getContextWindowForModel } from '../../services/context/modelContext.js'
import { getCwd } from '../../services/environment/cwd.js'
import {
  hasNodeOption,
  isBareMode,
  isInProtectedNamespace,
  isInternalBuild,
} from '../../services/infra/envUtils.js'
import { findGitRoot, getIsGit, getWorktreeCount } from '../../services/infra/git.js'
import { logError } from '../../services/infra/log.js'
import { getManagedPluginNames } from '../../services/plugins/managedPlugins.js'
import { getPluginSeedDirs } from '../../services/plugins/pluginDirectories.js'
import { loadAllPluginsCacheOnly } from '../../services/plugins/pluginLoader.js'
import { getInitialSettings } from '../../services/settings/settings.js'
import type { ThinkingConfig } from '../../services/messages/thinking.js'
/**
 * 每个会话的技能/插件遥测。从交互路径和无头 -p 路径（在 runHeadless 之前）
 * 调用 —— 两者都经过 main.tsx 但在交互启动路径之前分支，所以需要两个
 * 调用点，而不是一个在这里 + 一个在 QueryEngine 中。
 */
export function logSessionTelemetry(): void {
  const fallbackModel = getInitialMainLoopModel() ?? getDefaultMainLoopModel()
  if (!fallbackModel) {
    return // 模型未配置时跳过遥测
  }
  const model = parseUserSpecifiedModel(fallbackModel)
  void logSkillsLoaded(getCwd(), getContextWindowForModel(model))
  void (loadAllPluginsCacheOnly() as Promise<PluginLoadResult>)
    .then(({ enabled, errors }) => {
      const managedNames = getManagedPluginNames()
      logPluginsEnabledForSession(enabled, managedNames, getPluginSeedDirs())
      logPluginLoadErrors(errors, managedNames)
    })
    .catch((err: unknown) => logError(err))
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

export async function logStartupTelemetry(): Promise<void> {
  if (isAnalyticsDisabled()) {
    return
  }
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

export type LogTenguInitParams = {
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
  // 由 caller 计算并注入，避免 logTenguInit 反向耦合到 coordinator 模块的
  // feature() 条件 require —— DCE 仍在 caller 侧生效。
  isCoordinator: boolean
}

export async function logTenguInit({
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
  isCoordinator,
}: LogTenguInitParams): Promise<void> {
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
      is_coordinator: isCoordinator ? true : undefined,
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
