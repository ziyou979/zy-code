import { feature } from 'bun:bundle'
import {
  getOriginalCwd,
  handleAutoModeTransition,
  handlePlanModeTransition,
  setHasExitedPlanMode,
  setNeedsAutoModeExitAttachment,
} from '../../bootstrap/runtime/runtimeContext.js'
import type { ToolPermissionContext } from '../../tools/tool.js'
import { isEnvTruthy, isInternalBuild } from '../../utils/envUtils.js'
import {
  getInitialSettings,
  getUseAutoModeDuringPlan,
  hasAutoModeOptIn,
  hasTrustedDefaultModeAuto,
  hasUntrustedAutoModeSettings,
} from '../settings/settings.js'
import { type PermissionMode, permissionModeFromString } from './permissionMode.js'
import { applyPermissionRulesToPermissionContext } from './permissions.js'
import { loadAllPermissionRulesFromDisk } from './permissionsLoader.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = true
  ? (require('./autoModeState.js') as typeof import('./autoModeState.js'))
  : null

import { resolve } from 'node:path'
import {
  checkSecurityRestrictionGate,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE,
  getDynamicConfig_BLOCKS_ON_INIT,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from 'src/services/analytics/growthbook.js'
import { getMainLoopModel } from 'src/services/model/model.js'
import { ToolPermissionRulesBySource } from 'src/types/permissions.ts'
import {
  addDirHelpMessage,
  validateDirectoryForWorkspace,
} from '../../commands/add-dir/validation.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import { getToolsForDefaultPreset, parseToolPreset } from '../../tools/tools.js'
import { modelSupportsAutoMode } from '../feature-flags/betas.js'
import { createDebugLog } from '../../utils/debug.js'
import { getFsImplementation, safeResolvePath } from '../../utils/fsOperations.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  type DangerousPermissionInfo,
  findDangerousClassifierPermissions,
  findOverlyBroadBashPermissions,
  findOverlyBroadPowerShellPermissions,
  removeDangerousPermissions,
  restoreDangerousPermissions,
  stripDangerousPermissionsForAutoMode,
} from './permissionDangerousRuleSupport.js'
import type { PermissionRule } from './permissionRule.js'
import { type AdditionalWorkingDirectory, applyPermissionUpdate } from './permissionUpdate.js'
import {
  normalizeLegacyToolName,
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from './permissionRuleParser.js'

const permLog = createDebugLog('permissions')

/**
 * 处理切换权限模式时的所有状态转换。
 * 集中化副作用，使每条激活路径（CLI Shift+Tab、SDK 控制消息等）行为一致。
 *
 * 当前处理：
 * - 进入/退出 plan 模式的附件（通过 handlePlanModeTransition）
 * - auto 模式激活：setAutoModeActive、stripDangerousPermissionsForAutoMode
 *
 * 返回（可能已修改的）上下文。调用者负责在返回的上下文上设置模式。
 *
 * @param fromMode 当前权限模式
 * @param toMode 目标权限模式
 * @param context 当前工具权限上下文
 */
export function transitionPermissionMode(
  fromMode: string,
  toMode: string,
  context: ToolPermissionContext,
): ToolPermissionContext {
  // plan→plan（SDK set_permission_mode）会错误地命中下方的 leave 分支
  if (fromMode === toMode) {
    return context
  }

  handlePlanModeTransition(fromMode, toMode)
  handleAutoModeTransition(fromMode, toMode)

  if (fromMode === 'plan' && toMode !== 'plan') {
    setHasExitedPlanMode(true)
  }

  if (toMode === 'plan' && fromMode !== 'plan') {
    return prepareContextForPlanMode(context)
  }

  // 带 auto 激活的 plan 模式算作使用了分类器（在离开侧）。
  // isAutoModeActive() 是权威信号 — prePlanMode/strippedDangerousRules
  // 是不可靠的代理，因为 auto 可以在 plan 中间被停用（非 opt-in
  // 进入、transitionPlanAutoMode），而这些字段仍然保持设置/未设置。
  const fromUsesClassifier =
    fromMode === 'auto' ||
    (fromMode === 'plan' && (autoModeStateModule?.isAutoModeActive() ?? false))
  const toUsesClassifier = toMode === 'auto' // plan 进入已在上方处理

  if (toUsesClassifier && !fromUsesClassifier) {
    if (!isAutoModeGateEnabled()) {
      throw new Error('Cannot transition to auto mode: gate is not enabled')
    }
    autoModeStateModule?.setAutoModeActive(true)
    context = stripDangerousPermissionsForAutoMode(context)
  } else if (fromUsesClassifier && !toUsesClassifier) {
    autoModeStateModule?.setAutoModeActive(false)
    setNeedsAutoModeExitAttachment(true)
    context = restoreDangerousPermissions(context)
  }

  // 仅在有需要时才展开（保持引用相等性）
  if (fromMode === 'plan' && toMode !== 'plan' && context.prePlanMode) {
    return { ...context, prePlanMode: undefined }
  }

  return context
}

/**
 * 从 CLI 解析基础工具规格
 * 处理预设名称（default、none）和自定义工具列表
 */
export function parseBaseToolsFromCLI(baseTools: string[]): string[] {
  // 拼接数组所有元素，检查是否为单个预设名称
  const joinedInput = baseTools.join(' ').trim()
  const preset = parseToolPreset(joinedInput)

  if (preset) {
    return getToolsForDefaultPreset()
  }

  // 作为自定义工具列表解析，使用与 allowedTools/disallowedTools 相同的解析逻辑
  const parsedTools = parseToolListFromCLI(baseTools)

  return parsedTools
}

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

export function parseToolListFromCLI(tools: string[]): string[] {
  if (tools.length === 0) {
    return []
  }

  const result: string[] = []

  // 处理数组中的每个字符串
  for (const toolString of tools) {
    if (!toolString) {
      continue
    }

    let current = ''
    let isInParens = false

    // 解析字符串中的每个字符
    for (const char of toolString) {
      switch (char) {
        case '(':
          isInParens = true
          current += char
          break
        case ')':
          isInParens = false
          current += char
          break
        case ',':
          if (isInParens) {
            current += char
          } else {
            // 逗号分隔符 — 推送当前工具并开始新的工具
            if (current.trim()) {
              result.push(current.trim())
            }
            current = ''
          }
          break
        case ' ':
          if (isInParens) {
            current += char
          } else if (current.trim()) {
            // 空格分隔符 — 推送当前工具并开始新的工具
            result.push(current.trim())
            current = ''
          }
          break
        default:
          current += char
      }
    }

    // 推送任何剩余的工具
    if (current.trim()) {
      result.push(current.trim())
    }
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

export type AutoModeGateCheckResult = {
  // 转换函数（而非预先计算的上下文），以便调用者可以将其应用于
  // setAppState(prev => ...) 中的当前上下文。预先计算上下文会捕获
  // 过时的快照：下方的异步 GrowthBook await 可能被轮次中的 shift-tab
  // 超越，返回 { ...currentContext, ... } 会覆盖用户的模式更改。
  updateContext: (ctx: ToolPermissionContext) => ToolPermissionContext
  notification?: string
}

export type AutoModeUnavailableReason = 'settings' | 'circuit-breaker' | 'model'

export function getAutoModeUnavailableNotification(reason: AutoModeUnavailableReason): string {
  let base: string
  switch (reason) {
    case 'settings':
      base = 'auto mode disabled by settings'
      break
    case 'circuit-breaker':
      base = 'auto mode is unavailable for your plan'
      break
    case 'model':
      base = 'auto mode unavailable for this model'
      break
  }
  return isInternalBuild() ? `${base} · #zy-code-feedback` : base
}

/**
 * auto 模式可用性的异步检查。
 *
 * 返回转换函数（而非预先计算的上下文），调用者在 setAppState(prev => ...)
 * 中针对当前上下文应用。这可以防止异步 GrowthBook await 覆盖轮次中的
 * 模式更改（例如用户在检查进行中 shift-tab 切换到 acceptEdits）。
 *
 * 转换函数会针对新鲜的 ctx 重新检查 mode/prePlanMode，以避免在 await
 * 期间将用户踢出他们已经离开的模式。
 */
export async function verifyAutoModeGateAccess(
  currentContext: ToolPermissionContext,
): Promise<AutoModeGateCheckResult> {
  // auto 模式配置 — 在所有构建中运行（熔断器、轮播、踢出）
  // 重新读取 zy_auto_mode_config.enabled — 此异步检查在 GrowthBook 初始化后运行一次，
  // 是 isAutoModeAvailable 的权威来源。同步启动路径使用过时缓存；此检查进行修正。
  // 熔断器（enabled==='disabled'）在此生效。
  const autoModeConfig = await getDynamicConfig_BLOCKS_ON_INIT<{
    enabled?: AutoModeEnabledState
  }>('zy_auto_mode_config', {})
  const enabledState = parseAutoModeEnabledState(autoModeConfig?.enabled)
  const disabledBySettings = isAutoModeDisabledBySettings()
  // 将设置禁用在熔断器语义上与 GrowthBook 'disabled' 同等对待 —
  // 阻止 SDK/显式重新进入（通过 isAutoModeGateEnabled()）。
  autoModeStateModule?.setAutoModeCircuitBroken(enabledState === 'disabled' || disabledBySettings)

  // 轮播可用性：未被熔断、未被设置禁用、模型支持，且（已启用或已 opt-in）
  const mainModel = getMainLoopModel()!
  const modelSupported = modelSupportsAutoMode(mainModel)
  let carouselAvailable = false
  if (enabledState !== 'disabled' && !disabledBySettings && modelSupported) {
    carouselAvailable = enabledState === 'enabled' || hasAutoModeOptInAnySource()
  }
  // canEnterAuto 门控显式进入（--permission-mode auto、defaultMode: auto）
  // — 显式进入本身就是一种 opt-in，因此我们仅基于熔断器 + 设置 + 模型进行阻止
  const canEnterAuto = enabledState !== 'disabled' && !disabledBySettings && modelSupported
  permLog(
    `[auto-mode] verifyAutoModeGateAccess: enabledState=${enabledState} disabledBySettings=${disabledBySettings} model=${mainModel} modelSupported=${modelSupported} carouselAvailable=${carouselAvailable} canEnterAuto=${canEnterAuto}`,
  )

  // 现在捕获 CLI 标志意图（不依赖于上下文）。
  const autoModeFlagCli = autoModeStateModule?.getAutoModeFlagCli() ?? false

  // 返回转换函数，针对当前上下文重新评估依赖于上下文的条件。
  // 上方的异步 GrowthBook 结果（canEnterAuto、carouselAvailable 等）
  // 被闭包捕获 — 这些不依赖于上下文。但 mode、prePlanMode 和
  // isAutoModeAvailable 检查必须使用新鲜的 ctx，否则 await 期间的
  // shift-tab 会被回退（或者更糟：如果用户在 await 期间进入了 auto 模式，
  // 尽管熔断器已设置，用户仍会留在 auto 中 — 因为 setAutoModeCircuitBroken
  // 在 await 之后才运行）。
  const setAvailable = (ctx: ToolPermissionContext, available: boolean): ToolPermissionContext => {
    if (ctx.isAutoModeAvailable !== available) {
      permLog(
        `[auto-mode] verifyAutoModeGateAccess setAvailable: ${ctx.isAutoModeAvailable} -> ${available}`,
      )
    }
    return ctx.isAutoModeAvailable === available ? ctx : { ...ctx, isAutoModeAvailable: available }
  }

  if (canEnterAuto) {
    return { updateContext: (ctx) => setAvailable(ctx, carouselAvailable) }
  }

  // 门控关闭或熔断 — 确定原因（与上下文无关）。
  let reason: AutoModeUnavailableReason
  if (disabledBySettings) {
    reason = 'settings'
    permLog('auto mode disabled: disableAutoMode in settings', {
      level: 'warn',
    })
  } else if (enabledState === 'disabled') {
    reason = 'circuit-breaker'
    permLog('auto mode disabled: zy_auto_mode_config.enabled === "disabled" (circuit breaker)', {
      level: 'warn',
    })
  } else {
    reason = 'model'
    permLog(`auto mode disabled: model ${getMainLoopModel()} does not support auto mode`, {
      level: 'warn',
    })
  }
  const notification = getAutoModeUnavailableNotification(reason)

  // 统一踢出转换。重新检查新鲜上下文，仅在踢出实际适用时触发
  // 副作用（setAutoModeActive(false)、setNeedsAutoModeExitAttachment）。
  // 这使得 autoModeActive 与 toolPermissionContext.mode 保持同步，
  // 即使用户在 await 期间更改了模式：如果他们已自行离开 auto，
  // handleCycleMode 已停用分类器，我们不再触发；
  // 如果他们在 await 期间进入了 auto（在 setAutoModeCircuitBroken 生效前可能），
  // 我们在这里踢出他们。
  const kickOutOfAutoIfNeeded = (ctx: ToolPermissionContext): ToolPermissionContext => {
    const inAuto = ctx.mode === 'auto'
    permLog(
      `[auto-mode] kickOutOfAutoIfNeeded applying: ctx.mode=${ctx.mode} ctx.prePlanMode=${ctx.prePlanMode} reason=${reason}`,
    )
    // 带 auto 激活的 plan 模式：来自 prePlanMode='auto'（从 auto 进入）或 opt-in（存在 strippedDangerousRules）。
    const inPlanWithAutoActive =
      ctx.mode === 'plan' && (ctx.prePlanMode === 'auto' || !!ctx.strippedDangerousRules)
    if (!inAuto && !inPlanWithAutoActive) {
      return setAvailable(ctx, false)
    }
    if (inAuto) {
      autoModeStateModule?.setAutoModeActive(false)
      setNeedsAutoModeExitAttachment(true)
      return {
        ...applyPermissionUpdate(restoreDangerousPermissions(ctx), {
          type: 'setMode',
          mode: 'default',
          destination: 'session',
        }),
        isAutoModeAvailable: false,
      }
    }
    // plan 模式下 auto 激活：停用 auto、恢复权限、解除 prePlanMode
    // 以便 ExitPlanMode 进入 default。
    autoModeStateModule?.setAutoModeActive(false)
    setNeedsAutoModeExitAttachment(true)
    return {
      ...restoreDangerousPermissions(ctx),
      prePlanMode: ctx.prePlanMode === 'auto' ? 'default' : ctx.prePlanMode,
      isAutoModeAvailable: false,
    }
  }

  // 通知决策使用过时上下文 — 这没问题：我们根据检查启动时用户在做什么来决定
  // 是否通知。（副作用和模式变更在上方转换函数中决定，针对新鲜上下文。）
  const wasInAuto = currentContext.mode === 'auto'
  // auto 在 plan 期间被使用：从 auto 进入或 opt-in auto 已激活
  const autoActiveDuringPlan =
    currentContext.mode === 'plan' &&
    (currentContext.prePlanMode === 'auto' || !!currentContext.strippedDangerousRules)
  const wantedAuto = wasInAuto || autoActiveDuringPlan || autoModeFlagCli

  if (!wantedAuto) {
    // 用户在调用时不需要 auto — 不通知。但仍应用完整的踢出转换：
    // 如果他们在 await 期间 shift-tab 进入了 auto（在 setAutoModeCircuitBroken 生效前），我们需要驱逐他们。
    return { updateContext: kickOutOfAutoIfNeeded }
  }

  if (wasInAuto || autoActiveDuringPlan) {
    // 用户在 auto 中或 plan 期间 auto 已激活 — 踢出 + 通知。
    return { updateContext: kickOutOfAutoIfNeeded, notification }
  }

  // 仅 autoModeFlagCli：defaultMode 为 auto 但同步检查拒绝了它。
  // 如果 isAutoModeAvailable 已经为 false，则抑制通知（已在之前的检查中通知过；
  // 防止在连续切换到不支持的模型时重复通知）。
  return {
    updateContext: kickOutOfAutoIfNeeded,
    notification: currentContext.isAutoModeAvailable ? notification : undefined,
  }
}

/**
 * 核心逻辑：根据 Statsig 门控检查是否应禁用 bypassPermissions
 */
export function shouldDisableBypassPermissions(): Promise<boolean> {
  return checkSecurityRestrictionGate('zy_disable_bypass_permissions_mode')
}

function isAutoModeDisabledBySettings(): boolean {
  const settings = getInitialSettings() || {}
  return (
    (settings as { disableAutoMode?: 'disable' }).disableAutoMode === 'disable' ||
    (settings.permissions as { disableAutoMode?: 'disable' } | undefined)?.disableAutoMode ===
      'disable'
  )
}

/**
 * 检查 auto 模式是否可以进入：熔断器未激活且设置未禁用它。同步。
 */
export function isAutoModeGateEnabled(): boolean {
  if (autoModeStateModule?.isAutoModeCircuitBroken() ?? false) {
    return false
  }
  if (isAutoModeDisabledBySettings()) {
    return false
  }
  return modelSupportsAutoMode(getMainLoopModel()!)
}

/**
 * 返回 auto 模式当前不可用的原因，如果可用则返回 null。
 * 同步 — 使用由 verifyAutoModeGateAccess 填充的状态。
 */
export function getAutoModeUnavailableReason(): AutoModeUnavailableReason | null {
  if (isAutoModeDisabledBySettings()) {
    return 'settings'
  }
  if (autoModeStateModule?.isAutoModeCircuitBroken() ?? false) {
    return 'circuit-breaker'
  }
  if (!modelSupportsAutoMode(getMainLoopModel()!)) {
    return 'model'
  }
  return null
}

/**
 * zy_auto_mode_config GrowthBook JSON 配置中的 `enabled` 字段。
 * 控制 auto 模式在 UI 表面（CLI、IDE、Desktop）中的可用性。
 * - 'enabled'：auto 模式在 shift-tab 轮播（或等效物）中可用
 * - 'disabled'：auto 模式完全不可用 — 用于事件响应的熔断器
 * - 'opt-in'：auto 模式仅在用户显式 opt-in 后可用
 *   （通过 CLI 中的 --enable-auto-mode，或 IDE/Desktop 中的设置切换）
 */
export type AutoModeEnabledState = 'enabled' | 'disabled' | 'opt-in'

const AUTO_MODE_ENABLED_DEFAULT: AutoModeEnabledState = 'enabled'

function parseAutoModeEnabledState(value: unknown): AutoModeEnabledState {
  if (value === 'enabled' || value === 'disabled' || value === 'opt-in') {
    return value
  }
  return AUTO_MODE_ENABLED_DEFAULT
}

/**
 * 读取 zy_auto_mode_config 中的 `enabled` 字段（缓存，可能过时）。
 * 如果 GrowthBook 不可用或字段未设置，默认为 'disabled'。
 * 其他表面（IDE、Desktop）应调用此函数来决定是否在其模式选择器中展示 auto 模式。
 */
export function getAutoModeEnabledState(): AutoModeEnabledState {
  // dev 模式下直接启用（绕过 GrowthBook 远程配置默认 disabled）
  if (isEnvTruthy(process.env.ZY_CODE_DEV_AUTO_MODE)) {
    return 'enabled'
  }
  const config = getFeatureValue_CACHED_MAY_BE_STALE<{
    enabled?: AutoModeEnabledState
  }>('zy_auto_mode_config', {})
  return parseAutoModeEnabledState(config?.enabled)
}

const NO_CACHED_AUTO_MODE_CONFIG = Symbol('no-cached-auto-mode-config')

/**
 * 类似 getAutoModeEnabledState，但在没有缓存值时返回 undefined
 * （冷启动，GrowthBook 初始化之前）。由 initialPermissionModeFromCLI 中的
 * 同步熔断器检查使用，不能将"尚未获取"与"已获取并禁用"混为一谈 —
 * 前者委托给 verifyAutoModeGateAccess，后者立即阻止。
 */
export function getAutoModeEnabledStateIfCached(): AutoModeEnabledState | undefined {
  // dev 模式下直接启用（绕过 GrowthBook 远程配置默认 disabled）
  if (isEnvTruthy(process.env.ZY_CODE_DEV_AUTO_MODE)) {
    return 'enabled'
  }
  const config = getFeatureValue_CACHED_MAY_BE_STALE<
    { enabled?: AutoModeEnabledState } | typeof NO_CACHED_AUTO_MODE_CONFIG
  >('zy_auto_mode_config', NO_CACHED_AUTO_MODE_CONFIG)
  if (config === NO_CACHED_AUTO_MODE_CONFIG) {
    return undefined
  }
  return parseAutoModeEnabledState(config?.enabled)
}

/**
 * 如果用户通过任何受信任机制 opt-in 了 auto 模式，则返回 true：
 * - CLI 标志（--enable-auto-mode / --permission-mode auto）— 会话范围的可用性请求；
 *   showSetupScreens() 中的启动对话框在 REPL 渲染之前强制执行持久同意。
 * - skipAutoPermissionPrompt 设置（持久化；通过接受 opt-in 对话框或
 *   IDE/Desktop 设置切换来设置）
 */
export function hasAutoModeOptInAnySource(): boolean {
  if (autoModeStateModule?.getAutoModeFlagCli() ?? false) {
    return true
  }
  return hasAutoModeOptIn()
}

/**
 * 检查 bypassPermissions 模式当前是否被 Statsig 门控或设置禁用。
 * 这是使用缓存 Statsig 值的同步版本。
 */
export function isBypassPermissionsModeDisabled(): boolean {
  const growthBookDisableBypassPermissionsMode = checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
    'zy_disable_bypass_permissions_mode',
  )
  const settings = getInitialSettings() || {}
  const settingsDisableBypassPermissionsMode =
    settings.permissions?.disableBypassPermissionsMode === 'disable'

  return growthBookDisableBypassPermissionsMode || settingsDisableBypassPermissionsMode
}

/**
 * 创建禁用 bypassPermissions 模式的更新上下文
 */
export function createDisabledBypassPermissionsContext(
  currentContext: ToolPermissionContext,
): ToolPermissionContext {
  let updatedContext = currentContext
  if (currentContext.mode === 'bypassPermissions') {
    updatedContext = applyPermissionUpdate(currentContext, {
      type: 'setMode',
      mode: 'default',
      destination: 'session',
    })
  }

  return {
    ...updatedContext,
    isBypassPermissionsModeAvailable: false,
  }
}

/**
 * 根据 Statsig 门控异步检查是否应禁用 bypassPermissions 模式，
 * 并在需要时返回更新后的 toolPermissionContext
 */
export async function checkAndDisableBypassPermissions(
  currentContext: ToolPermissionContext,
): Promise<void> {
  // 仅在 bypassPermissions 模式可用时继续
  if (!currentContext.isBypassPermissionsModeAvailable) {
    return
  }

  const shouldDisable = await shouldDisableBypassPermissions()
  if (!shouldDisable) {
    return
  }

  // 门控已启用，需要禁用 bypassPermissions 模式
  permLog('bypassPermissions mode is being disabled by Statsig gate (async check)', {
    level: 'warn',
  })

  void gracefulShutdown(1, 'bypass_permissions_disabled')
}

export function isDefaultPermissionModeAuto(): boolean {
  // 仅可信源的 defaultMode:auto 生效（project/local 忽略）
  return hasTrustedDefaultModeAuto()
}

/**
 * plan 模式是否应使用 auto 模式语义（分类器在 plan 期间运行）。
 * 当用户已 opt-in auto 模式且门控已启用时为 true。
 * 在权限检查时评估，因此对配置更改是响应式的。
 */
export function shouldPlanUseAutoMode(): boolean {
  return hasAutoModeOptIn() && isAutoModeGateEnabled() && getUseAutoModeDuringPlan()
  return false
}

/**
 * 集中化的 plan 模式入口。将当前模式暂存为 prePlanMode，
 * 以便 ExitPlanMode 可以恢复它。当用户已 opt-in auto 模式时，
 * auto 语义在 plan 模式期间保持激活。
 */
export function prepareContextForPlanMode(context: ToolPermissionContext): ToolPermissionContext {
  const currentMode = context.mode
  if (currentMode === 'plan') {
    return context
  }
  const planAutoMode = shouldPlanUseAutoMode()
  if (currentMode === 'auto') {
    if (planAutoMode) {
      return { ...context, prePlanMode: 'auto' }
    }
    autoModeStateModule?.setAutoModeActive(false)
    setNeedsAutoModeExitAttachment(true)
    return {
      ...restoreDangerousPermissions(context),
      prePlanMode: 'auto',
    }
  }
  if (planAutoMode && currentMode !== 'bypassPermissions') {
    autoModeStateModule?.setAutoModeActive(true)
    return {
      ...stripDangerousPermissionsForAutoMode(context),
      prePlanMode: currentMode,
    }
  }
  permLog(`[prepareContextForPlanMode] plain plan entry, prePlanMode=${currentMode}`, {
    level: 'info',
  })
  return { ...context, prePlanMode: currentMode }
}

/**
 * 在设置更改后协调 plan 模式期间的 auto 模式状态。
 * 比较期望状态（shouldPlanUseAutoMode）与实际状态（isAutoModeActive），
 * 并相应地激活/停用 auto。不在 plan 模式时为无操作。
 * 从 applySettingsChange 调用，以便在 plan 中间切换 useAutoModeDuringPlan 立即生效。
 */
export function transitionPlanAutoMode(context: ToolPermissionContext): ToolPermissionContext {
  if (context.mode !== 'plan') {
    return context
  }
  // 与 prepareContextForPlanMode 的入口时排除条件保持一致 —
  // 当用户从危险模式进入时，永远不会在 plan 中间激活 auto。
  if (context.prePlanMode === 'bypassPermissions') {
    return context
  }

  const want = shouldPlanUseAutoMode()
  const have = autoModeStateModule?.isAutoModeActive() ?? false

  if (want && have) {
    // syncPermissionRulesFromDisk（在我们之前在 applySettingsChange 中调用）
    // 从磁盘重新添加危险规则，但不触碰 strippedDangerousRules。
    // 重新剥离，以免分类器被前缀规则放行匹配所绕过。
    return stripDangerousPermissionsForAutoMode(context)
  }
  if (!want && !have) {
    return context
  }

  if (want) {
    autoModeStateModule?.setAutoModeActive(true)
    setNeedsAutoModeExitAttachment(false)
    return stripDangerousPermissionsForAutoMode(context)
  }
  autoModeStateModule?.setAutoModeActive(false)
  setNeedsAutoModeExitAttachment(true)
  return restoreDangerousPermissions(context)
}

export {
  findOverlyBroadBashPermissions,
  removeDangerousPermissions,
  restoreDangerousPermissions,
  stripDangerousPermissionsForAutoMode,
}
