/**
 * 为解除循环导入而抽取的纯 permission 类型定义。
 *
 * 本文件仅包含类型定义和常量，不存在运行时依赖。
 * 实现文件仍位于 src/services/permissions/，但现在可从此处导入以避免循环依赖。
 */

import type { ContentBlock } from './llm.js'

// ============================================================================
// Permission 模式
// ============================================================================

export const EXTERNAL_PERMISSION_MODES = [
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
] as const

export type ExternalPermissionMode = (typeof EXTERNAL_PERMISSION_MODES)[number]

// 用于类型检查的完整模式联合。用户可选的运行时集合
// 是下方 INTERNAL_PERMISSION_MODES。
export type InternalPermissionMode = ExternalPermissionMode | 'auto' | 'bubble'
export type PermissionMode = InternalPermissionMode

// 运行时校验集合：用户可选的模式（settings.json defaultMode、
// --permission-mode CLI flag、会话恢复）。
export const INTERNAL_PERMISSION_MODES = [
  ...EXTERNAL_PERMISSION_MODES,
  'auto',
] as const satisfies readonly PermissionMode[]

export const PERMISSION_MODES = INTERNAL_PERMISSION_MODES

// ============================================================================
// Permission 行为
// ============================================================================

export type PermissionBehavior = 'allow' | 'deny' | 'ask'

// ============================================================================
// Permission 规则
// ============================================================================

/**
 * permission 规则的来源。
 * 包括所有 SettingSource 值和规则专用的额外来源。
 */
export type PermissionRuleSource =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'flagSettings'
  | 'policySettings'
  | 'cliArg'
  | 'command'
  | 'session'

/**
 * permission 规则的值，用于指定 Tool 及可选内容。
 */
export type PermissionRuleValue = {
  toolName: string
  ruleContent?: string
}

/**
 * 包含来源和行为的 permission 规则。
 */
export type PermissionRule = {
  source: PermissionRuleSource
  ruleBehavior: PermissionBehavior
  ruleValue: PermissionRuleValue
}

// ============================================================================
// Permission 更新
// ============================================================================

/**
 * permission 更新的持久化位置。
 */
export type PermissionUpdateDestination =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'session'
  | 'cliArg'

/**
 * permission 配置的更新操作。
 */
export type PermissionUpdate =
  | {
      type: 'addRules'
      destination: PermissionUpdateDestination
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
    }
  | {
      type: 'replaceRules'
      destination: PermissionUpdateDestination
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
    }
  | {
      type: 'removeRules'
      destination: PermissionUpdateDestination
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
    }
  | {
      type: 'setMode'
      destination: PermissionUpdateDestination
      mode: ExternalPermissionMode
    }
  | {
      type: 'addDirectories'
      destination: PermissionUpdateDestination
      directories: string[]
    }
  | {
      type: 'removeDirectories'
      destination: PermissionUpdateDestination
      directories: string[]
    }

/**
 * 额外工作目录 permission 的来源。
 * 注意：当前与 PermissionRuleSource 相同，但为保持语义清晰并允许未来分化，
 * 仍保留为独立类型。
 */
export type WorkingDirectorySource = PermissionRuleSource

/**
 * permission scope 中包含的额外目录。
 */
export type AdditionalWorkingDirectory = {
  path: string
  source: WorkingDirectorySource
}

// ============================================================================
// Permission 决策与结果
// ============================================================================

/**
 * permission 元数据使用的最小命令结构。
 * 为避免循环导入，特意只保留完整 Command 类型的子集，
 * 仅包含 permission 相关组件所需属性。
 */
export type PermissionCommandMetadata = {
  name: string
  description?: string
  // 允许额外属性，以保持向前兼容
  [key: string]: unknown
}

/**
 * permission 决策附带的元数据。
 */
export type PermissionMetadata = { command: PermissionCommandMetadata } | undefined

/**
 * permission 通过时的结果。
 */
