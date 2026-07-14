import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { diffLines } from 'diff'
import { queryWithModel } from '../../services/api/compactQueries.js'
import { AGENT_TOOL_NAME, LEGACY_AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import type { LogOption } from '../../types/logs.js'
import { toError } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { extractTextContent } from '../../services/messages/./predicates.js'
import { getSessionIdFromLog } from '../../services/sessionStorage.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import { countCharInString } from '../../utils/stringUtils.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import {
  FACET_EXTRACTION_PROMPT,
  SessionFacets,
  SessionMeta,
  getAnalysisModel,
  getFacetsDir,
  getLanguageFromPath,
  getSessionMetaDir,
} from './remoteCollection.js'
import { isValidSessionFacets } from './exportData.js'
export function extractToolStats(log: LogOption): {
  toolCounts: Record<string, number>
  languages: Record<string, number>
  gitCommits: number
  gitPushes: number
  inputTokens: number
  outputTokens: number
  // New stats
  userInterruptions: number
  userResponseTimes: number[]
  toolErrors: number
  toolErrorCategories: Record<string, number>
  usesTaskAgent: boolean
  usesMcp: boolean
  usesWebSearch: boolean
  usesWebFetch: boolean
  // Additional stats
  linesAdded: number
  linesRemoved: number
  filesModified: Set<string>
  messageHours: number[]
  userMessageTimestamps: string[] // ISO timestamps for multi-clauding detection
} {
  const toolCounts: Record<string, number> = {}
  const languages: Record<string, number> = {}
  let gitCommits = 0
  let gitPushes = 0
  let inputTokens = 0
  let outputTokens = 0

  // New stats
  let userInterruptions = 0
  const userResponseTimes: number[] = []
  let toolErrors = 0
  const toolErrorCategories: Record<string, number> = {}
  let usesTaskAgent = false

  // Additional stats
  let linesAdded = 0
  let linesRemoved = 0
  const filesModified = new Set<string>()
  const messageHours: number[] = []
  const userMessageTimestamps: string[] = [] // For multi-clauding detection
  let usesMcp = false
  let usesWebSearch = false
  let usesWebFetch = false
  let lastAssistantTimestamp: string | null = null

  for (const msg of log.messages) {
    // Get message timestamp for response time calculation
    const msgTimestamp = (msg as { timestamp?: string }).timestamp

    if (msg.type === 'assistant' && msg.message) {
      // Track timestamp for response time calculation
      if (msgTimestamp) {
        lastAssistantTimestamp = msgTimestamp
      }

      const usage = (
        msg.message as {
          usage?: { inputTokens?: number; outputTokens?: number }
        }
      ).usage
      if (usage) {
        inputTokens += usage.inputTokens || 0
        outputTokens += usage.outputTokens || 0
      }

      const content = msg.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_call' && 'name' in block) {
            const toolName = block.name as string
            toolCounts[toolName] = (toolCounts[toolName] || 0) + 1

            // Check for special tool usage
            if (toolName === AGENT_TOOL_NAME || toolName === LEGACY_AGENT_TOOL_NAME) {
              usesTaskAgent = true
            }
            if (toolName.startsWith('mcp__')) {
              usesMcp = true
            }
            if (toolName === 'WebSearch') {
              usesWebSearch = true
            }
            if (toolName === 'WebFetch') {
              usesWebFetch = true
            }

            const input = (block as { input?: Record<string, unknown> }).input

            if (input) {
              const filePath = (input.file_path as string) || ''
              if (filePath) {
                const lang = getLanguageFromPath(filePath)
                if (lang) {
                  languages[lang] = (languages[lang] || 0) + 1
                }
                // Track files modified by Edit/Write tools
                if (toolName === 'Edit' || toolName === 'Write') {
                  filesModified.add(filePath)
                }
              }

              if (toolName === 'Edit') {
                const oldString = (input.old_string as string) || ''
                const newString = (input.new_string as string) || ''
                for (const change of diffLines(oldString, newString)) {
                  if (change.added) {
                    linesAdded += change.count || 0
                  }
                  if (change.removed) {
                    linesRemoved += change.count || 0
                  }
                }
              }

              // Track lines from Write tool (all added)
              if (toolName === 'Write') {
                const writeContent = (input.content as string) || ''
                if (writeContent) {
                  linesAdded += countCharInString(writeContent, '\n') + 1
                }
              }

              const command = (input.command as string) || ''
              if (command.includes('git commit')) {
                gitCommits++
              }
              if (command.includes('git push')) {
                gitPushes++
              }
            }
          }
        }
      }
    }

    // Check user messages
    if (msg.type === 'user' && msg.message) {
      const content = msg.message.content

      // Check if this is an actual human message (has text) vs just tool_result
      // matching Python reference logic
      let isHumanMessage = false
      for (const block of content) {
        if (block.type === 'text' && 'text' in block) {
          isHumanMessage = true
          break
        }
      }

      // Only track message hours and response times for actual human messages
      if (isHumanMessage) {
        // Track message hour for time-of-day analysis and timestamp for multi-clauding
        if (msgTimestamp) {
          try {
            const msgDate = new Date(msgTimestamp)
            const hour = msgDate.getHours() // Local hour 0-23
            messageHours.push(hour)
            // Collect timestamp for multi-clauding detection (matching Python)
            userMessageTimestamps.push(msgTimestamp)
          } catch {
            // Skip invalid timestamps
          }
        }

        // Calculate response time (time from last assistant message to this user message)
        // Only count gaps > 2 seconds (real user think time, not tool results)
        if (lastAssistantTimestamp && msgTimestamp) {
          const assistantTime = new Date(lastAssistantTimestamp).getTime()
          const userTime = new Date(msgTimestamp).getTime()
          const responseTimeSec = (userTime - assistantTime) / 1000
          // Only count reasonable response times (2s-1 hour) matching Python
          if (responseTimeSec > 2 && responseTimeSec < 3600) {
            userResponseTimes.push(responseTimeSec)
          }
        }
      }

      // Process tool results (for error tracking)
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result' && 'content' in block) {
            const isError = (block as { is_error?: boolean }).is_error

            // Count and categorize tool errors (matching Python reference logic)
            if (isError) {
              toolErrors++
              const resultContent = (block as { content?: string }).content
              let category = 'Other'
              if (typeof resultContent === 'string') {
                const lowerContent = resultContent.toLowerCase()
                if (lowerContent.includes('exit code')) {
                  category = 'Command Failed'
                } else if (
                  lowerContent.includes('rejected') ||
                  lowerContent.includes("doesn't want")
                ) {
                  category = 'User Rejected'
                } else if (
                  lowerContent.includes('string to replace not found') ||
                  lowerContent.includes('no changes')
                ) {
                  category = 'Edit Failed'
                } else if (lowerContent.includes('modified since read')) {
                  category = 'File Changed'
                } else if (
                  lowerContent.includes('exceeds maximum') ||
                  lowerContent.includes('too large')
                ) {
                  category = 'File Too Large'
                } else if (
                  lowerContent.includes('file not found') ||
                  lowerContent.includes('does not exist')
                ) {
                  category = 'File Not Found'
                }
              }
              toolErrorCategories[category] = (toolErrorCategories[category] || 0) + 1
            }
          }
        }
      }

      // Check for interruptions (matching Python reference)
      for (const block of content) {
        if (
          block.type === 'text' &&
          'text' in block &&
          (block.text as string).includes('[Request interrupted by user')
        ) {
          userInterruptions++
          break
        }
      }
    }
  }

  return {
    toolCounts,
    languages,
    gitCommits,
    gitPushes,
    inputTokens,
    outputTokens,
    // New stats
    userInterruptions,
    userResponseTimes,
    toolErrors,
    toolErrorCategories,
    usesTaskAgent,
    usesMcp,
    usesWebSearch,
    usesWebFetch,
    // Additional stats
    linesAdded,
    linesRemoved,
    filesModified,
    messageHours,
    userMessageTimestamps,
  }
}

