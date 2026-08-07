/**
 * Permission 启动初始化：CLI 模式解析、权限上下文构建。
 *
 * 从 permissionSetup.ts 提取。包含 initialPermissionModeFromCLI 和
 * initializeToolPermissionContext 等启动阶段函数。
 */
import { getOriginalCwd } from '../../bootstrap/runtime/runtimeContext.js'
import type { ToolPermissionContext } from '../../tools/tool.js'
import { isEnvTruthy, isInternalBuild } from '../../services/infra/envUtils.js'
import {
  getInitialSettings,
  hasTrustedDefaultModeAuto,
  hasUntrustedAutoModeSettings,
} from '../settings/settings.js'
import { permissionModeFromString, type PermissionMode } from './permissionMode.js'
import { applyPermissionRulesToPermissionContext } from './permissionRuleSync.js'
import { loadAllPermissionRulesFromDisk } from './permissionsLoader.js'
import { parseToolListFromCLI, parseBaseToolsFromCLI } from './permissionCli.js'
import { getAutoModeEnabledStateIfCached, isAutoModeGateEnabled } from './autoModePolicy.js'
import { resolve } from 'node:path'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import {
  addDirHelpMessage,
  validateDirectoryForWorkspace,
} from '../../commands/add-dir/validation.js'
import { getToolsForDefaultPreset } from '../../tools/tools.js'
import { createDebugLog } from '../../services/infra/debug.js'
import { getFsImplementation, safeResolvePath } from '../../services/infra/fsOperations.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  type DangerousPermissionInfo,
  findDangerousClassifierPermissions,
  findOverlyBroadBashPermissions,
  findOverlyBroadPowerShellPermissions,
} from './dangerousPermissionRules.js'
import type { PermissionRule } from './permissionRule.js'
import { type AdditionalWorkingDirectory, applyPermissionUpdate } from './permissionUpdate.ts'
import {
  normalizeLegacyToolName,
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from './permissionRuleParser.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = true
  ? (require('./autoModeState.js') as typeof import('./autoModeState.js'))
  : null

const permLog = createDebugLog('permission-bootstrap')

/**
 * 检查 processPwd 是否为指向 originalCwd 的符号链接
 */
function isSymlinkTo({
  processPwd,
  originalCwd,
}: {
  processPwd: string
  originalCwd: string
}): boolean {
  // 使用 safeResolvePath 检查 processPwd 是否为符号链接并获取其解析后的路径
  const { resolvedPath: resolvedProcessPwd, isSymlink: isProcessPwdSymlink } = safeResolvePath(
    getFsImplementation(),
    processPwd,
  )

  return isProcessPwdSymlink ? resolvedProcessPwd === resolve(originalCwd) : false
}

/**
 * 将 CLI 标志安全地转换为 PermissionMode
 */
export function initialPermissionModeFromCLI({
  permissionModeCli,
  dangerouslySkipPermissions,
}: {
  permissionModeCli: string | undefined
  dangerouslySkipPermissions: boolean | undefined
}): { mode: PermissionMode; notification?: string } {
  const settings = getInitialSettings() || {}

  // 首先检查 GrowthBook 门控 — 最高优先级
  const growthBookDisableBypassPermissionsMode = checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
    'zy_disable_bypass_permissions_mode',
  )

  // 然后检查设置 — 较低优先级
  const settingsDisableBypassPermissionsMode =
    settings.permissions?.disableBypassPermissionsMode === 'disable'

  // Statsig 门控优先于设置
  const disableBypassPermissionsMode =
    growthBookDisableBypassPermissionsMode || settingsDisableBypassPermissionsMode

  // 同步熔断器检查（缓存的 GB 读取）。当 auto 模式实际无法进入时，
  // 阻止 AutoModeOptInDialog 在 showSetupScreens() 中显示。
  // autoModeFlagCli 仍然将意图传递到 verifyAutoModeGateAccess，
  // 它会通知用户原因。
  const autoModeCircuitBrokenSync = true ? getAutoModeEnabledStateIfCached() === 'disabled' : false

  // 模式按优先级排序
  const orderedModes: PermissionMode[] = []
  let notification: string | undefined

  if (dangerouslySkipPermissions) {
    orderedModes.push('bypassPermissions')
  }
  if (permissionModeCli) {
    const parsedMode = permissionModeFromString(permissionModeCli)
    if (parsedMode === 'auto') {
      if (autoModeCircuitBrokenSync) {
        permLog('auto mode circuit breaker active (cached) — falling back to default', {
          level: 'warn',
        })
      } else {
        orderedModes.push('auto')
      }
    } else {
      orderedModes.push(parsedMode)
    }
  }
  if (settings.permissions?.defaultMode) {
    const settingsMode = settings.permissions.defaultMode as PermissionMode
    // CCR 仅支持 acceptEdits 和 plan — 忽略设置中的其他 defaultMode
    // （例如 bypassPermissions 否则会在远程环境中静默授予完全访问权限）。
    if (
      isEnvTruthy(process.env.ZY_CODE_REMOTE) &&
      !['acceptEdits', 'plan', 'default', 'auto'].includes(settingsMode)
    ) {
      permLog(
        `settings defaultMode "${settingsMode}" is not supported in ZY_CODE_REMOTE — only acceptEdits, plan, default, and auto are allowed`,
        { level: 'warn' },
      )
      logEvent('zy_ccr_unsupported_default_mode_ignored', {
        mode: settingsMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
    // defaultMode:auto 仅信任 user/flag/policy（对齐 CC 2.1.207）。
    // project/local 为仓库可控，静默授予 auto 构成权限越权面。
    else if (settingsMode === 'auto') {
      if (!hasTrustedDefaultModeAuto()) {
        permLog(
          'settings defaultMode "auto" ignored — only policy/user/flag settings may grant auto mode (projectSettings and localSettings are repo-controllable)',
          { level: 'warn' },
        )
      } else if (autoModeCircuitBrokenSync) {
        permLog('auto mode circuit breaker active (cached) — falling back to default', {
          level: 'warn',
        })
      } else {
        orderedModes.push('auto')
      }
    } else {
      orderedModes.push(settingsMode)
    }
  }

  // project/local 中的 autoMode 规则或 defaultMode:auto 被忽略时打一次遥测
  if (hasUntrustedAutoModeSettings()) {
    logEvent('zy_settings_auto_mode_untrusted_source_ignored', {})
  }

  let result: { mode: PermissionMode; notification?: string } | undefined

  for (const mode of orderedModes) {
    if (mode === 'bypassPermissions' && disableBypassPermissionsMode) {
      if (growthBookDisableBypassPermissionsMode) {
        permLog('bypassPermissions mode is disabled by Statsig gate', {
          level: 'warn',
        })
        notification = 'Bypass permissions mode was disabled by your organization policy'
      } else {
        permLog('bypassPermissions mode is disabled by settings', {
          level: 'warn',
        })
        notification = 'Bypass permissions mode was disabled by settings'
      }
      continue // 如果此模式被禁用则跳过
    }

    result = { mode, notification } // 使用第一个有效模式
    break
  }

  if (!result) {
    result = { mode: 'default', notification }
  }

  if (!result) {
    result = { mode: 'default', notification }
  }

  if (result.mode === 'auto') {
    autoModeStateModule?.setAutoModeActive(true)
  }

  return result
}

export async function initializeToolPermissionContext({
  allowedToolsCli,
  disallowedToolsCli,
  baseToolsCli,
  permissionMode,
  allowDangerouslySkipPermissions,
  addDirs,
}: {
  allowedToolsCli: string[]
  disallowedToolsCli: string[]
  baseToolsCli?: string[]
  permissionMode: PermissionMode
  allowDangerouslySkipPermissions: boolean
  addDirs: string[]
}): Promise<{
  toolPermissionContext: ToolPermissionContext
  warnings: string[]
  dangerousPermissions: DangerousPermissionInfo[]
  overlyBroadBashPermissions: DangerousPermissionInfo[]
}> {
  // 解析逗号分隔的允许和禁止工具（如果提供）
  // 规范化旧版工具名称（例如 'Task' → 'Agent'），以便
  // stripDangerousPermissionsForAutoMode 中的内存规则移除能正确匹配。
  const parsedAllowedToolsCli = parseToolListFromCLI(allowedToolsCli).map((rule) =>
    permissionRuleValueToString(permissionRuleValueFromString(rule)),
  )
  let parsedDisallowedToolsCli = parseToolListFromCLI(disallowedToolsCli)

  // 如果指定了基础工具，自动拒绝不在基础集合中的所有工具
  // 我们需要检查基础工具是否被显式提供（而不仅仅是空默认值）
  if (baseToolsCli && baseToolsCli.length > 0) {
    const baseToolsResult = parseBaseToolsFromCLI(baseToolsCli)
    // 规范化旧版工具名称（例如 'Task' → 'Agent'），以便用户提供的
    // 使用旧名称的基础工具列表仍能匹配规范名称。
    const baseToolsSet = new Set(baseToolsResult.map(normalizeLegacyToolName))
    const allToolNames = getToolsForDefaultPreset()
    const toolsToDisallow = allToolNames.filter((tool) => !baseToolsSet.has(tool))
    parsedDisallowedToolsCli = [...parsedDisallowedToolsCli, ...toolsToDisallow]
  }

  const warnings: string[] = []
  const additionalWorkingDirectories = new Map<string, AdditionalWorkingDirectory>()
  // process.env.PWD 可能是符号链接，而 getOriginalCwd() 使用真实路径
  const processPwd = process.env.PWD
  if (
    processPwd &&
    processPwd !== getOriginalCwd() &&
    isSymlinkTo({ originalCwd: getOriginalCwd(), processPwd })
  ) {
    additionalWorkingDirectories.set(processPwd, {
      path: processPwd,
      source: 'session',
    })
  }

  // 检查 bypassPermissions 模式是否可用（未被 Statsig 门控或设置禁用）
  // 使用缓存值以避免阻塞启动
  const growthBookDisableBypassPermissionsMode = checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
    'zy_disable_bypass_permissions_mode',
  )
  const settings = getInitialSettings() || {}
  const settingsDisableBypassPermissionsMode =
    settings.permissions?.disableBypassPermissionsMode === 'disable'
  const isBypassPermissionsModeAvailable =
    (permissionMode === 'bypassPermissions' || allowDangerouslySkipPermissions) &&
    !growthBookDisableBypassPermissionsMode &&
    !settingsDisableBypassPermissionsMode

  // 从磁盘加载所有权限规则
  const rulesFromDisk = loadAllPermissionRulesFromDisk()

  // 仅 Ant：检测所有模式下过于宽泛的 shell 放行规则。
  // Bash(*) 或 PowerShell(*) 对于该 shell 等同于 YOLO 模式。
  // 在 CCR/BYOC 中跳过，因为 --allowed-tools 是预期的预批准机制。
  // 变量名保留以保持返回字段兼容；包含两个 shell。
  let overlyBroadBashPermissions: DangerousPermissionInfo[] = []
  if (
    isInternalBuild() &&
    !isEnvTruthy(process.env.ZY_CODE_REMOTE) &&
    process.env.ZY_CODE_ENTRYPOINT !== 'local-agent'
  ) {
    overlyBroadBashPermissions = [
      ...findOverlyBroadBashPermissions(rulesFromDisk, parsedAllowedToolsCli),
      ...findOverlyBroadPowerShellPermissions(rulesFromDisk, parsedAllowedToolsCli),
    ]
  }

  // 仅 Ant：检测 auto 模式下危险的 shell 权限
  // 危险权限（如 Bash(*)、Bash(python:*)、PowerShell(iex:*)）会在分类器评估之前自动放行，
  // 从而使更安全的 YOLO 模式失去意义
  let dangerousPermissions: DangerousPermissionInfo[] = []
  if (permissionMode === 'auto') {
    dangerousPermissions = findDangerousClassifierPermissions(rulesFromDisk, parsedAllowedToolsCli)
  }

  let toolPermissionContext = applyPermissionRulesToPermissionContext(
    {
      mode: permissionMode,
      additionalWorkingDirectories,
      alwaysAllowRules: { cliArg: parsedAllowedToolsCli },
      alwaysDenyRules: { cliArg: parsedDisallowedToolsCli },
      alwaysAskRules: {},
      isBypassPermissionsModeAvailable,
      ...(true ? { isAutoModeAvailable: isAutoModeGateEnabled() } : {}),
    },
    rulesFromDisk,
  )

  // 从设置和 --add-dir 添加目录
  const allAdditionalDirectories = [
    ...(settings.permissions?.additionalDirectories || []),
    ...addDirs,
  ]
  // 并行执行 fs 验证；串行应用更新（累积上下文）。
  // validateDirectoryForWorkspace 仅读取 permissionContext 以检查目录是否已被覆盖 —
  // 与并行化的行为差异是无害的（两个重叠的 --add-dir 都成功，
  // 而不是其中一个被标记为 alreadyInWorkingDirectory，这本来也被静默跳过了）。
  const validationResults = await Promise.all(
    allAdditionalDirectories.map((dir) =>
      validateDirectoryForWorkspace(dir, toolPermissionContext),
    ),
  )
  for (const result of validationResults) {
    if (result.resultType === 'success') {
      toolPermissionContext = applyPermissionUpdate(toolPermissionContext, {
        type: 'addDirectories',
        directories: [result.absolutePath],
        destination: 'cliArg',
      })
    } else if (
      result.resultType !== 'alreadyInWorkingDirectory' &&
      result.resultType !== 'pathNotFound'
    ) {
      // 对实际的配置错误发出警告（例如指定了文件而非目录）。
      // 但如果目录已不存在（例如某人在 /tmp 下工作而它被清除了），则静默跳过。
      // 如果他们稍后尝试访问它，会再次收到提示。
      warnings.push(addDirHelpMessage(result))
    }
  }

  return {
    toolPermissionContext,
    warnings,
    dangerousPermissions,
    overlyBroadBashPermissions,
  }
}
