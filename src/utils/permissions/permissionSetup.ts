import { feature } from 'bun:bundle'
import { relative } from 'path'
import {
  getOriginalCwd,
  handleAutoModeTransition,
  handlePlanModeTransition,
  setHasExitedPlanMode,
  setNeedsAutoModeExitAttachment,
} from '../../bootstrap/state.js'
import type {
  ToolPermissionContext,
  ToolPermissionRulesBySource,
} from '../../Tool.js'
import { getCwd } from '../cwd.js'
import { isEnvTruthy } from '../envUtils.js'
import { isInternalBuild } from '../envUtils.js'
import type { SettingSource } from '../settings/constants.js'
import { SETTING_SOURCES } from '../settings/constants.js'
import {
  getSettings_DEPRECATED,
  getSettingsFilePathForSource,
  getUseAutoModeDuringPlan,
  hasAutoModeOptIn,
} from '../settings/settings.js'
import {
  type PermissionMode,
  permissionModeFromString,
} from './PermissionMode.js'
import { applyPermissionRulesToPermissionContext } from './permissions.js'
import { loadAllPermissionRulesFromDisk } from './permissionsLoader.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('./autoModeState.js') as typeof import('./autoModeState.js'))
  : null

import { resolve } from 'path'
import {
  checkSecurityRestrictionGate,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE,
  getDynamicConfig_BLOCKS_ON_INIT,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from 'src/services/analytics/growthbook.js'
import {
  addDirHelpMessage,
  validateDirectoryForWorkspace,
} from '../../commands/add-dir/validation.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { getToolsForDefaultPreset, parseToolPreset } from '../../tools.js'
import {
  getFsImplementation,
  safeResolvePath,
} from '../../utils/fsOperations.js'
import { modelSupportsAutoMode } from '../betas.js'
import { logForDebugging } from '../debug.js'
import { gracefulShutdown } from '../gracefulShutdown.js'
import { getMainLoopModel } from '../model/model.js'
import {
  CROSS_PLATFORM_CODE_EXEC,
  DANGEROUS_BASH_PATTERNS,
} from './dangerousPatterns.js'
import type {
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
} from './PermissionRule.js'
import {
  type AdditionalWorkingDirectory,
  applyPermissionUpdate,
} from './PermissionUpdate.js'
import type { PermissionUpdateDestination } from './PermissionUpdateSchema.js'
import {
  normalizeLegacyToolName,
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from './permissionRuleParser.js'

/**
 * 检查 Bash 权限规则在 auto 模式下是否危险。
 * 如果规则会自动放行执行任意代码的命令，从而绕过分类器的安全评估，则该规则是危险的。
 *
 * 危险模式：
 * 1. 工具级放行（不带 ruleContent 的 Bash）— 放行所有命令
 * 2. 脚本解释器前缀规则（python:*、node:* 等）
 * 3. 匹配解释器的通配符规则（python*、node* 等）
 */
export function isDangerousBashPermission(
  toolName: string,
  ruleContent: string | undefined,
): boolean {
  // 仅检查 Bash 规则
  if (toolName !== BASH_TOOL_NAME) {
    return false
  }

  // 工具级放行（不带 ruleContent 的 Bash，或 Bash(*)）— 放行所有命令
  if (ruleContent === undefined || ruleContent === '') {
    return true
  }

  const content = ruleContent.trim().toLowerCase()

  // 独立通配符 (*) 匹配所有内容
  if (content === '*') {
    return true
  }

  // 检查前缀语法的危险模式（例如 "python:*"）或通配符语法（例如 "python*"）
  for (const pattern of DANGEROUS_BASH_PATTERNS) {
    const lowerPattern = pattern.toLowerCase()

    // Exact match to the pattern itself (e.g., "python" as a rule)
    if (content === lowerPattern) {
      return true
    }

    // Prefix syntax: "python:*" allows any python command
    if (content === `${lowerPattern}:*`) {
      return true
    }

    // Wildcard at end: "python*" matches python, python3, etc.
    if (content === `${lowerPattern}*`) {
      return true
    }

    // Wildcard with space: "python *" would match "python script.py"
    if (content === `${lowerPattern} *`) {
      return true
    }

    // Check for patterns like "python -*" which would match "python -c 'code'"
    if (content.startsWith(`${lowerPattern} -`) && content.endsWith('*')) {
      return true
    }
  }

  return false
}

/**
 * 检查 PowerShell 权限规则在 auto 模式下是否危险。
 * 如果规则会自动放行执行任意代码的命令（嵌套 shell、Invoke-Expression、Start-Process 等），
 * 从而绕过分类器的安全评估，则该规则是危险的。
 *
 * PowerShell 不区分大小写，因此规则内容在匹配前先转为小写。
 */
export function isDangerousPowerShellPermission(
  toolName: string,
  ruleContent: string | undefined,
): boolean {
  if (toolName !== POWERSHELL_TOOL_NAME) {
    return false
  }

  // 工具级放行（不带 ruleContent 的 PowerShell，或 PowerShell(*)）— 放行所有命令
  if (ruleContent === undefined || ruleContent === '') {
    return true
  }

  const content = ruleContent.trim().toLowerCase()

  // 独立通配符 (*) 匹配所有内容
  if (content === '*') {
    return true
  }

  // PS 特有的 cmdlet 名称。CROSS_PLATFORM_CODE_EXEC 与 bash 共享。
  const patterns: readonly string[] = [
    ...CROSS_PLATFORM_CODE_EXEC,
    // 嵌套 PS + 可从 PS 启动的 shell
    'pwsh',
    'powershell',
    'cmd',
    'wsl',
    // 字符串/脚本块求值器
    'iex',
    'invoke-expression',
    'icm',
    'invoke-command',
    // 进程启动器
    'start-process',
    'saps',
    'start',
    'start-job',
    'sajb',
    'start-threadjob', // PS 6.1+ 内置；接受 -ScriptBlock 参数，类似 Start-Job
    // 事件/会话代码执行
    'register-objectevent',
    'register-engineevent',
    'register-wmievent',
    'register-scheduledjob',
    'new-pssession',
    'nsn', // 别名
    'enter-pssession',
    'etsn', // 别名
    // .NET 逃逸出口
    'add-type', // Add-Type -TypeDefinition '<C#>' → P/Invoke
    'new-object', // New-Object -ComObject WScript.Shell → .Run()
  ]

  for (const pattern of patterns) {
    // patterns 存储为小写；content 已在上方转为小写
    if (content === pattern) return true
    if (content === `${pattern}:*`) return true
    if (content === `${pattern}*`) return true
    if (content === `${pattern} *`) return true
    if (content.startsWith(`${pattern} -`) && content.endsWith('*')) return true
    // .exe 后缀加在第一个单词上。`python` → `python.exe`。
    // `npm run` → `npm.exe run`（npm.exe 才是 Windows 上的真实二进制名）。
    // 像 `PowerShell(npm.exe run:*)` 这样的规则需要匹配 `npm run`。
    const sp = pattern.indexOf(' ')
    const exe =
      sp === -1
        ? `${pattern}.exe`
        : `${pattern.slice(0, sp)}.exe${pattern.slice(sp)}`
    if (content === exe) return true
    if (content === `${exe}:*`) return true
    if (content === `${exe}*`) return true
    if (content === `${exe} *`) return true
    if (content.startsWith(`${exe} -`) && content.endsWith('*')) return true
  }
  return false
}

/**
 * 检查 Agent（子代理）权限规则在 auto 模式下是否危险。
 * 任何 Agent 放行规则都会在 auto 模式分类器评估子代理的 prompt 之前自动批准子代理的生成，
 * 从而使委派攻击防护失效。
 */
export function isDangerousTaskPermission(
  toolName: string,
  _ruleContent: string | undefined,
): boolean {
  return normalizeLegacyToolName(toolName) === AGENT_TOOL_NAME
}

function formatPermissionSource(source: PermissionRuleSource): string {
  if ((SETTING_SOURCES as readonly string[]).includes(source)) {
    const filePath = getSettingsFilePathForSource(source as SettingSource)
    if (filePath) {
      const relativePath = relative(getCwd(), filePath)
      return relativePath.length < filePath.length ? relativePath : filePath
    }
  }
  return source
}

export type DangerousPermissionInfo = {
  ruleValue: PermissionRuleValue
  source: PermissionRuleSource
  /** 格式化后的权限规则，便于显示，例如 "Bash(*)" 或 "Bash(python:*)" */
  ruleDisplay: string
  /** 格式化后的来源，例如文件路径或 "--allowed-tools" */
  sourceDisplay: string
}

/**
 * 检查权限规则在 auto 模式下是否危险。
 * 如果规则会在 auto 模式分类器评估之前自动放行操作，从而绕过安全检查，则该规则是危险的。
 */
function isDangerousClassifierPermission(
  toolName: string,
  ruleContent: string | undefined,
): boolean {
  if (isInternalBuild()) {
    // Tmux send-keys 执行任意 shell，与 Bash(*) 一样绕过了分类器
    if (toolName === 'Tmux') return true
  }
  return (
    isDangerousBashPermission(toolName, ruleContent) ||
    isDangerousPowerShellPermission(toolName, ruleContent) ||
    isDangerousTaskPermission(toolName, ruleContent)
  )
}

/**
 * 从磁盘加载的规则和 CLI 参数中查找所有危险的权限。
 * 返回每个危险权限的结构化信息。
 *
 * 检查 Bash 权限（通配符/解释器模式）、PowerShell 权限（通配符/iex/Start-Process 模式）
 * 以及 Agent 权限（任何放行规则都会绕过分类器的子代理评估）。
 */
export function findDangerousClassifierPermissions(
  rules: PermissionRule[],
  cliAllowedTools: string[],
): DangerousPermissionInfo[] {
  const dangerous: DangerousPermissionInfo[] = []

  // 检查从设置中加载的规则
  for (const rule of rules) {
    if (
      rule.ruleBehavior === 'allow' &&
      isDangerousClassifierPermission(
        rule.ruleValue.toolName,
        rule.ruleValue.ruleContent,
      )
    ) {
      const ruleString = rule.ruleValue.ruleContent
        ? `${rule.ruleValue.toolName}(${rule.ruleValue.ruleContent})`
        : `${rule.ruleValue.toolName}(*)`
      dangerous.push({
        ruleValue: rule.ruleValue,
        source: rule.source,
        ruleDisplay: ruleString,
        sourceDisplay: formatPermissionSource(rule.source),
      })
    }
  }

  // 检查 CLI --allowed-tools 参数
  for (const toolSpec of cliAllowedTools) {
    // 解析工具规格："Bash" 或 "Bash(pattern)" 或 "Agent" 或 "Agent(subagent_type)"
    const match = toolSpec.match(/^([^(]+)(?:\(([^)]*)\))?$/)
    if (match) {
      const toolName = match[1]!.trim()
      const ruleContent = match[2]?.trim()

      if (isDangerousClassifierPermission(toolName, ruleContent)) {
        dangerous.push({
          ruleValue: { toolName, ruleContent },
          source: 'cliArg',
          ruleDisplay: ruleContent ? toolSpec : `${toolName}(*)`,
          sourceDisplay: '--allowed-tools',
        })
      }
    }
  }

  return dangerous
}

/**
 * 检查 Bash 放行规则是否过于宽泛（等同于 YOLO 模式）。
 * 对不带内容限制的 Bash 工具级放行规则返回 true，
 * 这会自动放行所有 bash 命令。
 *
 * 匹配：Bash、Bash(*)、Bash() — 都解析为 { toolName: 'Bash' } 且没有 ruleContent。
 */
export function isOverlyBroadBashAllowRule(
  ruleValue: PermissionRuleValue,
): boolean {
  return (
    ruleValue.toolName === BASH_TOOL_NAME && ruleValue.ruleContent === undefined
  )
}

/**
 * isOverlyBroadBashAllowRule 的 PowerShell 等价版本。
 *
 * 匹配：PowerShell、PowerShell(*)、PowerShell() — 都解析为
 * { toolName: 'PowerShell' } 且没有 ruleContent。
 */
export function isOverlyBroadPowerShellAllowRule(
  ruleValue: PermissionRuleValue,
): boolean {
  return (
    ruleValue.toolName === POWERSHELL_TOOL_NAME &&
    ruleValue.ruleContent === undefined
  )
}

/**
 * 从设置和 CLI 参数中查找所有过于宽泛的 Bash 放行规则。
 * 过于宽泛的规则会放行所有 bash 命令（例如 Bash 或 Bash(*)），
 * 这实际上等同于 YOLO/绕过权限模式。
 */
export function findOverlyBroadBashPermissions(
  rules: PermissionRule[],
  cliAllowedTools: string[],
): DangerousPermissionInfo[] {
  const overlyBroad: DangerousPermissionInfo[] = []

  for (const rule of rules) {
    if (
      rule.ruleBehavior === 'allow' &&
      isOverlyBroadBashAllowRule(rule.ruleValue)
    ) {
      overlyBroad.push({
        ruleValue: rule.ruleValue,
        source: rule.source,
        ruleDisplay: `${BASH_TOOL_NAME}(*)`,
        sourceDisplay: formatPermissionSource(rule.source),
      })
    }
  }

  for (const toolSpec of cliAllowedTools) {
    const parsed = permissionRuleValueFromString(toolSpec)
    if (isOverlyBroadBashAllowRule(parsed)) {
      overlyBroad.push({
        ruleValue: parsed,
        source: 'cliArg',
        ruleDisplay: `${BASH_TOOL_NAME}(*)`,
        sourceDisplay: '--allowed-tools',
      })
    }
  }

  return overlyBroad
}

/**
 * findOverlyBroadBashPermissions 的 PowerShell 等价版本。
 */
export function findOverlyBroadPowerShellPermissions(
  rules: PermissionRule[],
  cliAllowedTools: string[],
): DangerousPermissionInfo[] {
  const overlyBroad: DangerousPermissionInfo[] = []

  for (const rule of rules) {
    if (
      rule.ruleBehavior === 'allow' &&
      isOverlyBroadPowerShellAllowRule(rule.ruleValue)
    ) {
      overlyBroad.push({
        ruleValue: rule.ruleValue,
        source: rule.source,
        ruleDisplay: `${POWERSHELL_TOOL_NAME}(*)`,
        sourceDisplay: formatPermissionSource(rule.source),
      })
    }
  }

  for (const toolSpec of cliAllowedTools) {
    const parsed = permissionRuleValueFromString(toolSpec)
    if (isOverlyBroadPowerShellAllowRule(parsed)) {
      overlyBroad.push({
        ruleValue: parsed,
        source: 'cliArg',
        ruleDisplay: `${POWERSHELL_TOOL_NAME}(*)`,
        sourceDisplay: '--allowed-tools',
      })
    }
  }

  return overlyBroad
}

/**
 * 类型守卫：检查 PermissionRuleSource 是否为有效的 PermissionUpdateDestination。
 * 'flagSettings'、'policySettings' 和 'command' 等来源不是有效的目标。
 */
function isPermissionUpdateDestination(
  source: PermissionRuleSource,
): source is PermissionUpdateDestination {
  return [
    'userSettings',
    'projectSettings',
    'localSettings',
    'session',
    'cliArg',
  ].includes(source)
}

/**
 * 从内存中的上下文中移除危险权限，并可选地将移除操作持久化到磁盘上的设置文件中。
 */
export function removeDangerousPermissions(
  context: ToolPermissionContext,
  dangerousPermissions: DangerousPermissionInfo[],
): ToolPermissionContext {
  // 按来源（更新的目标）对危险规则分组
  const rulesBySource = new Map<
    PermissionUpdateDestination,
    PermissionRuleValue[]
  >()
  for (const perm of dangerousPermissions) {
    // 跳过无法持久化的来源（flagSettings、policySettings、command）
    if (!isPermissionUpdateDestination(perm.source)) {
      continue
    }
    const destination = perm.source
    const existing = rulesBySource.get(destination) || []
    existing.push(perm.ruleValue)
    rulesBySource.set(destination, existing)
  }

  let updatedContext = context
  for (const [destination, rules] of rulesBySource) {
    updatedContext = applyPermissionUpdate(updatedContext, {
      type: 'removeRules' as const,
      rules,
      behavior: 'allow' as const,
      destination,
    })
  }

  return updatedContext
}

/**
 * 为 auto 模式准备 ToolPermissionContext，剥离会绕过分类器的危险权限。
 * 返回清理后的上下文（模式不变 — 由调用者设置模式）。
 */
export function stripDangerousPermissionsForAutoMode(
  context: ToolPermissionContext,
): ToolPermissionContext {
  const rules: PermissionRule[] = []
  for (const [source, ruleStrings] of Object.entries(
    context.alwaysAllowRules,
  )) {
    if (!ruleStrings) {
      continue
    }
    for (const ruleString of ruleStrings) {
      const ruleValue = permissionRuleValueFromString(ruleString)
      rules.push({
        source: source as PermissionRuleSource,
        ruleBehavior: 'allow',
        ruleValue,
      })
    }
  }
  const dangerousPermissions = findDangerousClassifierPermissions(rules, [])
  if (dangerousPermissions.length === 0) {
    return {
      ...context,
      strippedDangerousRules: context.strippedDangerousRules ?? {},
    }
  }
  for (const permission of dangerousPermissions) {
    logForDebugging(
      `Ignoring dangerous permission ${permission.ruleDisplay} from ${permission.sourceDisplay} (bypasses classifier)`,
    )
  }
  // 与 removeDangerousPermissions 的来源过滤保持一致，确保暂存的确实是已移除的内容。
  const stripped: ToolPermissionRulesBySource = {}
  for (const perm of dangerousPermissions) {
    if (!isPermissionUpdateDestination(perm.source)) continue
    ;(stripped[perm.source] ??= []).push(
      permissionRuleValueToString(perm.ruleValue),
    )
  }
  return {
    ...removeDangerousPermissions(context, dangerousPermissions),
    strippedDangerousRules: stripped,
  }
}

/**
 * 恢复之前由 stripDangerousPermissionsForAutoMode 暂存的危险放行规则。
 * 在离开 auto 模式时调用，以便用户的 Bash(python:*)、Agent(*) 等规则在 default 模式下再次生效。
 * 调用后清空暂存，使第二次退出成为无操作。
 */
export function restoreDangerousPermissions(
  context: ToolPermissionContext,
): ToolPermissionContext {
  const stash = context.strippedDangerousRules
  if (!stash) {
    return context
  }
  let result = context
  for (const [source, ruleStrings] of Object.entries(stash)) {
    if (!ruleStrings || ruleStrings.length === 0) continue
    result = applyPermissionUpdate(result, {
      type: 'addRules',
      rules: ruleStrings.map(permissionRuleValueFromString),
      behavior: 'allow',
      destination: source as PermissionUpdateDestination,
    })
  }
  return { ...result, strippedDangerousRules: undefined }
}

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
  if (fromMode === toMode) return context

  handlePlanModeTransition(fromMode, toMode)
  handleAutoModeTransition(fromMode, toMode)

  if (fromMode === 'plan' && toMode !== 'plan') {
    setHasExitedPlanMode(true)
  }

  if (feature('TRANSCRIPT_CLASSIFIER')) {
    if (toMode === 'plan' && fromMode !== 'plan') {
      return prepareContextForPlanMode(context)
    }

    // 带 auto 激活的 plan 模式算作使用了分类器（在离开侧）。
    // isAutoModeActive() 是权威信号 — prePlanMode/strippedDangerousRules
    // 是不可靠的代理，因为 auto 可以在 plan 中间被停用（非 opt-in
    // 进入、transitionPlanAutoMode），而这些字段仍然保持设置/未设置。
    const fromUsesClassifier =
      fromMode === 'auto' ||
      (fromMode === 'plan' &&
        (autoModeStateModule?.isAutoModeActive() ?? false))
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
  const { resolvedPath: resolvedProcessPwd, isSymlink: isProcessPwdSymlink } =
    safeResolvePath(getFsImplementation(), processPwd)

  return isProcessPwdSymlink
    ? resolvedProcessPwd === resolve(originalCwd)
    : false
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
  const settings = getSettings_DEPRECATED() || {}

  // 首先检查 GrowthBook 门控 — 最高优先级
  const growthBookDisableBypassPermissionsMode =
    checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
      'tengu_disable_bypass_permissions_mode',
    )

  // 然后检查设置 — 较低优先级
  const settingsDisableBypassPermissionsMode =
    settings.permissions?.disableBypassPermissionsMode === 'disable'

  // Statsig 门控优先于设置
  const disableBypassPermissionsMode =
    growthBookDisableBypassPermissionsMode ||
    settingsDisableBypassPermissionsMode

  // 同步熔断器检查（缓存的 GB 读取）。当 auto 模式实际无法进入时，
  // 阻止 AutoModeOptInDialog 在 showSetupScreens() 中显示。
  // autoModeFlagCli 仍然将意图传递到 verifyAutoModeGateAccess，
  // 它会通知用户原因。
  const autoModeCircuitBrokenSync = feature('TRANSCRIPT_CLASSIFIER')
    ? getAutoModeEnabledStateIfCached() === 'disabled'
    : false

  // 模式按优先级排序
  const orderedModes: PermissionMode[] = []
  let notification: string | undefined

  if (dangerouslySkipPermissions) {
    orderedModes.push('bypassPermissions')
  }
  if (permissionModeCli) {
    const parsedMode = permissionModeFromString(permissionModeCli)
    if (feature('TRANSCRIPT_CLASSIFIER') && parsedMode === 'auto') {
      if (autoModeCircuitBrokenSync) {
        logForDebugging(
          'auto mode circuit breaker active (cached) — falling back to default',
          { level: 'warn' },
        )
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
      !['acceptEdits', 'plan', 'default'].includes(settingsMode)
    ) {
      logForDebugging(
        `settings defaultMode "${settingsMode}" is not supported in ZY_CODE_REMOTE — only acceptEdits and plan are allowed`,
        { level: 'warn' },
      )
      logEvent('tengu_ccr_unsupported_default_mode_ignored', {
        mode: settingsMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
    // 来自设置的 auto 模式需要与来自 CLI 的相同门控检查
    else if (feature('TRANSCRIPT_CLASSIFIER') && settingsMode === 'auto') {
      if (autoModeCircuitBrokenSync) {
        logForDebugging(
          'auto mode circuit breaker active (cached) — falling back to default',
          { level: 'warn' },
        )
      } else {
        orderedModes.push('auto')
      }
    } else {
      orderedModes.push(settingsMode)
    }
  }

  let result: { mode: PermissionMode; notification?: string } | undefined

  for (const mode of orderedModes) {
    if (mode === 'bypassPermissions' && disableBypassPermissionsMode) {
      if (growthBookDisableBypassPermissionsMode) {
        logForDebugging('bypassPermissions mode is disabled by Statsig gate', {
          level: 'warn',
        })
        notification =
          'Bypass permissions mode was disabled by your organization policy'
      } else {
        logForDebugging('bypassPermissions mode is disabled by settings', {
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

  if (feature('TRANSCRIPT_CLASSIFIER') && result.mode === 'auto') {
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
    if (!toolString) continue

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
  // Parse comma-separated allowed and disallowed tools if provided
  // Normalize legacy tool names (e.g., 'Task' → 'Agent') so that in-memory
  // rule removal in stripDangerousPermissionsForAutoMode matches correctly.
  const parsedAllowedToolsCli = parseToolListFromCLI(allowedToolsCli).map(
    rule => permissionRuleValueToString(permissionRuleValueFromString(rule)),
  )
  let parsedDisallowedToolsCli = parseToolListFromCLI(disallowedToolsCli)

  // 如果指定了基础工具，自动拒绝不在基础集合中的所有工具
  // 我们需要检查基础工具是否被显式提供（而不仅仅是空默认值）
  if (baseToolsCli && baseToolsCli.length > 0) {
    const baseToolsResult = parseBaseToolsFromCLI(baseToolsCli)
    // Normalize legacy tool names (e.g., 'Task' → 'Agent') so user-provided
    // base tool lists using old names still match canonical names.
    const baseToolsSet = new Set(baseToolsResult.map(normalizeLegacyToolName))
    const allToolNames = getToolsForDefaultPreset()
    const toolsToDisallow = allToolNames.filter(tool => !baseToolsSet.has(tool))
    parsedDisallowedToolsCli = [...parsedDisallowedToolsCli, ...toolsToDisallow]
  }

  const warnings: string[] = []
  const additionalWorkingDirectories = new Map<
    string,
    AdditionalWorkingDirectory
  >()
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
  const growthBookDisableBypassPermissionsMode =
    checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
      'tengu_disable_bypass_permissions_mode',
    )
  const settings = getSettings_DEPRECATED() || {}
  const settingsDisableBypassPermissionsMode =
    settings.permissions?.disableBypassPermissionsMode === 'disable'
  const isBypassPermissionsModeAvailable =
    (permissionMode === 'bypassPermissions' ||
      allowDangerouslySkipPermissions) &&
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
      ...findOverlyBroadPowerShellPermissions(
        rulesFromDisk,
        parsedAllowedToolsCli,
      ),
    ]
  }

  // 仅 Ant：检测 auto 模式下危险的 shell 权限
  // 危险权限（如 Bash(*)、Bash(python:*)、PowerShell(iex:*)）会在分类器评估之前自动放行，
  // 从而使更安全的 YOLO 模式失去意义
  let dangerousPermissions: DangerousPermissionInfo[] = []
  if (feature('TRANSCRIPT_CLASSIFIER') && permissionMode === 'auto') {
    dangerousPermissions = findDangerousClassifierPermissions(
      rulesFromDisk,
      parsedAllowedToolsCli,
    )
  }

  let toolPermissionContext = applyPermissionRulesToPermissionContext(
    {
      mode: permissionMode,
      additionalWorkingDirectories,
      alwaysAllowRules: { cliArg: parsedAllowedToolsCli },
      alwaysDenyRules: { cliArg: parsedDisallowedToolsCli },
      alwaysAskRules: {},
      isBypassPermissionsModeAvailable,
      ...(feature('TRANSCRIPT_CLASSIFIER')
        ? { isAutoModeAvailable: isAutoModeGateEnabled() }
        : {}),
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
    allAdditionalDirectories.map(dir =>
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

export function getAutoModeUnavailableNotification(
  reason: AutoModeUnavailableReason,
): string {
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
  return isInternalBuild()
    ? `${base} · #zy-code-feedback`
    : base
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
  // Runtime AppState.fastMode — passed from callers with AppState access so
  // the disableFastMode circuit breaker reads current state, not stale
  // settings.fastMode (which is intentionally sticky across /model auto-
  // downgrades). Optional for callers without AppState (e.g. SDK init paths).
  fastMode?: boolean,
): Promise<AutoModeGateCheckResult> {
  // auto 模式配置 — 在所有构建中运行（熔断器、轮播、踢出）
  // 重新读取 tengu_auto_mode_config.enabled — 此异步检查在 GrowthBook 初始化后运行一次，
  // 是 isAutoModeAvailable 的权威来源。同步启动路径使用过时缓存；此检查进行修正。
  // 熔断器（enabled==='disabled'）在此生效。
  const autoModeConfig = await getDynamicConfig_BLOCKS_ON_INIT<{
    enabled?: AutoModeEnabledState
    disableFastMode?: boolean
  }>('tengu_auto_mode_config', {})
  const enabledState = parseAutoModeEnabledState(autoModeConfig?.enabled)
  const disabledBySettings = isAutoModeDisabledBySettings()
  // 将设置禁用在熔断器语义上与 GrowthBook 'disabled' 同等对待 —
  // 阻止 SDK/显式重新进入（通过 isAutoModeGateEnabled()）。
  autoModeStateModule?.setAutoModeCircuitBroken(
    enabledState === 'disabled' || disabledBySettings,
  )

  // 轮播可用性：未被熔断、未被设置禁用、模型支持、disableFastMode 熔断器未触发，且（已启用或已 opt-in）
  const mainModel = getMainLoopModel()
  // 临时熔断器：tengu_auto_mode_config.disableFastMode 在 fast 模式开启时阻止 auto 模式。
  // 检查运行时 AppState.fastMode（如果提供）以及 ant 的模型名称 '-fast' 子串
  // （ant 内部 fast 模型如 capybara-v2-fast[1m] 在模型 ID 中编码速度信息）。
  // 在 auto+fast 模式交互验证通过后移除此代码。
  const disableFastModeBreakerFires =
    !!autoModeConfig?.disableFastMode &&
    (!!fastMode ||
      (isInternalBuild() &&
        mainModel.toLowerCase().includes('-fast')))
  const modelSupported =
    modelSupportsAutoMode(mainModel) && !disableFastModeBreakerFires
  let carouselAvailable = false
  if (enabledState !== 'disabled' && !disabledBySettings && modelSupported) {
    carouselAvailable =
      enabledState === 'enabled' || hasAutoModeOptInAnySource()
  }
  // canEnterAuto 门控显式进入（--permission-mode auto、defaultMode: auto）
  // — 显式进入本身就是一种 opt-in，因此我们仅基于熔断器 + 设置 + 模型进行阻止
  const canEnterAuto =
    enabledState !== 'disabled' && !disabledBySettings && modelSupported
  logForDebugging(
    `[auto-mode] verifyAutoModeGateAccess: enabledState=${enabledState} disabledBySettings=${disabledBySettings} model=${mainModel} modelSupported=${modelSupported} disableFastModeBreakerFires=${disableFastModeBreakerFires} carouselAvailable=${carouselAvailable} canEnterAuto=${canEnterAuto}`,
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
  const setAvailable = (
    ctx: ToolPermissionContext,
    available: boolean,
  ): ToolPermissionContext => {
    if (ctx.isAutoModeAvailable !== available) {
      logForDebugging(
        `[auto-mode] verifyAutoModeGateAccess setAvailable: ${ctx.isAutoModeAvailable} -> ${available}`,
      )
    }
    return ctx.isAutoModeAvailable === available
      ? ctx
      : { ...ctx, isAutoModeAvailable: available }
  }

  if (canEnterAuto) {
    return { updateContext: ctx => setAvailable(ctx, carouselAvailable) }
  }

  // 门控关闭或熔断 — 确定原因（与上下文无关）。
  let reason: AutoModeUnavailableReason
  if (disabledBySettings) {
    reason = 'settings'
    logForDebugging('auto mode disabled: disableAutoMode in settings', {
      level: 'warn',
    })
  } else if (enabledState === 'disabled') {
    reason = 'circuit-breaker'
    logForDebugging(
      'auto mode disabled: tengu_auto_mode_config.enabled === "disabled" (circuit breaker)',
      { level: 'warn' },
    )
  } else {
    reason = 'model'
    logForDebugging(
      `auto mode disabled: model ${getMainLoopModel()} does not support auto mode`,
      { level: 'warn' },
    )
  }
  const notification = getAutoModeUnavailableNotification(reason)

  // 统一踢出转换。重新检查新鲜上下文，仅在踢出实际适用时触发
  // 副作用（setAutoModeActive(false)、setNeedsAutoModeExitAttachment）。
  // 这使得 autoModeActive 与 toolPermissionContext.mode 保持同步，
  // 即使用户在 await 期间更改了模式：如果他们已自行离开 auto，
  // handleCycleMode 已停用分类器，我们不再触发；
  // 如果他们在 await 期间进入了 auto（在 setAutoModeCircuitBroken 生效前可能），
  // 我们在这里踢出他们。
  const kickOutOfAutoIfNeeded = (
    ctx: ToolPermissionContext,
  ): ToolPermissionContext => {
    const inAuto = ctx.mode === 'auto'
    logForDebugging(
      `[auto-mode] kickOutOfAutoIfNeeded applying: ctx.mode=${ctx.mode} ctx.prePlanMode=${ctx.prePlanMode} reason=${reason}`,
    )
    // 带 auto 激活的 plan 模式：来自 prePlanMode='auto'（从 auto 进入）或 opt-in（存在 strippedDangerousRules）。
    const inPlanWithAutoActive =
      ctx.mode === 'plan' &&
      (ctx.prePlanMode === 'auto' || !!ctx.strippedDangerousRules)
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
    (currentContext.prePlanMode === 'auto' ||
      !!currentContext.strippedDangerousRules)
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
  return checkSecurityRestrictionGate('tengu_disable_bypass_permissions_mode')
}

function isAutoModeDisabledBySettings(): boolean {
  const settings = getSettings_DEPRECATED() || {}
  return (
    (settings as { disableAutoMode?: 'disable' }).disableAutoMode ===
      'disable' ||
    (settings.permissions as { disableAutoMode?: 'disable' } | undefined)
      ?.disableAutoMode === 'disable'
  )
}

/**
 * 检查 auto 模式是否可以进入：熔断器未激活且设置未禁用它。同步。
 */
export function isAutoModeGateEnabled(): boolean {
  if (autoModeStateModule?.isAutoModeCircuitBroken() ?? false) return false
  if (isAutoModeDisabledBySettings()) return false
  if (!modelSupportsAutoMode(getMainLoopModel())) return false
  return true
}

/**
 * 返回 auto 模式当前不可用的原因，如果可用则返回 null。
 * 同步 — 使用由 verifyAutoModeGateAccess 填充的状态。
 */
export function getAutoModeUnavailableReason(): AutoModeUnavailableReason | null {
  if (isAutoModeDisabledBySettings()) return 'settings'
  if (autoModeStateModule?.isAutoModeCircuitBroken() ?? false) {
    return 'circuit-breaker'
  }
  if (!modelSupportsAutoMode(getMainLoopModel())) return 'model'
  return null
}

/**
 * tengu_auto_mode_config GrowthBook JSON 配置中的 `enabled` 字段。
 * 控制 auto 模式在 UI 表面（CLI、IDE、Desktop）中的可用性。
 * - 'enabled'：auto 模式在 shift-tab 轮播（或等效物）中可用
 * - 'disabled'：auto 模式完全不可用 — 用于事件响应的熔断器
 * - 'opt-in'：auto 模式仅在用户显式 opt-in 后可用
 *   （通过 CLI 中的 --enable-auto-mode，或 IDE/Desktop 中的设置切换）
 */
export type AutoModeEnabledState = 'enabled' | 'disabled' | 'opt-in'

const AUTO_MODE_ENABLED_DEFAULT: AutoModeEnabledState = 'disabled'

function parseAutoModeEnabledState(value: unknown): AutoModeEnabledState {
  if (value === 'enabled' || value === 'disabled' || value === 'opt-in') {
    return value
  }
  return AUTO_MODE_ENABLED_DEFAULT
}

/**
 * 读取 tengu_auto_mode_config 中的 `enabled` 字段（缓存，可能过时）。
 * 如果 GrowthBook 不可用或字段未设置，默认为 'disabled'。
 * 其他表面（IDE、Desktop）应调用此函数来决定是否在其模式选择器中展示 auto 模式。
 */
export function getAutoModeEnabledState(): AutoModeEnabledState {
  const config = getFeatureValue_CACHED_MAY_BE_STALE<{
    enabled?: AutoModeEnabledState
  }>('tengu_auto_mode_config', {})
  return parseAutoModeEnabledState(config?.enabled)
}

const NO_CACHED_AUTO_MODE_CONFIG = Symbol('no-cached-auto-mode-config')

/**
 * 类似 getAutoModeEnabledState，但在没有缓存值时返回 undefined
 * （冷启动，GrowthBook 初始化之前）。由 initialPermissionModeFromCLI 中的
 * 同步熔断器检查使用，不能将"尚未获取"与"已获取并禁用"混为一谈 —
 * 前者委托给 verifyAutoModeGateAccess，后者立即阻止。
 */
export function getAutoModeEnabledStateIfCached():
  | AutoModeEnabledState
  | undefined {
  const config = getFeatureValue_CACHED_MAY_BE_STALE<
    { enabled?: AutoModeEnabledState } | typeof NO_CACHED_AUTO_MODE_CONFIG
  >('tengu_auto_mode_config', NO_CACHED_AUTO_MODE_CONFIG)
  if (config === NO_CACHED_AUTO_MODE_CONFIG) return undefined
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
  if (autoModeStateModule?.getAutoModeFlagCli() ?? false) return true
  return hasAutoModeOptIn()
}

/**
 * 检查 bypassPermissions 模式当前是否被 Statsig 门控或设置禁用。
 * 这是使用缓存 Statsig 值的同步版本。
 */
export function isBypassPermissionsModeDisabled(): boolean {
  const growthBookDisableBypassPermissionsMode =
    checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
      'tengu_disable_bypass_permissions_mode',
    )
  const settings = getSettings_DEPRECATED() || {}
  const settingsDisableBypassPermissionsMode =
    settings.permissions?.disableBypassPermissionsMode === 'disable'

  return (
    growthBookDisableBypassPermissionsMode ||
    settingsDisableBypassPermissionsMode
  )
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
  logForDebugging(
    'bypassPermissions mode is being disabled by Statsig gate (async check)',
    { level: 'warn' },
  )

  void gracefulShutdown(1, 'bypass_permissions_disabled')
}

export function isDefaultPermissionModeAuto(): boolean {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    const settings = getSettings_DEPRECATED() || {}
    return settings.permissions?.defaultMode === 'auto'
  }
  return false
}

/**
 * plan 模式是否应使用 auto 模式语义（分类器在 plan 期间运行）。
 * 当用户已 opt-in auto 模式且门控已启用时为 true。
 * 在权限检查时评估，因此对配置更改是响应式的。
 */
export function shouldPlanUseAutoMode(): boolean {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    return (
      hasAutoModeOptIn() &&
      isAutoModeGateEnabled() &&
      getUseAutoModeDuringPlan()
    )
  }
  return false
}

/**
 * 集中化的 plan 模式入口。将当前模式暂存为 prePlanMode，
 * 以便 ExitPlanMode 可以恢复它。当用户已 opt-in auto 模式时，
 * auto 语义在 plan 模式期间保持激活。
 */
export function prepareContextForPlanMode(
  context: ToolPermissionContext,
): ToolPermissionContext {
  const currentMode = context.mode
  if (currentMode === 'plan') return context
  if (feature('TRANSCRIPT_CLASSIFIER')) {
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
  }
  logForDebugging(
    `[prepareContextForPlanMode] plain plan entry, prePlanMode=${currentMode}`,
    { level: 'info' },
  )
  return { ...context, prePlanMode: currentMode }
}

/**
 * 在设置更改后协调 plan 模式期间的 auto 模式状态。
 * 比较期望状态（shouldPlanUseAutoMode）与实际状态（isAutoModeActive），
 * 并相应地激活/停用 auto。不在 plan 模式时为无操作。
 * 从 applySettingsChange 调用，以便在 plan 中间切换 useAutoModeDuringPlan 立即生效。
 */
export function transitionPlanAutoMode(
  context: ToolPermissionContext,
): ToolPermissionContext {
  if (!feature('TRANSCRIPT_CLASSIFIER')) return context
  if (context.mode !== 'plan') return context
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
  if (!want && !have) return context

  if (want) {
    autoModeStateModule?.setAutoModeActive(true)
    setNeedsAutoModeExitAttachment(false)
    return stripDangerousPermissionsForAutoMode(context)
  }
  autoModeStateModule?.setAutoModeActive(false)
  setNeedsAutoModeExitAttachment(true)
  return restoreDangerousPermissions(context)
}
