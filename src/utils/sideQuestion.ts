/**
 * 侧问（"/btw"）功能 - 允许用户快速提问而不打断主 agent 上下文。
 *
 * 使用 runForkedAgent 复用父上下文的 prompt 缓存，
 * 同时将侧问的响应与主对话隔离。
 */

import { formatAPIError } from '../services/api/errorUtils.js'
import type { NonNullableUsage } from '../services/api/logging.js'
import type { AssistantContentBlock } from '../types/llm.js'
import type { Message, SystemAPIErrorMessage } from '../types/message.js'
import { type CacheSafeParams, runForkedAgent } from './forkedAgent.js'
import { createUserMessage, extractTextContent } from './messages.js'

// 匹配输入开头的 "/btw" 关键词（不区分大小写，词边界）
const BTW_PATTERN = /^\/btw\b/gi

/**
 * 查找文本开头 "/btw" 关键词的位置，用于高亮显示。
 * 类似于 thinking.ts 中的 findThinkingTriggerPositions。
 */
export function findBtwTriggerPositions(text: string): Array<{
  word: string
  start: number
  end: number
}> {
  const positions: Array<{ word: string; start: number; end: number }> = []
  const matches = text.matchAll(BTW_PATTERN)

  for (const match of matches) {
    if (match.index !== undefined) {
      positions.push({
        word: match[0],
        start: match.index,
        end: match.index + match[0].length,
      })
    }
  }

  return positions
}

export type SideQuestionResult = {
  response: string | null
  usage: NonNullableUsage
}

/**
 * 使用 forked agent 运行侧问。
 * 共享父级的 prompt 缓存 - 不覆盖 thinking 配置，不写入缓存。
 * 所有工具被禁用，最多执行 1 轮。
 */
export async function runSideQuestion({
  question,
  cacheSafeParams,
}: {
  question: string
  cacheSafeParams: CacheSafeParams
}): Promise<SideQuestionResult> {
  // 将问题包装为无工具直接回答的指令
  const wrappedQuestion = `<system-reminder>This is a side question from the user. You must answer this question directly in a single response.

IMPORTANT CONTEXT:
- You are a separate, lightweight agent spawned to answer this one question
- The main agent is NOT interrupted - it continues working independently in the background
- You share the conversation context but are a completely separate instance
- Do NOT reference being interrupted or what you were "previously doing" - that framing is incorrect

CRITICAL CONSTRAINTS:
- You have NO tools available - you cannot read files, run commands, search, or take any actions
- This is a one-off response - there will be no follow-up turns
- You can ONLY provide information based on what you already know from the conversation context
- NEVER say things like "Let me try...", "I'll now...", "Let me check...", or promise to take any action
- If you don't know the answer, say so - do not offer to look it up or investigate

Simply answer the question with the information you have.</system-reminder>

${question}`

  const agentResult = await runForkedAgent({
    promptMessages: [createUserMessage({ content: wrappedQuestion })],
    // 不要覆盖 thinkingConfig — thinking 是 API 缓存键的一部分，
    // 与主线程配置不一致会导致 prompt 缓存失效。
    // 自适应 thinking 在快速问答场景下开销可忽略不计。
    cacheSafeParams,
    canUseTool: async () => ({
      behavior: 'deny' as const,
      message: 'Side questions cannot use tools',
      decisionReason: { type: 'other' as const, reason: 'side_question' },
    }),
    querySource: 'side_question' as any,
    forkLabel: 'side_question',
    maxTurns: 1, // 仅单轮 - 不进入工具调用循环
    // 没有后续请求会共享此后缀；跳过缓存写入。
    skipCacheWrite: true,
  })

  return {
    response: extractSideQuestionResponse(agentResult.messages),
    usage: agentResult.totalUsage,
  }
}

/**
 * 从 forked agent 消息中提取用于展示的字符串。
 *
 * 重要：zy.ts 对每个内容块生成一条 AssistantMessage，而非每个 API 响应一条。
 * 当自适应 thinking 启用时（从主线程继承以保持缓存键一致），thinking 响应结构为：
 *   messages[0] = assistant { content: [thinking_block] }
 *   messages[1] = assistant { content: [text_block] }
 *
 * 旧代码使用 `.find(m => m.type === 'assistant')` 获取第一条（仅含 thinking）消息，
 * 找不到 text block 就返回 null，导致 "No response received"。
 * 上下文较大的仓库（含大量 skills 或大型 CLAUDE.md）更频繁触发 thinking，
 * 这就是为什么该问题在 monorepo 中复现而在此处不复现。
 *
 * 其他导致 "No response received" 的失败模式：
 *   - 模型尝试 tool_use -> content = [thinking, tool_use]，无 text。
 *     虽罕见（system-reminder 通常可阻止），但此处做了处理。
 *   - API error 耗尽重试次数 -> query 产出 system api_error + user
 *     interruption，完全没有 assistant 消息。
 */
function extractSideQuestionResponse(messages: Message[]): string | null {
  // 展平所有按块拆分的 assistant 消息中的内容块。
  const assistantBlocks = messages.flatMap((m) =>
    m.type === 'assistant' ? m.message.content : [],
  )

  if (assistantBlocks.length > 0) {
    // 拼接所有 text block（通常最多一个，但为安全起见全部处理）。
    const text = extractTextContent(assistantBlocks, '\n\n').trim()
    if (text) return text

    // 无 text — 检查模型是否无视指令尝试调用了工具。
    const toolUse = assistantBlocks.find((b) => b.type === 'tool_call')
    if (toolUse) {
      const toolName = 'name' in toolUse ? toolUse.name : 'a tool'
      return `(The model tried to call ${toolName} instead of answering directly. Try rephrasing or ask in the main conversation.)`
    }
  }

  // 无 assistant 内容 — 可能是 API error 耗尽了重试次数。
  // 将第一条 system api_error 消息呈现给用户，以便了解发生了什么。
  const apiErr = messages.find(
    (m): m is SystemAPIErrorMessage =>
      m.type === 'system' && 'subtype' in m && m.subtype === 'api_error',
  )
  if (apiErr) {
    return `(API error: ${formatAPIError(apiErr.error)})`
  }

  return null
}