export function hasValidDates(log: LogOption): boolean {
  return !Number.isNaN(log.created.getTime()) && !Number.isNaN(log.modified.getTime())
}

export function logToSessionMeta(log: LogOption): SessionMeta {
  const stats = extractToolStats(log)
  const sessionId = getSessionIdFromLog(log) || 'unknown'
  const startTime = log.created.toISOString()
  const durationMinutes = Math.round((log.modified.getTime() - log.created.getTime()) / 1000 / 60)

  let userMessageCount = 0
  let assistantMessageCount = 0
  for (const msg of log.messages) {
    if (msg.type === 'assistant') {
      assistantMessageCount++
    }
    // Only count user messages that have actual text content (human messages)
    // not just tool_result messages (matching Python reference)
    if (msg.type === 'user' && msg.message) {
      const content = msg.message.content
      let isHumanMessage = false
      for (const block of content) {
        if (block.type === 'text' && 'text' in block) {
          isHumanMessage = true
          break
        }
      }
      if (isHumanMessage) {
        userMessageCount++
      }
    }
  }

  return {
    session_id: sessionId,
    project_path: log.projectPath || '',
    start_time: startTime,
    duration_minutes: durationMinutes,
    user_message_count: userMessageCount,
    assistant_message_count: assistantMessageCount,
    tool_counts: stats.toolCounts,
    languages: stats.languages,
    git_commits: stats.gitCommits,
    git_pushes: stats.gitPushes,
    input_tokens: stats.inputTokens,
    output_tokens: stats.outputTokens,
    first_prompt: log.firstPrompt || '',
    summary: log.summary,
    // New stats
    user_interruptions: stats.userInterruptions,
    user_response_times: stats.userResponseTimes,
    tool_errors: stats.toolErrors,
    tool_error_categories: stats.toolErrorCategories,
    uses_task_agent: stats.usesTaskAgent,
    uses_mcp: stats.usesMcp,
    uses_web_search: stats.usesWebSearch,
    uses_web_fetch: stats.usesWebFetch,
    // Additional stats
    lines_added: stats.linesAdded,
    lines_removed: stats.linesRemoved,
    files_modified: stats.filesModified.size,
    message_hours: stats.messageHours,
    user_message_timestamps: stats.userMessageTimestamps,
  }
}

