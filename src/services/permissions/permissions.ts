import { feature } from 'bun:bundle'
import { SandboxManager } from 'src/services/sandbox/sandbox-adapter.js'
import { extractOutputRedirections } from 'src/shell-eval/bash/commands.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { Tool, ToolPermissionContext, ToolUseContext } from '../../tool.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { shouldUseSandbox } from '../../tools/BashTool/shouldUseSandbox.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { REPL_TOOL_NAME } from '../../tools/REPLTool/constants.js'
import { isAbortError } from '../../types/llm.js'
import type { AssistantMessage } from '../../types/message.js'
import { createDebugLog } from '../../utils/debug.js'
import { isInternalBuild } from '../../utils/envUtils.js'
import { AbortError, toError } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { getSettingSourceDisplayNameLowercase, SETTING_SOURCES } from '../settings/constants.js'
import { plural } from '../../utils/stringUtils.js'
import { getToolNameForPermissionCheck, mcpInfoFromString } from '../mcp/mcpStringUtils.js'
import { isAutoModeAllowlistedTool } from './classifierDecision.js'
import { permissionModeTitle } from './permissionMode.js'
import type {
  PermissionAskDecision,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionDenyDecision,
  PermissionResult,
} from './permissionResult.js'
import type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
} from './permissionRule.js'
import {
  applyPermissionUpdate,
  applyPermissionUpdates,
  persistPermissionUpdates,
} from './permissionUpdate.js'
import type { PermissionUpdate, PermissionUpdateDestination } from './permissionUpdateSchema.js'
import {
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from './permissionRuleParser.js'
import {
  deletePermissionRuleFromSettings,
  type PermissionRuleFromEditableSettings,
  shouldAllowManagedPermissionRulesOnly,
} from './permissionsLoader.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = true
  ? (require('./autoModeState.js') as typeof import('./autoModeState.js'))
  : null

import {
  addToTurnClassifierDuration,
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalInputTokens,
  getTotalOutputTokens,
} from '../../bootstrap/runtime/runtimeContext.js'
import { clearClassifierChecking, setClassifierChecking } from '../../utils/classifierApprovals.js'
import { isInProtectedNamespace } from '../../utils/envUtils.js'
import { executePermissionRequestHooks } from '../hooks.js'
import {
  AUTO_REJECT_MESSAGE,
  buildClassifierUnavailableMessage,
  buildYoloRejectionMessage,
  DONT_ASK_REJECT_MESSAGE,
} from '../messages/constants.js'
import { calculateCostFromTokens } from '../model/modelCost.js'
import { getAutoModeConfig } from '../settings/settings.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import { jsonStringify } from '../../utils/slowOperations.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { sanitizeToolNameForAnalytics } from '../analytics/metadata.js'
import {
  createDenialTrackingState,
  DENIAL_LIMITS,
  type DenialTrackingState,
  recordDenial,
  recordSuccess,
  shouldFallbackToPrompting,
} from './denialTracking.js'
import { classifyYoloAction, formatActionForClassifier } from './yoloClassifier.js'

const permLog = createDebugLog('permissions')

const PERMISSION_RULE_SOURCES = [
  ...SETTING_SOURCES,
  'cliArg',
  'command',
  'session',
] as const satisfies readonly PermissionRuleSource[]

export function permissionRuleSourceDisplayString(source: PermissionRuleSource): string {
  return getSettingSourceDisplayNameLowercase(source)
}

export function getAllowRules(context: ToolPermissionContext): PermissionRule[] {
  return PERMISSION_RULE_SOURCES.flatMap((source) =>
    (context.alwaysAllowRules[source] || []).map((ruleString) => ({
      source,
      ruleBehavior: 'allow',
      ruleValue: permissionRuleValueFromString(ruleString),
    })),
  )
}

/**
 * 创建一条解释权限请求的权限请求消息
 */
export function createPermissionRequestMessage(
  toolName: string,
  decisionReason?: PermissionDecisionReason,
): string {
  // 处理不同的决策原因类型
  if (decisionReason) {
    if ((feature('BASH_CLASSIFIER') || true) && decisionReason.type === 'classifier') {
      return `Classifier '${decisionReason.classifier}' requires approval for this ${toolName} command: ${decisionReason.reason}`
    }
    switch (decisionReason.type) {
      case 'hook': {
        const hookMessage = decisionReason.reason
          ? `Hook '${decisionReason.hookName}' blocked this action: ${decisionReason.reason}`
          : `Hook '${decisionReason.hookName}' requires approval for this ${toolName} command`
        return hookMessage
      }
      case 'rule': {
        const ruleString = permissionRuleValueToString(decisionReason.rule.ruleValue)
        const sourceString = permissionRuleSourceDisplayString(decisionReason.rule.source)
        return `Permission rule '${ruleString}' from ${sourceString} requires approval for this ${toolName} command`
      }
      case 'subcommandResults': {
        const needsApproval: string[] = []
        for (const [cmd, result] of decisionReason.reasons) {
          if (result.behavior === 'ask' || result.behavior === 'passthrough') {
            // 去除输出重定向以避免在显示时将文件名显示为命令
            // 仅对 Bash 工具执行此操作，避免影响其他工具
            if (toolName === 'Bash') {
              const { commandWithoutRedirections, redirections } = extractOutputRedirections(cmd)
              // 仅在存在实际重定向时使用去除后的版本
              const displayCmd = redirections.length > 0 ? commandWithoutRedirections : cmd
              needsApproval.push(displayCmd)
            } else {
              needsApproval.push(cmd)
            }
          }
        }
        if (needsApproval.length > 0) {
          const n = needsApproval.length
          return `This ${toolName} command contains multiple operations. The following ${plural(n, 'part')} ${plural(n, 'requires', 'require')} approval: ${needsApproval.join(', ')}`
        }
        return `This ${toolName} command contains multiple operations that require approval`
      }
      case 'permissionPromptTool':
        return `Tool '${decisionReason.permissionPromptToolName}' requires approval for this ${toolName} command`
      case 'sandboxOverride':
        return 'Run outside of the sandbox'
      case 'workingDir':
        return decisionReason.reason
      case 'safetyCheck':
      case 'other':
        return decisionReason.reason
      case 'mode': {
        const modeTitle = permissionModeTitle(decisionReason.mode)
        return `Current permission mode (${modeTitle}) requires approval for this ${toolName} command`
      }
      case 'asyncAgent':
        return decisionReason.reason
    }
  }

  // 不列出允许的命令的默认消息
  const message = `ZY requested permissions to use ${toolName}, but you haven't granted it yet.`

  return message
}

export function getDenyRules(context: ToolPermissionContext): PermissionRule[] {
  return PERMISSION_RULE_SOURCES.flatMap((source) =>
    (context.alwaysDenyRules[source] || []).map((ruleString) => ({
      source,
      ruleBehavior: 'deny',
      ruleValue: permissionRuleValueFromString(ruleString),
    })),
  )
}

export function getAskRules(context: ToolPermissionContext): PermissionRule[] {
  return PERMISSION_RULE_SOURCES.flatMap((source) =>
    (context.alwaysAskRules[source] || []).map((ruleString) => ({
      source,
      ruleBehavior: 'ask',
      ruleValue: permissionRuleValueFromString(ruleString),
    })),
  )
}

/**
 * 检查整个工具是否匹配规则
 * 例如，对于 BashTool 匹配 "Bash" 而非 "Bash(prefix:*)"
 * 也匹配带有服务器名称的 MCP 工具，例如规则 "mcp__server1"
 */
function toolMatchesRule(tool: Pick<Tool, 'name' | 'mcpInfo'>, rule: PermissionRule): boolean {
  // 规则必须没有内容才能匹配整个工具
  if (rule.ruleValue.ruleContent !== undefined) {
    return false
  }

  // MCP 工具通过完全限定的 mcp__server__tool 名称匹配。在
  // skip-prefix 模式（CLAUDE_AGENT_SDK_MCP_NO_PREFIX）下，MCP 工具具有无前缀的
  // 显示名称（例如 "Write"），这与内置名称冲突；针对内置工具的
  // 规则不应匹配其 MCP 替代品。
  const nameForRuleMatch = getToolNameForPermissionCheck(tool)

  // 直接工具名称匹配
  if (rule.ruleValue.toolName === nameForRuleMatch) {
    return true
  }

  // MCP 服务器级别权限：规则 "mcp__server1" 匹配工具 "mcp__server1__tool1"
  // 也支持通配符：规则 "mcp__server1__*" 匹配 server1 的所有工具
  const ruleInfo = mcpInfoFromString(rule.ruleValue.toolName)
  const toolInfo = mcpInfoFromString(nameForRuleMatch)

  return (
    ruleInfo !== null &&
    toolInfo !== null &&
    (ruleInfo.toolName === undefined || ruleInfo.toolName === '*') &&
    ruleInfo.serverName === toolInfo.serverName
  )
}

/**
 * 检查整个工具是否在始终允许规则中
 * 例如，对于 BashTool 查找 "Bash" 而非 "Bash(prefix:*)"
 */
export function toolAlwaysAllowedRule(
  context: ToolPermissionContext,
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
): PermissionRule | null {
  return getAllowRules(context).find((rule) => toolMatchesRule(tool, rule)) || null
}

/**
 * 检查工具是否在始终拒绝规则中
 */
export function getDenyRuleForTool(
  context: ToolPermissionContext,
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
): PermissionRule | null {
  return getDenyRules(context).find((rule) => toolMatchesRule(tool, rule)) || null
}

/**
 * 检查工具是否在始终询问规则中
 */
export function getAskRuleForTool(
  context: ToolPermissionContext,
  tool: Pick<Tool, 'name' | 'mcpInfo'>,
): PermissionRule | null {
  return getAskRules(context).find((rule) => toolMatchesRule(tool, rule)) || null
}

/**
 * 检查特定 agent 是否通过 Agent(agentType) 语法被拒绝。
 * 例如，Agent(Explore) 会拒绝 Explore agent。
 */
export function getDenyRuleForAgent(
  context: ToolPermissionContext,
  agentToolName: string,
  agentType: string,
): PermissionRule | null {
  return (
    getDenyRules(context).find(
      (rule) =>
        rule.ruleValue.toolName === agentToolName && rule.ruleValue.ruleContent === agentType,
    ) || null
  )
}

/**
 * 过滤掉通过 Agent(agentType) 语法被拒绝的 agent。
 */
export function filterDeniedAgents<T extends { agentType: string }>(
  agents: T[],
  context: ToolPermissionContext,
  agentToolName: string,
): T[] {
  // 一次性解析拒绝规则并将 Agent(x) 内容收集到 Set 中。
  // 此前每个 agent 都调用 getDenyRuleForAgent，这会为每个 agent
  // 重新解析所有拒绝规则（O(agents×rules) 次解析调用）。
  const deniedAgentTypes = new Set<string>()
  for (const rule of getDenyRules(context)) {
    if (rule.ruleValue.toolName === agentToolName && rule.ruleValue.ruleContent !== undefined) {
      deniedAgentTypes.add(rule.ruleValue.ruleContent)
    }
  }
  return agents.filter((agent) => !deniedAgentTypes.has(agent.agentType))
}

/**
 * 给定工具的规则内容到对应规则的映射。
 * 例如，对于 BashTool，字符串键是 "Bash(prefix:*)" 中的 "prefix:*"
 */
export function getRuleByContentsForTool(
  context: ToolPermissionContext,
  tool: Tool,
  behavior: PermissionBehavior,
): Map<string, PermissionRule> {
  return getRuleByContentsForToolName(context, getToolNameForPermissionCheck(tool), behavior)
}

// 用于打破循环依赖，当 Tool 调用此函数时使用
export function getRuleByContentsForToolName(
  context: ToolPermissionContext,
  toolName: string,
  behavior: PermissionBehavior,
): Map<string, PermissionRule> {
  const ruleByContents = new Map<string, PermissionRule>()
  let rules: PermissionRule[] = []
  switch (behavior) {
    case 'allow':
      rules = getAllowRules(context)
      break
    case 'deny':
      rules = getDenyRules(context)
      break
    case 'ask':
      rules = getAskRules(context)
      break
  }
  for (const rule of rules) {
    if (
      rule.ruleValue.toolName === toolName &&
      rule.ruleValue.ruleContent !== undefined &&
      rule.ruleBehavior === behavior
    ) {
      ruleByContents.set(rule.ruleValue.ruleContent, rule)
    }
  }
  return ruleByContents
}

/**
 * 为无法显示权限提示的 headless/异步 agent 运行 PermissionRequest hook。
 * 这使 hook 有机会在回退到自动拒绝之前允许或拒绝工具使用。
 *
 * 如果某个 hook 做出了决策则返回 PermissionDecision，如果没有
 * hook 提供决策则返回 null（调用者应继续执行自动拒绝）。
 */
async function runPermissionRequestHooksForHeadlessAgent(
  tool: Tool,
  input: { [key: string]: unknown },
  toolUseID: string,
  context: ToolUseContext,
  permissionMode: string | undefined,
  suggestions: PermissionUpdate[] | undefined,
): Promise<PermissionDecision | null> {
  try {
    for await (const hookResult of executePermissionRequestHooks(
      tool.name,
      toolUseID,
      input,
      context,
      permissionMode,
      suggestions,
      context.abortController.signal,
    )) {
      if (!hookResult.permissionRequestResult) {
        continue
      }
      const decision = hookResult.permissionRequestResult
      if (decision.behavior === 'allow') {
        const finalInput = decision.updatedInput ?? input
        // 如果有权限更新则持久化
        if (decision.updatedPermissions?.length) {
          persistPermissionUpdates(decision.updatedPermissions)
          context.setAppState((prev) => ({
            ...prev,
            toolPermissionContext: applyPermissionUpdates(
              prev.toolPermissionContext,
              decision.updatedPermissions!,
            ),
          }))
        }
        return {
          behavior: 'allow',
          updatedInput: finalInput,
          decisionReason: {
            type: 'hook',
            hookName: 'PermissionRequest',
          },
        }
      }
      if (decision.behavior === 'deny') {
        if (decision.interrupt) {
          permLog(`Hook interrupt: tool=${tool.name} hookMessage=${decision.message}`)
          context.abortController.abort()
        }
        return {
          behavior: 'deny',
          message: decision.message || 'Permission denied by hook',
          decisionReason: {
            type: 'hook',
            hookName: 'PermissionRequest',
            reason: decision.message,
          },
        }
      }
    }
  } catch (error) {
    // 如果 hook 失败，继续执行自动拒绝而非崩溃
    logError(
      new Error('PermissionRequest hook failed for headless agent', {
        cause: toError(error),
      }),
    )
  }
  return null
}

export const hasPermissionsToUseTool: CanUseToolFn = async (
  tool,
  input,
  context,
  assistantMessage,
  toolUseID,
): Promise<PermissionDecision> => {
  const result = await hasPermissionsToUseToolInner(tool, input, context)

  // 在 auto 模式下，任何被允许的工具使用都重置连续拒绝计数。
  // 这确保成功的工具使用（即使是被规则自动允许的）
  // 能打断连续拒绝的记录。
  if (result.behavior === 'allow') {
    const appState = context.getAppState()
    const currentDenialState = context.localDenialTracking ?? appState.denialTracking
    if (
      appState.toolPermissionContext.mode === 'auto' &&
      currentDenialState &&
      currentDenialState.consecutiveDenials > 0
    ) {
      const newDenialState = recordSuccess(currentDenialState)
      persistDenialState(context, newDenialState)
    }
    return result
  }

  // 应用 dontAsk 模式转换：将 'ask' 转为 'deny'
  // 放在最后执行以确保不会被提前返回绕过
  if (result.behavior === 'ask') {
    const appState = context.getAppState()

    if (appState.toolPermissionContext.mode === 'dontAsk') {
      return {
        behavior: 'deny',
        decisionReason: {
          type: 'mode',
          mode: 'dontAsk',
        },
        message: DONT_ASK_REJECT_MESSAGE(tool.name),
      }
    }
    // 应用 auto 模式：使用 AI 分类器代替提示用户
    // 在 shouldAvoidPermissionPrompts 之前检查，以便分类器在 headless 模式下也能工作
    if (
      appState.toolPermissionContext.mode === 'auto' ||
      (appState.toolPermissionContext.mode === 'plan' &&
        (autoModeStateModule?.isAutoModeActive() ?? false))
    ) {
      // 不可被分类器批准的 safetyCheck 决策对所有自动批准路径都免疫：
      // acceptEdits 快速路径、安全工具白名单和分类器。步骤 1g 仅保护
      // bypassPermissions；这里保护 auto 模式。可被分类器批准的 safetyCheck
      // （敏感文件路径）会流入分类器 — 下面的快速路径自然不会触发，
      // 因为工具自身的 checkPermissions 仍然返回 'ask'。
      if (
        result.decisionReason?.type === 'safetyCheck' &&
        !result.decisionReason.classifierApprovable
      ) {
        if (appState.toolPermissionContext.shouldAvoidPermissionPrompts) {
          return {
            behavior: 'deny',
            message: result.message,
            decisionReason: {
              type: 'asyncAgent',
              reason:
                'Safety check requires interactive approval and permission prompts are not available in this context',
            },
          }
        }
        return result
      }
      if (tool.requiresUserInteraction?.() && result.behavior === 'ask') {
        return result
      }

      // 对异步子 agent 使用本地拒绝追踪（其 setAppState
      // 是空操作），否则像之前一样从 appState 读取。
      const denialState =
        context.localDenialTracking ?? appState.denialTracking ?? createDenialTrackingState()

      // PowerShell 在 auto 模式下需要显式用户权限，除非
      // POWERSHELL_AUTO_MODE（仅内部构建标志）开启。禁用时，此守卫
      // 将 PS 排除在分类器之外并跳过下面的 acceptEdits 快速路径。
      // 启用时，PS 像 Bash 一样流入分类器 — 分类器提示会追加
      // POWERSHELL_DENY_GUIDANCE，使其识别 `iex (iwr ...)` 为下载并执行等。
      // 注意：这在 behavior === 'ask' 分支内运行，因此更早触发的
      // 放行规则（步骤 2b toolAlwaysAllowedRule、PS 前缀放行）
      // 在到达这里之前就已返回。放行规则保护由
      // permissionSetup.ts 处理：isOverlyBroadPowerShellAllowRule 剥离 PowerShell(*)，
      // isDangerousPowerShellPermission 为内部用户和 auto 模式入口
      // 剥离 iex/pwsh/Start-Process 前缀规则。
      if (
        tool.name === POWERSHELL_TOOL_NAME &&
        !feature('POWERSHELL_AUTO_MODE') &&
        !getAutoModeConfig()?.classifyAllShell
      ) {
        if (appState.toolPermissionContext.shouldAvoidPermissionPrompts) {
          return {
            behavior: 'deny',
            message: 'PowerShell tool requires interactive approval',
            decisionReason: {
              type: 'asyncAgent',
              reason:
                'PowerShell tool requires interactive approval and permission prompts are not available in this context',
            },
          }
        }
        permLog(
          `Skipping auto mode classifier for ${tool.name}: tool requires explicit user permission`,
        )
        return result
      }

      // 在运行 auto 模式分类器之前，检查 acceptEdits 模式是否允许此操作。
      // 这避免了对安全操作（如工作目录中的文件编辑）进行昂贵的分类器 API 调用。
      // 跳过 Agent 和 REPL — 它们的 checkPermissions 在 acceptEdits 模式下返回 'allow'，
      // 这会静默绕过分类器。REPL 代码可能在内部工具调用之间包含 VM 逃逸；
      // 分类器必须看到粘合 JavaScript，而不仅仅是内部工具调用。
      if (
        result.behavior === 'ask' &&
        tool.name !== AGENT_TOOL_NAME &&
        tool.name !== REPL_TOOL_NAME
      ) {
        try {
          const parsedInput = tool.inputSchema.parse(input)
          const acceptEditsResult = await tool.checkPermissions(parsedInput, {
            ...context,
            getAppState: () => {
              const state = context.getAppState()
              return {
                ...state,
                toolPermissionContext: {
                  ...state.toolPermissionContext,
                  mode: 'acceptEdits' as const,
                },
              }
            },
          })
          if (acceptEditsResult.behavior === 'allow') {
            const newDenialState = recordSuccess(denialState)
            persistDenialState(context, newDenialState)
            permLog(
              `Skipping auto mode classifier for ${tool.name}: would be allowed in acceptEdits mode`,
            )
            logEvent('zy_auto_mode_decision', {
              decision: 'allowed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              toolName: sanitizeToolNameForAnalytics(tool.name),
              inProtectedNamespace: isInProtectedNamespace(),
              // 产生此 tool_use 的 agent 补全的 msg_id —
              // 分类器转录底部的操作。将决策关联回
              // 主 agent 的 API 响应。
              agentMsgId: assistantMessage.message
                .id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              confidence: 'high' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              fastPath: 'acceptEdits' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
            return {
              behavior: 'allow',
              updatedInput: acceptEditsResult.updatedInput ?? input,
              decisionReason: {
                type: 'mode',
                mode: 'auto',
              },
            }
          }
        } catch (e) {
          if (e instanceof AbortError || isAbortError(e)) {
            throw e
          }
          // 如果 acceptEdits 检查失败，继续执行分类器
        }
      }

      // 白名单中的工具是安全的，不需要 YOLO 分类。
      // 使用安全工具白名单跳过不必要的分类器 API 调用。
      if (isAutoModeAllowlistedTool(tool.name)) {
        const newDenialState = recordSuccess(denialState)
        persistDenialState(context, newDenialState)
        permLog(`Skipping auto mode classifier for ${tool.name}: tool is on the safe allowlist`)
        logEvent('zy_auto_mode_decision', {
          decision: 'allowed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          toolName: sanitizeToolNameForAnalytics(tool.name),
          inProtectedNamespace: isInProtectedNamespace(),
          agentMsgId: assistantMessage.message
            .id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          confidence: 'high' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          fastPath: 'allowlist' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        return {
          behavior: 'allow',
          updatedInput: input,
          decisionReason: {
            type: 'mode',
            mode: 'auto',
          },
        }
      }

      // 运行 auto 模式分类器
      const action = formatActionForClassifier(tool.name, input)
      setClassifierChecking(toolUseID)
      let classifierResult
      try {
        classifierResult = await classifyYoloAction(
          context.messages,
          action,
          context.options.tools,
          appState.toolPermissionContext,
          context.abortController.signal,
        )
      } finally {
        clearClassifierChecking(toolUseID)
      }

      // 当分类器错误导出了提示时通知内部用户（会在 /share 中）
      if (isInternalBuild() && classifierResult.errorDumpPath && context.addNotification) {
        context.addNotification({
          key: 'auto-mode-error-dump',
          text: `Auto mode classifier error — prompts dumped to ${classifierResult.errorDumpPath} (included in /share)`,
          priority: 'immediate',
          color: 'error',
        })
      }

      // 记录分类器决策用于指标（包括开销遥测）
      const yoloDecision = classifierResult.unavailable
        ? 'unavailable'
        : classifierResult.shouldBlock
          ? 'blocked'
          : 'allowed'

      // 计算分类器成本（美元），用于开销分析
      const classifierCostUSD =
        classifierResult.usage && classifierResult.model
          ? calculateCostFromTokens(classifierResult.model, classifierResult.usage)
          : undefined
      logEvent('zy_auto_mode_decision', {
        decision: yoloDecision as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        toolName: sanitizeToolNameForAnalytics(tool.name),
        inProtectedNamespace: isInProtectedNamespace(),
        // 产生此 tool_use 的 agent 补全的 msg_id —
        // 分类器转录底部的操作。
        agentMsgId: assistantMessage.message
          .id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        classifierModel:
          classifierResult.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        consecutiveDenials: classifierResult.shouldBlock ? denialState.consecutiveDenials + 1 : 0,
        totalDenials: classifierResult.shouldBlock
          ? denialState.totalDenials + 1
          : denialState.totalDenials,
        // 开销遥测：分类器 API 调用的 token 使用和延迟
        classifierInputTokens: classifierResult.usage?.inputTokens,
        classifierOutputTokens: classifierResult.usage?.outputTokens,
        classifierCacheReadInputTokens: classifierResult.usage?.cacheReadInputTokens,
        classifierCacheCreationInputTokens: classifierResult.usage?.cacheCreationInputTokens,
        classifierDurationMs: classifierResult.durationMs,
        // 发送给分类器的提示组件的字符长度
        classifierSystemPromptLength: classifierResult.promptLengths?.systemPrompt,
        classifierToolCallsLength: classifierResult.promptLengths?.toolCalls,
        classifierUserPromptsLength: classifierResult.promptLengths?.userPrompts,
        // 分类器调用时的会话总量（用于计算开销百分比）。
        // 这些仅来自主转录 — sideQuery（分类器使用的）
        // 不会调用 addToTotalSessionCost，因此分类器 token 被排除在外。
        sessionInputTokens: getTotalInputTokens(),
        sessionOutputTokens: getTotalOutputTokens(),
        sessionCacheReadInputTokens: getTotalCacheReadInputTokens(),
        sessionCacheCreationInputTokens: getTotalCacheCreationInputTokens(),
        classifierCostUSD,
        classifierStage:
          classifierResult.stage as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        classifierStage1InputTokens: classifierResult.stage1Usage?.inputTokens,
        classifierStage1OutputTokens: classifierResult.stage1Usage?.outputTokens,
        classifierStage1CacheReadInputTokens: classifierResult.stage1Usage?.cacheReadInputTokens,
        classifierStage1CacheCreationInputTokens:
          classifierResult.stage1Usage?.cacheCreationInputTokens,
        classifierStage1DurationMs: classifierResult.stage1DurationMs,
        classifierStage1RequestId:
          classifierResult.stage1RequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        classifierStage1MsgId:
          classifierResult.stage1MsgId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        classifierStage1CostUSD:
          classifierResult.stage1Usage && classifierResult.model
            ? calculateCostFromTokens(classifierResult.model, classifierResult.stage1Usage)
            : undefined,
        classifierStage2InputTokens: classifierResult.stage2Usage?.inputTokens,
        classifierStage2OutputTokens: classifierResult.stage2Usage?.outputTokens,
        classifierStage2CacheReadInputTokens: classifierResult.stage2Usage?.cacheReadInputTokens,
        classifierStage2CacheCreationInputTokens:
          classifierResult.stage2Usage?.cacheCreationInputTokens,
        classifierStage2DurationMs: classifierResult.stage2DurationMs,
        classifierStage2RequestId:
          classifierResult.stage2RequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        classifierStage2MsgId:
          classifierResult.stage2MsgId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        classifierStage2CostUSD:
          classifierResult.stage2Usage && classifierResult.model
            ? calculateCostFromTokens(classifierResult.model, classifierResult.stage2Usage)
            : undefined,
      })

      if (classifierResult.durationMs !== undefined) {
        addToTurnClassifierDuration(classifierResult.durationMs)
      }

      if (classifierResult.shouldBlock) {
        // 转录超出分类器的上下文窗口 — 确定性错误，
        // 重试不会恢复。跳过 iron_gate 并回退到
        // 正常提示，让用户手动批准/拒绝。
        if (classifierResult.transcriptTooLong) {
          if (appState.toolPermissionContext.shouldAvoidPermissionPrompts) {
            // 永久性条件（转录只增不减）— deny-retry-deny
            // 浪费 token 且永远不会触发拒绝限制中止。
            throw new AbortError(
              'Agent aborted: auto mode classifier transcript exceeded context window in headless mode',
            )
          }
          permLog(
            'Auto mode classifier transcript too long, falling back to normal permission handling',
            { level: 'warn' },
          )
          return {
            ...result,
            decisionReason: {
              type: 'other',
              reason:
                'Auto mode classifier transcript exceeded context window — falling back to manual approval',
            },
          }
        }
        // 当分类器不可用时（API 错误），行为取决于
        // zy_iron_gate_closed 门控。
        if (classifierResult.unavailable) {
          if (getFeatureValue_CACHED_MAY_BE_STALE('zy_iron_gate_closed', true)) {
            permLog('Auto mode classifier unavailable, denying with retry guidance (fail closed)', {
              level: 'warn',
            })
            return {
              behavior: 'deny',
              decisionReason: {
                type: 'classifier',
                classifier: 'auto-mode',
                reason: 'Classifier unavailable',
              },
              message: buildClassifierUnavailableMessage(tool.name, classifierResult.model),
            }
          }
          // 失败开放：回退到正常权限处理
          permLog(
            'Auto mode classifier unavailable, falling back to normal permission handling (fail open)',
            { level: 'warn' },
          )
          return result
        }

        // 更新拒绝追踪并检查限制
        const newDenialState = recordDenial(denialState)
        persistDenialState(context, newDenialState)

        permLog(`Auto mode classifier blocked action: ${classifierResult.reason}`, {
          level: 'warn',
        })

        // 如果达到拒绝限制，回退到提示以便用户
        // 可以审查。在分类器之后检查，以便可以在
        // 提示中包含其原因。
        const denialLimitResult = handleDenialLimitExceeded(
          newDenialState,
          appState,
          classifierResult.reason,
          assistantMessage,
          tool,
          result,
          context,
        )
        if (denialLimitResult) {
          return denialLimitResult
        }

        return {
          behavior: 'deny',
          decisionReason: {
            type: 'classifier',
            classifier: 'auto-mode',
            reason: classifierResult.reason,
          },
          message: buildYoloRejectionMessage(classifierResult.reason),
        }
      }

      // 成功时重置连续拒绝计数
      const newDenialState = recordSuccess(denialState)
      persistDenialState(context, newDenialState)

      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: {
          type: 'classifier',
          classifier: 'auto-mode',
          reason: classifierResult.reason,
        },
      }
    }

    // 当应避免权限提示时（例如后台/headless agent），
    // 先运行 PermissionRequest hook 给它们机会允许/拒绝。
    // 仅在没有 hook 提供决策时才自动拒绝。
    if (appState.toolPermissionContext.shouldAvoidPermissionPrompts) {
      const hookDecision = await runPermissionRequestHooksForHeadlessAgent(
        tool,
        input,
        toolUseID,
        context,
        appState.toolPermissionContext.mode,
        result.suggestions,
      )
      if (hookDecision) {
        return hookDecision
      }
      return {
        behavior: 'deny',
        decisionReason: {
          type: 'asyncAgent',
          reason: 'Permission prompts are not available in this context',
        },
        message: AUTO_REJECT_MESSAGE(tool.name),
      }
    }
  }

  return result
}

/**
 * 持久化拒绝追踪状态。对于具有 localDenialTracking 的异步子 agent，
 * 就地修改本地状态（因为 setAppState 是空操作）。否则，
 * 像往常一样写入 appState。
 */
function persistDenialState(context: ToolUseContext, newState: DenialTrackingState): void {
  if (context.localDenialTracking) {
    Object.assign(context.localDenialTracking, newState)
  } else {
    context.setAppState((prev) => {
      // recordSuccess 在状态未变化时返回相同的引用。
      // 这里返回 prev 让 store.setState 的 Object.is 检查
      // 完全跳过监听器循环。
      if (prev.denialTracking === newState) {
        return prev
      }
      return { ...prev, denialTracking: newState }
    })
  }
}

/**
 * 检查是否超出拒绝限制，如果超出则返回 'ask' 结果
 * 以便用户审查。如果未达到限制则返回 null。
 */
function handleDenialLimitExceeded(
  denialState: DenialTrackingState,
  appState: {
    toolPermissionContext: { shouldAvoidPermissionPrompts?: boolean }
  },
  classifierReason: string,
  assistantMessage: AssistantMessage,
  tool: Tool,
  result: PermissionDecision,
  context: ToolUseContext,
): PermissionDecision | null {
  if (!shouldFallbackToPrompting(denialState)) {
    return null
  }

  const hitTotalLimit = denialState.totalDenials >= DENIAL_LIMITS.maxTotal
  const isHeadless = appState.toolPermissionContext.shouldAvoidPermissionPrompts
  // 在 persistDenialState 之前捕获计数，因为对于具有 localDenialTracking
  // 的子 agent，它可能通过 Object.assign 就地修改 denialState。
  const totalCount = denialState.totalDenials
  const consecutiveCount = denialState.consecutiveDenials
  const warning = hitTotalLimit
    ? `${totalCount} actions were blocked this session. Please review the transcript before continuing.`
    : `${consecutiveCount} consecutive actions were blocked. Please review the transcript before continuing.`

  logEvent('zy_auto_mode_denial_limit_exceeded', {
    limit: (hitTotalLimit
      ? 'total'
      : 'consecutive') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    mode: (isHeadless
      ? 'headless'
      : 'cli') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    messageID: assistantMessage.message
      .id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    consecutiveDenials: consecutiveCount,
    totalDenials: totalCount,
    toolName: sanitizeToolNameForAnalytics(tool.name),
  })

  if (isHeadless) {
    throw new AbortError('Agent aborted: too many classifier denials in headless mode')
  }

  permLog(`Classifier denial limit exceeded, falling back to prompting: ${warning}`, {
    level: 'warn',
  })

  if (hitTotalLimit) {
    persistDenialState(context, {
      ...denialState,
      totalDenials: 0,
      consecutiveDenials: 0,
    })
  }

  // 保留原始分类器值（例如 'dangerous-agent-action'），
  // 以便 interactiveHandler 中的下游分析可以记录正确的
  // 用户覆盖事件。
  const originalClassifier =
    result.decisionReason?.type === 'classifier' ? result.decisionReason.classifier : 'auto-mode'

  return {
    ...result,
    decisionReason: {
      type: 'classifier',
      classifier: originalClassifier,
      reason: `${warning}\n\nLatest blocked action: ${classifierReason}`,
    },
  }
}

/**
 * 仅检查权限管道中基于规则的步骤 — 即 bypassPermissions 模式
 * 遵守的子集（步骤 2a 之前触发的所有内容）。
 *
 * 如果规则阻止了工具则返回 deny/ask 决策，如果没有规则反对则返回 null。
 * 与 hasPermissionsToUseTool 不同，这不会运行 auto 模式分类器、
 * 基于模式的转换（dontAsk/auto/asyncAgent）、PermissionRequest hook、
 * 或 bypassPermissions / 始终允许检查。
 *
 * 调用者必须预先检查 tool.requiresUserInteraction() — 步骤 1e 未被复制。
 */
export async function checkRuleBasedPermissions(
  tool: Tool,
  input: { [key: string]: unknown },
  context: ToolUseContext,
): Promise<PermissionAskDecision | PermissionDenyDecision | null> {
  const appState = context.getAppState()

  // 1a. 整个工具被规则拒绝
  const denyRule = getDenyRuleForTool(appState.toolPermissionContext, tool)
  if (denyRule) {
    return {
      behavior: 'deny',
      decisionReason: {
        type: 'rule',
        rule: denyRule,
      },
      message: `Permission to use ${tool.name} has been denied.`,
    }
  }

  // 1b. 整个工具有 ask 规则
  const askRule = getAskRuleForTool(appState.toolPermissionContext, tool)
  if (askRule) {
    const canSandboxAutoAllow =
      tool.name === BASH_TOOL_NAME &&
      SandboxManager.isSandboxingEnabled() &&
      SandboxManager.isAutoAllowBashIfSandboxedEnabled() &&
      shouldUseSandbox(input)

    if (!canSandboxAutoAllow) {
      return {
        behavior: 'ask',
        decisionReason: {
          type: 'rule',
          rule: askRule,
        },
        message: createPermissionRequestMessage(tool.name),
      }
    }
    // 继续执行，让 tool.checkPermissions 处理命令特定的规则
  }

  // 1c. 工具特定的权限检查（例如 bash 子命令规则）
  let toolPermissionResult: PermissionResult = {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(tool.name),
  }
  try {
    const parsedInput = tool.inputSchema.parse(input)
    toolPermissionResult = await tool.checkPermissions(parsedInput, context)
  } catch (e) {
    if (e instanceof AbortError || isAbortError(e)) {
      throw e
    }
    logError(e)
  }

  // 1d. 工具实现拒绝了权限（捕获包裹在 subcommandResults 中的
  // bash 子命令拒绝 — 无需检查 decisionReason.type）
  if (toolPermissionResult?.behavior === 'deny') {
    return toolPermissionResult
  }

  // 1f. 来自 tool.checkPermissions 的内容特定 ask 规则
  // （例如 Bash(npm publish:*) → {ask, type:'rule', ruleBehavior:'ask'}）
  if (
    toolPermissionResult?.behavior === 'ask' &&
    toolPermissionResult.decisionReason?.type === 'rule' &&
    toolPermissionResult.decisionReason.rule.ruleBehavior === 'ask'
  ) {
    return toolPermissionResult
  }

  // 1g. 安全检查（例如 .git/、.zy/、.vscode/、shell 配置）
  // 免疫绕过 — 即使 PreToolUse hook 返回允许也必须提示。
  // checkPathSafetyForAutoEdit 对这些路径返回 {type:'safetyCheck'}。
  if (
    toolPermissionResult?.behavior === 'ask' &&
    toolPermissionResult.decisionReason?.type === 'safetyCheck'
  ) {
    return toolPermissionResult
  }

  // 没有基于规则的异议
  return null
}

async function hasPermissionsToUseToolInner(
  tool: Tool,
  input: { [key: string]: unknown },
  context: ToolUseContext,
): Promise<PermissionDecision> {
  if (context.abortController.signal.aborted) {
    throw new AbortError()
  }

  let appState = context.getAppState()

  // 1. 检查工具是否被拒绝
  // 1a. 整个工具被拒绝
  const denyRule = getDenyRuleForTool(appState.toolPermissionContext, tool)
  if (denyRule) {
    return {
      behavior: 'deny',
      decisionReason: {
        type: 'rule',
        rule: denyRule,
      },
      message: `Permission to use ${tool.name} has been denied.`,
    }
  }

  // 1b. 检查整个工具是否应始终请求权限
  const askRule = getAskRuleForTool(appState.toolPermissionContext, tool)
  if (askRule) {
    // 当 autoAllowBashIfSandboxed 开启时，沙箱内的命令跳过 ask 规则并
    // 通过 Bash 的 checkPermissions 自动允许。不会被沙箱化的命令（排除的
    // 命令、dangerouslyDisableSandbox）仍需遵守 ask 规则。
    const canSandboxAutoAllow =
      tool.name === BASH_TOOL_NAME &&
      SandboxManager.isSandboxingEnabled() &&
      SandboxManager.isAutoAllowBashIfSandboxedEnabled() &&
      shouldUseSandbox(input)

    if (!canSandboxAutoAllow) {
      return {
        behavior: 'ask',
        decisionReason: {
          type: 'rule',
          rule: askRule,
        },
        message: createPermissionRequestMessage(tool.name),
      }
    }
    // 继续执行，让 Bash 的 checkPermissions 处理命令特定的规则
  }

  // 1c. 向工具实现请求权限结果
  // 除非工具输入 schema 无效，否则会被覆盖
  let toolPermissionResult: PermissionResult = {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(tool.name),
  }
  try {
    const parsedInput = tool.inputSchema.parse(input)
    toolPermissionResult = await tool.checkPermissions(parsedInput, context)
  } catch (e) {
    // 重新抛出中止错误以便正确传播
    if (e instanceof AbortError || isAbortError(e)) {
      throw e
    }
    logError(e)
  }

  // 1d. 工具实现拒绝了权限
  if (toolPermissionResult?.behavior === 'deny') {
    return toolPermissionResult
  }

  // 1e. 即使在 bypass 模式下工具也需要用户交互
  if (tool.requiresUserInteraction?.() && toolPermissionResult?.behavior === 'ask') {
    return toolPermissionResult
  }

  // 1f. 来自 tool.checkPermissions 的内容特定 ask 规则优先于
  // bypassPermissions 模式。当用户显式配置了内容特定的 ask 规则
  // （例如 Bash(npm publish:*)）时，工具的 checkPermissions 返回
  // {behavior:'ask', decisionReason:{type:'rule', rule:{ruleBehavior:'ask'}}}。
  // 这必须被遵守，即使在 bypass 模式下也是如此，
  // 就像步骤 1d 中遵守拒绝规则一样。
  if (
    toolPermissionResult?.behavior === 'ask' &&
    toolPermissionResult.decisionReason?.type === 'rule' &&
    toolPermissionResult.decisionReason.rule.ruleBehavior === 'ask'
  ) {
    return toolPermissionResult
  }

  // 1g. 安全检查（例如 .git/、.zy/、.vscode/、shell 配置）
  // 免疫绕过 — 即使在 bypassPermissions 模式下也必须提示。
  // checkPathSafetyForAutoEdit 对这些路径返回 {type:'safetyCheck'}。
  if (
    toolPermissionResult?.behavior === 'ask' &&
    toolPermissionResult.decisionReason?.type === 'safetyCheck'
  ) {
    return toolPermissionResult
  }

  // 2a. 检查模式是否允许工具运行
  // 重要：调用 getAppState() 获取最新值
  appState = context.getAppState()
  // 检查是否应该绕过权限：
  // - 直接的 bypassPermissions 模式
  // - 用户最初以 bypass 模式启动时的 plan 模式（isBypassPermissionsModeAvailable）
  const shouldBypassPermissions =
    appState.toolPermissionContext.mode === 'bypassPermissions' ||
    (appState.toolPermissionContext.mode === 'plan' &&
      appState.toolPermissionContext.isBypassPermissionsModeAvailable)
  if (shouldBypassPermissions) {
    return {
      behavior: 'allow',
      updatedInput: getUpdatedInputOrFallback(toolPermissionResult, input),
      decisionReason: {
        type: 'mode',
        mode: appState.toolPermissionContext.mode,
      },
    }
  }

  // 2b. 整个工具被允许
  const alwaysAllowedRule = toolAlwaysAllowedRule(appState.toolPermissionContext, tool)
  if (alwaysAllowedRule) {
    return {
      behavior: 'allow',
      updatedInput: getUpdatedInputOrFallback(toolPermissionResult, input),
      decisionReason: {
        type: 'rule',
        rule: alwaysAllowedRule,
      },
    }
  }

  // 3. 将 "passthrough" 转为 "ask"
  const result: PermissionDecision =
    toolPermissionResult.behavior === 'passthrough'
      ? {
          ...toolPermissionResult,
          behavior: 'ask' as const,
          message: createPermissionRequestMessage(tool.name, toolPermissionResult.decisionReason),
        }
      : toolPermissionResult

  if (result.behavior === 'ask' && result.suggestions) {
    permLog(
      `Permission suggestions for ${tool.name}: ${jsonStringify(result.suggestions, null, 2)}`,
    )
  }

  return result
}

type EditPermissionRuleArgs = {
  initialContext: ToolPermissionContext
  setToolPermissionContext: (updatedContext: ToolPermissionContext) => void
}

/**
 * 从适当的目标中删除权限规则
 */
export async function deletePermissionRule({
  rule,
  initialContext,
  setToolPermissionContext,
}: EditPermissionRuleArgs & { rule: PermissionRule }): Promise<void> {
  if (
    rule.source === 'policySettings' ||
    rule.source === 'flagSettings' ||
    rule.source === 'command'
  ) {
    throw new Error('Cannot delete permission rules from read-only settings')
  }

  const updatedContext = applyPermissionUpdate(initialContext, {
    type: 'removeRules',
    rules: [rule.ruleValue],
    behavior: rule.ruleBehavior,
    destination: rule.source as PermissionUpdateDestination,
  })

  // 按目标执行从设置中删除规则的逻辑
  const destination = rule.source
  switch (destination) {
    case 'localSettings':
    case 'userSettings':
    case 'projectSettings': {
      // 注意：即使我们对 `rule.source` 进行了 switch，TypeScript 也不知道 rule 符合 `PermissionRuleFromEditableSettings`
      deletePermissionRuleFromSettings(rule as PermissionRuleFromEditableSettings)
      break
    }
    case 'cliArg':
    case 'session': {
      // 内存中的来源不需要操作 - 不会持久化到磁盘
      break
    }
  }

  // 用更新后的上下文更新 React 状态
  setToolPermissionContext(updatedContext)
}

/**
 * 将 PermissionRule 数组转换为 PermissionUpdate 数组的辅助函数
 */
function convertRulesToUpdates(
  rules: PermissionRule[],
  updateType: 'addRules' | 'replaceRules',
): PermissionUpdate[] {
  // 按来源和行为分组规则
  const grouped = new Map<string, PermissionRuleValue[]>()

  for (const rule of rules) {
    const key = `${rule.source}:${rule.ruleBehavior}`
    if (!grouped.has(key)) {
      grouped.set(key, [])
    }
    grouped.get(key)!.push(rule.ruleValue)
  }

  // 转换为 PermissionUpdate 数组
  const updates: PermissionUpdate[] = []
  for (const [key, ruleValues] of grouped) {
    const [source, behavior] = key.split(':')
    updates.push({
      type: updateType,
      rules: ruleValues,
      behavior: behavior as PermissionBehavior,
      destination: source as PermissionUpdateDestination,
    })
  }

  return updates
}

/**
 * 将权限规则应用到上下文（追加式 - 用于初始设置）
 */
export function applyPermissionRulesToPermissionContext(
  toolPermissionContext: ToolPermissionContext,
  rules: PermissionRule[],
): ToolPermissionContext {
  const updates = convertRulesToUpdates(rules, 'addRules')
  return applyPermissionUpdates(toolPermissionContext, updates)
}

/**
 * 从磁盘同步权限规则（替换式 - 用于设置变更）
 */
export function syncPermissionRulesFromDisk(
  toolPermissionContext: ToolPermissionContext,
  rules: PermissionRule[],
): ToolPermissionContext {
  let context = toolPermissionContext

  // 当 allowManagedPermissionRulesOnly 启用时，清除所有非策略来源
  if (shouldAllowManagedPermissionRulesOnly()) {
    const sourcesToClear: PermissionUpdateDestination[] = [
      'userSettings',
      'projectSettings',
      'localSettings',
      'cliArg',
      'session',
    ]
    const behaviors: PermissionBehavior[] = ['allow', 'deny', 'ask']

    for (const source of sourcesToClear) {
      for (const behavior of behaviors) {
        context = applyPermissionUpdate(context, {
          type: 'replaceRules',
          rules: [],
          behavior,
          destination: source,
        })
      }
    }
  }

  // 在应用新规则之前清除所有基于磁盘的 source:behavior 组合。
  // 如果不这样做，从设置中移除一条规则（例如删除一个 deny 条目）
  // 会导致旧规则留在上下文中，因为 convertRulesToUpdates
  // 仅为有规则的 source:behavior 对生成 replaceRules —
  // 空组不产生更新，因此过时的规则会持续存在。
  const diskSources: PermissionUpdateDestination[] = [
    'userSettings',
    'projectSettings',
    'localSettings',
  ]
  for (const diskSource of diskSources) {
    for (const behavior of ['allow', 'deny', 'ask'] as PermissionBehavior[]) {
      context = applyPermissionUpdate(context, {
        type: 'replaceRules',
        rules: [],
        behavior,
        destination: diskSource,
      })
    }
  }

  const updates = convertRulesToUpdates(rules, 'replaceRules')
  return applyPermissionUpdates(context, updates)
}

/**
 * 从权限结果中提取 updatedInput，如果不存在则回退到原始输入。
 * 处理某些 PermissionResult 变体没有 updatedInput 的情况。
 */
function getUpdatedInputOrFallback(
  permissionResult: PermissionResult,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  return (
    ('updatedInput' in permissionResult ? permissionResult.updatedInput : undefined) ?? fallback
  )
}