export type PermissionAllowDecision<
  Input extends { [key: string]: unknown } = { [key: string]: unknown },
> = {
  behavior: 'allow'
  updatedInput?: Input
  userModified?: boolean
  decisionReason?: PermissionDecisionReason
  toolUseID?: string
  acceptFeedback?: string
  contentBlocks?: ContentBlock[]
}

/**
 * 即将异步执行的 classifier 检查元数据。
 * 用于启用非阻塞的 allow classifier 评估。
 */
export type PendingClassifierCheck = {
  command: string
  cwd: string
  descriptions: string[]
}

/**
 * 需要提示用户时的结果。
 */
export type PermissionAskDecision<
  Input extends { [key: string]: unknown } = { [key: string]: unknown },
> = {
  behavior: 'ask'
  message: string
  updatedInput?: Input
  decisionReason?: PermissionDecisionReason
  suggestions?: PermissionUpdate[]
  blockedPath?: string
  metadata?: PermissionMetadata
  /**
   * 为 true 时，表示该 ask 决策由 bashCommandIsSafe_DEPRECATED 安全检查触发，
   * 针对 splitCommand_DEPRECATED 可能误解析的模式（如换行续写、shell 引号转换）。
   * bashToolHasPermission 会在 splitCommand_DEPRECATED 转换命令前据此提前阻止。
   * 简单的换行复合命令不设置此项。
   */
  isBashSecurityCheckForMisparsing?: boolean
  /**
   * 设置后应异步运行 allow classifier 检查。
   * classifier 可能在用户回应前自动批准 permission。
   */
  pendingClassifierCheck?: PendingClassifierCheck
  /**
   * Tool 结果中与拒绝消息一同返回的可选内容块（如图像）。
   * 用于用户粘贴图像作为反馈的场景。
   */
  contentBlocks?: ContentBlock[]
}

/**
 * permission 被拒绝时的结果。
 */
export type PermissionDenyDecision = {
  behavior: 'deny'
  message: string
  decisionReason: PermissionDecisionReason
  toolUseID?: string
}

/**
 * permission 决策：allow、ask 或 deny。
 */
export type PermissionDecision<
  Input extends { [key: string]: unknown } = { [key: string]: unknown },
> = PermissionAllowDecision<Input> | PermissionAskDecision<Input> | PermissionDenyDecision

/**
 * 带额外透传选项的 permission 结果。
 */
export type PermissionResult<
  Input extends { [key: string]: unknown } = { [key: string]: unknown },
> =
  | PermissionDecision<Input>
  | {
      behavior: 'passthrough'
      message: string
      decisionReason?: PermissionDecision<Input>['decisionReason']
      suggestions?: PermissionUpdate[]
      blockedPath?: string
      /**
       * 设置后应异步运行 allow classifier 检查。
       * classifier 可能在用户回应前自动批准 permission。
       */
      pendingClassifierCheck?: PendingClassifierCheck
    }

/**
 * permission 决策的原因说明。
 */
export type PermissionDecisionReason =
  | {
      type: 'rule'
      rule: PermissionRule
    }
  | {
      type: 'mode'
      mode: PermissionMode
    }
  | {
      type: 'subcommandResults'
      reasons: Map<string, PermissionResult>
    }
  | {
      type: 'permissionPromptTool'
      permissionPromptToolName: string
      toolResult: unknown
    }
  | {
      type: 'hook'
      hookName: string
      hookSource?: string
      reason?: string
    }
  | {
      type: 'asyncAgent'
      reason: string
    }
  | {
      type: 'sandboxOverride'
      reason: 'excludedCommand' | 'dangerouslyDisableSandbox'
    }
  | {
      type: 'classifier'
      classifier: string
      reason: string
    }
  | {
      type: 'workingDir'
      reason: string
    }
  | {
      type: 'safetyCheck'
      reason: string
      // 为 true 时，auto 模式会交由 classifier 评估，不强制弹出提示。敏感文件路径
      //（.zy/、.git/、shell 配置）会设为 true，因为 classifier 可结合 context 判断；
      // Windows 路径绕过尝试和跨机器 bridge 消息则设为 false。
      classifierApprovable: boolean
    }
  | {
      type: 'other'
      reason: string
    }