/**
 * Deduplicate conversation branches within the same session.
 *
 * When a session file has multiple leaf messages (from retries or branching),
 * loadAllLogsFromSessionFile produces one LogOption per leaf. Each branch
 * shares the same root message, so its duration overlaps with sibling
 * branches. This keeps only the branch with the most user messages
 * (tie-break by longest duration) per session_id.
 */
export function deduplicateSessionBranches(
  entries: Array<{ log: LogOption; meta: SessionMeta }>,
): Array<{ log: LogOption; meta: SessionMeta }> {
  const bestBySession = new Map<string, { log: LogOption; meta: SessionMeta }>()
  for (const entry of entries) {
    const id = entry.meta.session_id
    const existing = bestBySession.get(id)
    if (
      !existing ||
      entry.meta.user_message_count > existing.meta.user_message_count ||
      (entry.meta.user_message_count === existing.meta.user_message_count &&
        entry.meta.duration_minutes > existing.meta.duration_minutes)
    ) {
      bestBySession.set(id, entry)
    }
  }
  return [...bestBySession.values()]
}

export function formatTranscriptForFacets(log: LogOption): string {
  const lines: string[] = []
  const meta = logToSessionMeta(log)

  lines.push(`Session: ${meta.session_id.slice(0, 8)}`)
  lines.push(`Date: ${meta.start_time}`)
  lines.push(`Project: ${meta.project_path}`)
  lines.push(`Duration: ${meta.duration_minutes} min`)
  lines.push('')

  for (const msg of log.messages) {
    if (msg.type === 'user' && msg.message) {
      const content = msg.message.content
      for (const block of content) {
        if (block.type === 'text' && 'text' in block) {
          lines.push(`[User]: ${(block.text as string).slice(0, 500)}`)
        }
      }
    } else if (msg.type === 'assistant' && msg.message) {
      const content = msg.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && 'text' in block) {
            lines.push(`[Assistant]: ${(block.text as string).slice(0, 300)}`)
          } else if (block.type === 'tool_call' && 'name' in block) {
            lines.push(`[Tool: ${block.name}]`)
          }
        }
      }
    }
  }

  return lines.join('\n')
}

export const SUMMARIZE_CHUNK_PROMPT = `Summarize this portion of a ZY Code session transcript. Focus on:
1. What the user asked for
2. What Zy did (tools used, files modified)
3. Any friction or issues
4. The outcome

Keep it concise - 3-5 sentences. Preserve specific details like file names, error messages, and user feedback.

TRANSCRIPT CHUNK:
`

