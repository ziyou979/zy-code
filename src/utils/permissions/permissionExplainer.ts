import { z } from 'zod/v4'
import { logEvent } from '../../services/analytics/index.js'
import { sanitizeToolNameForAnalytics } from '../../services/analytics/metadata.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { getGlobalConfig } from '../config.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { lazySchema } from '../lazySchema.js'
import { logError } from '../log.js'
import { getMainLoopModel } from '../model/model.js'
import { sideQuery } from '../sideQuery.js'
import { jsonStringify } from '../slowOperations.js'

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH'

// 将风险等级映射为数值，用于数据分析
const RISK_LEVEL_NUMERIC: Record<RiskLevel, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
}

// 用于数据分析的错误类型代码
const ERROR_TYPE_PARSE = 1
const ERROR_TYPE_NETWORK = 2
const ERROR_TYPE_UNKNOWN = 3

export type PermissionExplanation = {
  riskLevel: RiskLevel
  explanation: string
  reasoning: string
  risk: string
}

type GenerateExplanationParams = {
  toolName: string
  toolInput: unknown
  toolDescription?: string
  messages?: Message[]
  signal: AbortSignal
}

const SYSTEM_PROMPT = `Analyze shell commands and explain what they do, why you're running them, and potential risks.`

// 工具定义，用于强制结构化输出（无需 beta 版本）
const EXPLAIN_COMMAND_TOOL = {
  name: 'explain_command',
  description: 'Provide an explanation of a shell command',
  inputSchema: {
    type: 'object' as const,
    properties: {
      explanation: {
        type: 'string',
        description: 'What this command does (1-2 sentences)',
      },
      reasoning: {
        type: 'string',
        description:
          'Why YOU are running this command. Start with "I" - e.g. "I need to check the file contents"',
      },
      risk: {
        type: 'string',
        description: 'What could go wrong, under 15 words',
      },
      riskLevel: {
        type: 'string',
        enum: ['LOW', 'MEDIUM', 'HIGH'],
        description:
          'LOW (safe dev workflows), MEDIUM (recoverable changes), HIGH (dangerous/irreversible)',
      },
    },
    required: ['explanation', 'reasoning', 'risk', 'riskLevel'],
  },
}

// 用于解析和验证响应的 Zod schema
const RiskAssessmentSchema = lazySchema(() =>
  z.object({
    riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    explanation: z.string(),
    reasoning: z.string(),
    risk: z.string(),
  }),
)

function formatToolInput(input: unknown): string {
  if (typeof input === 'string') {
    return input
  }
  try {
    return jsonStringify(input, null, 2)
  } catch {
    return String(input)
  }
}

/**
 * 从消息中提取最近的对话上下文，供解释器使用。
 * 返回最近助手消息的摘要，为"为什么"运行此命令提供上下文。
 */
function extractConversationContext(messages: Message[], maxChars = 1000): string {
  // 获取最近的助手消息（包含 Zy 的推理过程）
  const assistantMessages = messages
    .filter((m): m is AssistantMessage => m.type === 'assistant')
    .slice(-3) // 最近 3 条助手消息

  const contextParts: string[] = []
  let totalChars = 0

  for (const msg of assistantMessages.reverse()) {
    // 从助手消息中提取文本内容
    const content = Array.isArray(msg.message.content) ? msg.message.content : []
    const textBlocks = content
      .filter((c) => c.type === 'text')
      .map((c) => ('text' in c ? c.text : ''))
      .join(' ')

    if (textBlocks && totalChars < maxChars) {
      const remaining = maxChars - totalChars
      const truncated =
        textBlocks.length > remaining ? textBlocks.slice(0, remaining) + '...' : textBlocks
      contextParts.unshift(truncated)
      totalChars += truncated.length
    }
  }

  return contextParts.join('\n\n')
}

/**
 * 检查权限解释器功能是否已启用。
 * 默认启用；用户可通过配置选择退出。
 */
export function isPermissionExplainerEnabled(): boolean {
  return getGlobalConfig().permissionExplainerEnabled !== false
}

/**
 * 使用 Haiku 模型生成带结构化输出的权限解释。
 * 如果功能被禁用、请求被中止或发生错误，则返回 null。
 */
export async function generatePermissionExplanation({
  toolName,
  toolInput,
  toolDescription,
  messages,
  signal,
}: GenerateExplanationParams): Promise<PermissionExplanation | null> {
  // 检查功能是否已启用
  if (!isPermissionExplainerEnabled()) {
    return null
  }

  const startTime = Date.now()

  try {
    const formattedInput = formatToolInput(toolInput)
    const conversationContext = messages?.length ? extractConversationContext(messages) : ''

    const userPrompt = `Tool: ${toolName}
${toolDescription ? `Description: ${toolDescription}\n` : ''}
Input:
${formattedInput}
${conversationContext ? `\nRecent conversation context:\n${conversationContext}` : ''}

Explain this command in context.`

    const model = getMainLoopModel()

    // 使用 sideQuery 并强制工具选择，以保证结构化输出
    const response = await sideQuery({
      model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      tools: [EXPLAIN_COMMAND_TOOL],
      tool_choice: { type: 'tool', name: 'explain_command' },
      signal,
      querySource: 'permission_explainer' as any,
    })

    const latencyMs = Date.now() - startTime
    logForDebugging(
      `Permission explainer: API returned in ${latencyMs}ms, stopReason=${response.stopReason}`,
    )

    // 从工具调用块中提取结构化数据
    const toolUseBlock = response.content.find((c) => c.type === 'tool_call')
    if (toolUseBlock && toolUseBlock.type === 'tool_call') {
      logForDebugging(
        `Permission explainer: tool input: ${jsonStringify(toolUseBlock.input).slice(0, 500)}`,
      )
      const result = RiskAssessmentSchema().safeParse(toolUseBlock.input)

      if (result.success) {
        const explanation: PermissionExplanation = {
          riskLevel: result.data.riskLevel,
          explanation: result.data.explanation,
          reasoning: result.data.reasoning,
          risk: result.data.risk,
        }

        logEvent('zy_permission_explainer_generated', {
          tool_name: sanitizeToolNameForAnalytics(toolName),
          risk_level: RISK_LEVEL_NUMERIC[explanation.riskLevel],
          latency_ms: latencyMs,
        })
        logForDebugging(
          `Permission explainer: ${explanation.riskLevel} risk for ${toolName} (${latencyMs}ms)`,
        )
        return explanation
      }
    }

    // 响应中没有有效的 JSON
    logEvent('zy_permission_explainer_error', {
      tool_name: sanitizeToolNameForAnalytics(toolName),
      error_type: ERROR_TYPE_PARSE,
      latency_ms: latencyMs,
    })
    logForDebugging(`Permission explainer: no parsed output in response`)
    return null
  } catch (error) {
    const latencyMs = Date.now() - startTime

    // 不将已中止的请求记录为错误
    if (signal.aborted) {
      logForDebugging(`Permission explainer: request aborted for ${toolName}`)
      return null
    }

    logForDebugging(`Permission explainer error: ${errorMessage(error)}`)
    logError(error)
    logEvent('zy_permission_explainer_error', {
      tool_name: sanitizeToolNameForAnalytics(toolName),
      error_type:
        error instanceof Error && error.name === 'AbortError'
          ? ERROR_TYPE_NETWORK
          : ERROR_TYPE_UNKNOWN,
      latency_ms: latencyMs,
    })
    return null
  }
}