// ============================================================================
// Bash Classifier 类型
// ============================================================================

export type ClassifierResult = {
  matches: boolean
  matchedDescription?: string
  confidence: 'high' | 'medium' | 'low'
  reason: string
}

export type ClassifierBehavior = 'deny' | 'ask' | 'allow'

export type ClassifierUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

export type YoloClassifierResult = {
  thinking?: string
  shouldBlock: boolean
  reason: string
  unavailable?: boolean
  /**
   * API returned "prompt is too long" — the classifier transcript exceeded
   * the context window. Deterministic (same transcript → same error), so
   * callers should fall back to normal prompting rather than retry/fail-closed.
   */
  transcriptTooLong?: boolean
  /** The model used for this classifier call */
  model: string
  /** Token usage from the classifier API call (for overhead telemetry) */
  usage?: ClassifierUsage
  /** Duration of the classifier API call in ms */
  durationMs?: number
  /** Character lengths of the prompt components sent to the classifier */
  promptLengths?: {
    systemPrompt: number
    toolCalls: number
    userPrompts: number
  }
  /** Path where error prompts were dumped (only set when unavailable due to API error) */
  errorDumpPath?: string
  /** Which classifier stage produced the final decision (2-stage XML only) */
  stage?: 'fast' | 'thinking'
  /** Token usage from stage 1 (fast) when stage 2 was also run */
  stage1Usage?: ClassifierUsage
  /** Duration of stage 1 in ms when stage 2 was also run */
  stage1DurationMs?: number
  /**
   * API request_id (req_xxx) for stage 1. Enables joining to server-side
   * api_usage logs for cache-miss / routing attribution. Also used for the
   * legacy 1-stage (tool_use) classifier — the single request goes here.
   */
  stage1RequestId?: string
  /**
   * API message id (msg_xxx) for stage 1. Enables joining the
   * zy_auto_mode_decision analytics event to the classifier's actual
   * prompt/completion in post-analysis.
   */
  stage1MsgId?: string
  /** Token usage from stage 2 (thinking) when stage 2 was run */
  stage2Usage?: ClassifierUsage
  /** Duration of stage 2 in ms when stage 2 was run */
  stage2DurationMs?: number
  /** API request_id for stage 2 (set whenever stage 2 ran) */
  stage2RequestId?: string
  /** API message id (msg_xxx) for stage 2 (set whenever stage 2 ran) */
  stage2MsgId?: string
}

// ============================================================================
// Permission Explainer Types
// ============================================================================

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH'

export type PermissionExplanation = {
  riskLevel: RiskLevel
  explanation: string
  reasoning: string
  risk: string
}

// ============================================================================
// Tool Permission Context
// ============================================================================

/**
 * Mapping of permission rules by their source
 */
export type ToolPermissionRulesBySource = {
  [T in PermissionRuleSource]?: string[]
}

/**
 * Context needed for permission checking in tools
 * Note: Uses a simplified DeepImmutable approximation for this types-only file
 */
export type ToolPermissionContext = {
  readonly mode: PermissionMode
  readonly additionalWorkingDirectories: ReadonlyMap<string, AdditionalWorkingDirectory>
  readonly alwaysAllowRules: ToolPermissionRulesBySource
  readonly alwaysDenyRules: ToolPermissionRulesBySource
  readonly alwaysAskRules: ToolPermissionRulesBySource
  readonly isBypassPermissionsModeAvailable: boolean
  readonly strippedDangerousRules?: ToolPermissionRulesBySource
  readonly shouldAvoidPermissionPrompts?: boolean
  readonly awaitAutomatedChecksBeforeDialog?: boolean
  readonly prePlanMode?: PermissionMode
}