export async function summarizeTranscriptChunk(chunk: string): Promise<string> {
  try {
    const result = await queryWithModel({
      systemPrompt: asSystemPrompt([]),
      userPrompt: SUMMARIZE_CHUNK_PROMPT + chunk,
      signal: new AbortController().signal,
      options: {
        model: getAnalysisModel(),
        // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
        querySource: 'insights' as any,
        agents: [],
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        mcpTools: [],
        maxOutputTokensOverride: 500,
      },
    })

    const contentBlocks = Array.isArray(result.message.content) ? result.message.content : []
    const text = extractTextContent(contentBlocks)
    return text || chunk.slice(0, 2000)
  } catch {
    // On error, just return truncated chunk
    return chunk.slice(0, 2000)
  }
}

export async function formatTranscriptWithSummarization(log: LogOption): Promise<string> {
  const fullTranscript = formatTranscriptForFacets(log)

  // If under 30k chars, use as-is
  if (fullTranscript.length <= 30000) {
    return fullTranscript
  }

  // For long transcripts, split into chunks and summarize in parallel
  const CHUNK_SIZE = 25000
  const chunks: string[] = []

  for (let i = 0; i < fullTranscript.length; i += CHUNK_SIZE) {
    chunks.push(fullTranscript.slice(i, i + CHUNK_SIZE))
  }

  // Summarize all chunks in parallel
  const summaries = await Promise.all(chunks.map(summarizeTranscriptChunk))

  // Combine summaries with session header
  const meta = logToSessionMeta(log)
  const header = [
    `Session: ${meta.session_id.slice(0, 8)}`,
    `Date: ${meta.start_time}`,
    `Project: ${meta.project_path}`,
    `Duration: ${meta.duration_minutes} min`,
    `[Long session - ${chunks.length} parts summarized]`,
    '',
  ].join('\n')

  return header + summaries.join('\n\n---\n\n')
}

