import { getDefaultCompactModel } from './model/model.js'
import { getEmptyToolPermissionContext } from '../tools/tool.js'
import { isAbortError } from '../types/llm.js'
import type { Message } from '../types/message.js'
import { logForDebugging } from '../utils/debug.js'
import { createUserMessage } from './messages/constructors.js'
import { getAssistantMessageText } from './messages/predicates.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'
import { queryModelWithoutStreaming } from './api/llmOrchestrator.js'
import { getSessionMemoryContent } from './session-memory/sessionMemoryUtils.js'

// Recap only needs recent context — truncate to avoid "prompt too long" on
// large sessions. 30 messages ≈ ~15 exchanges, plenty for "where we left off."
const RECENT_MESSAGE_WINDOW = 30

function buildAwaySummaryPrompt(memory: string | null): string {
  const memoryBlock = memory ? `Session memory (broader context):\n${memory}\n\n` : ''
  return `${memoryBlock}The user stepped away and is coming back. Write exactly 1-3 short sentences. Start by stating the high-level task — what they are building or debugging, not implementation details. Next: the concrete next step. Skip status reports and commit recaps.`
}

/**
 * Generates a short session recap for the "while you were away" card.
 * Returns null on abort, empty transcript, or error.
 */
export async function generateAwaySummary(
  messages: readonly Message[],
  signal: AbortSignal,
): Promise<string | null> {
  if (messages.length === 0) {
    return null
  }

  try {
    const memory = await getSessionMemoryContent()
    const recent = messages.slice(-RECENT_MESSAGE_WINDOW)
    recent.push(
      createUserMessage({
        content: [{ type: 'text' as const, text: buildAwaySummaryPrompt(memory) }],
      }),
    )
    const response = await queryModelWithoutStreaming({
      messages: recent,
      systemPrompt: asSystemPrompt([]),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal,
      options: {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        model: getDefaultCompactModel() ?? '',
        toolChoice: undefined,
        isNonInteractiveSession: false,
        hasAppendSystemPrompt: false,
        agents: [],
        querySource: 'away_summary',
        mcpTools: [],
        skipCacheWrite: true,
      },
    })

    if (response.isApiErrorMessage) {
      logForDebugging(`[awaySummary] API error: ${getAssistantMessageText(response)}`)
      return null
    }
    return getAssistantMessageText(response)
  } catch (err) {
    if (isAbortError(err) || signal.aborted) {
      return null
    }
    logForDebugging(`[awaySummary] generation failed: ${err}`)
    return null
  }
}