export async function loadCachedFacets(sessionId: string): Promise<SessionFacets | null> {
  const facetPath = join(getFacetsDir(), `${sessionId}.json`)
  try {
    const content = await readFile(facetPath, { encoding: 'utf-8' })
    const parsed: unknown = jsonParse(content)
    if (!isValidSessionFacets(parsed)) {
      // Delete corrupted cache file so it gets re-extracted next run
      try {
        await unlink(facetPath)
      } catch {
        // Ignore deletion errors
      }
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export async function saveFacets(facets: SessionFacets): Promise<void> {
  try {
    await mkdir(getFacetsDir(), { recursive: true })
  } catch {
    // Directory may already exist
  }
  const facetPath = join(getFacetsDir(), `${facets.session_id}.json`)
  await writeFile(facetPath, jsonStringify(facets, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  })
}

export async function loadCachedSessionMeta(sessionId: string): Promise<SessionMeta | null> {
  const metaPath = join(getSessionMetaDir(), `${sessionId}.json`)
  try {
    const content = await readFile(metaPath, { encoding: 'utf-8' })
    return jsonParse(content)
  } catch {
    return null
  }
}

export async function saveSessionMeta(meta: SessionMeta): Promise<void> {
  try {
    await mkdir(getSessionMetaDir(), { recursive: true })
  } catch {
    // Directory may already exist
  }
  const metaPath = join(getSessionMetaDir(), `${meta.session_id}.json`)
  await writeFile(metaPath, jsonStringify(meta, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  })
}

export async function extractFacetsFromAPI(
  log: LogOption,
  sessionId: string,
): Promise<SessionFacets | null> {
  try {
    // Use summarization for long transcripts
    const transcript = await formatTranscriptWithSummarization(log)

    // Build prompt asking for JSON directly (no tool use)
    const jsonPrompt = `${FACET_EXTRACTION_PROMPT}${transcript}

RESPOND WITH ONLY A VALID JSON OBJECT matching this schema:
{
  "underlying_goal": "What the user fundamentally wanted to achieve",
  "goal_categories": {"category_name": count, ...},
  "outcome": "fully_achieved|mostly_achieved|partially_achieved|not_achieved|unclear_from_transcript",
  "user_satisfaction_counts": {"level": count, ...},
  "zy_helpfulness": "unhelpful|slightly_helpful|moderately_helpful|very_helpful|essential",
  "session_type": "single_task|multi_task|iterative_refinement|exploration|quick_question",
  "friction_counts": {"friction_type": count, ...},
  "friction_detail": "One sentence describing friction or empty",
  "primary_success": "none|fast_accurate_search|correct_code_edits|good_explanations|proactive_help|multi_file_changes|good_debugging",
  "brief_summary": "One sentence: what user wanted and whether they got it"
}`

    const result = await queryWithModel({
      systemPrompt: asSystemPrompt([]),
      userPrompt: jsonPrompt,
      signal: new AbortController().signal,
      options: {
        model: getAnalysisModel(),
        // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
        querySource: 'insights' as any,
        agents: [],
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        mcpTools: [],
        maxOutputTokensOverride: 4096,
      },
    })

    const contentBlocks = Array.isArray(result.message.content) ? result.message.content : []
    const text = extractTextContent(contentBlocks)

    // Parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return null
    }

    const parsed: unknown = jsonParse(jsonMatch[0])
    if (!isValidSessionFacets(parsed)) {
      return null
    }
    const facets: SessionFacets = { ...parsed, session_id: sessionId }
    return facets
  } catch (err) {
    logError(new Error(`Facet extraction failed: ${toError(err).message}`))
    return null
  }
}

/**
 * Detects multi-clauding (using multiple Zy sessions concurrently).
 * Uses a sliding window to find the pattern: session1 -> session2 -> session1
 * within a 30-minute window.
 */
export function detectMultiClauding(
  sessions: Array<{
    session_id: string
    user_message_timestamps: string[]
  }>,
): {
  overlap_events: number
  sessions_involved: number
  user_messages_during: number
} {
  const OVERLAP_WINDOW_MS = 30 * 60000
  const allSessionMessages: Array<{ ts: number; sessionId: string }> = []

  for (const session of sessions) {
    for (const timestamp of session.user_message_timestamps) {
      try {
        const ts = new Date(timestamp).getTime()
        allSessionMessages.push({ ts, sessionId: session.session_id })
      } catch {
        // Skip invalid timestamps
      }
    }
  }

  allSessionMessages.sort((a, b) => a.ts - b.ts)

  const multiZySessionPairs = new Set<string>()
  const messagesDuringMultiZy = new Set<string>()

  // Sliding window: sessionLastIndex tracks the most recent index for each session
  let windowStart = 0
  const sessionLastIndex = new Map<string, number>()

  for (let i = 0; i < allSessionMessages.length; i++) {
    const msg = allSessionMessages[i]!

    // Shrink window from the left
    while (windowStart < i && msg.ts - allSessionMessages[windowStart]!.ts > OVERLAP_WINDOW_MS) {
      const expiring = allSessionMessages[windowStart]!
      if (sessionLastIndex.get(expiring.sessionId) === windowStart) {
        sessionLastIndex.delete(expiring.sessionId)
      }
      windowStart++
    }

    // Check if this session appeared earlier in the window (pattern: s1 -> s2 -> s1)
    const prevIndex = sessionLastIndex.get(msg.sessionId)
    if (prevIndex !== undefined) {
      for (let j = prevIndex + 1; j < i; j++) {
        const between = allSessionMessages[j]!
        if (between.sessionId !== msg.sessionId) {
          const pair = [msg.sessionId, between.sessionId].sort().join(':')
          multiZySessionPairs.add(pair)
          messagesDuringMultiZy.add(`${allSessionMessages[prevIndex]!.ts}:${msg.sessionId}`)
          messagesDuringMultiZy.add(`${between.ts}:${between.sessionId}`)
          messagesDuringMultiZy.add(`${msg.ts}:${msg.sessionId}`)
          break
        }
      }
    }

    sessionLastIndex.set(msg.sessionId, i)
  }

  const sessionsWithOverlaps = new Set<string>()
  for (const pair of multiZySessionPairs) {
    const [s1, s2] = pair.split(':')
    if (s1) {
      sessionsWithOverlaps.add(s1)
    }
    if (s2) {
      sessionsWithOverlaps.add(s2)
    }
  }

  return {
    overlap_events: multiZySessionPairs.size,
    sessions_involved: sessionsWithOverlaps.size,
    user_messages_during: messagesDuringMultiZy.size,
  }
}
