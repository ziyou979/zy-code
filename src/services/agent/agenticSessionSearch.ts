import { getDefaultCompactModel } from 'src/services/model/model.js'
import type { LogOption, SerializedMessage } from '../../types/logs.js'
import { count } from '../../utils/array.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { getLogDisplayTitle, logError } from '../../services/infra/log.js'
import { isLiteLog, loadFullLog } from '../sessionStorage.js'
import { sideQuery } from '../../services/query/sideQuery.js'
import { jsonParse } from '../../services/infra/slowOperations.js'

// 会话记录提取的限制
const MAX_TRANSCRIPT_CHARS = 2000 // Max chars of transcript per session
const MAX_MESSAGES_TO_SCAN = 100 // Max messages to scan from start/end
const MAX_SESSIONS_TO_SEARCH = 100 // Max sessions to send to the API

const SESSION_SEARCH_SYSTEM_PROMPT = `你的目标是根据用户的搜索查询找到相关的会话。

你将获得一个带有元数据的会话列表和一个搜索查询。请识别哪些会话与查询最相关。

每个会话可能包含：
- 标题（显示名称或自定义标题）
- 标签（用户分配的类别，显示为 [tag: name] - 用户使用 /tag 命令标记会话以进行分类）
- 分支（git 分支名，显示为 [branch: name]）
- 摘要（AI 生成的摘要）
- 首条消息（对话的开头）
- 会话记录（对话内容片段）

重要：标签是用户分配的标签，指示会话的主题或类别。如果查询与标签完全或部分匹配，这些会话应被高度优先考虑。

对于每个会话，按以下优先级考虑（按重要性排序）：
1. 精确标签匹配（最高优先级 - 用户显式分类了此会话）
2. 部分标签匹配或标签相关术语
3. 标题匹配（自定义标题或首条消息内容）
4. 分支名匹配
5. 摘要和会话记录内容匹配
6. 语义相似性和相关概念

关键：匹配时要非常包容。包含以下情况的会话：
- 在任何字段的任何位置包含查询词
- 与查询在语义上相关（如 "testing" 匹配 "tests"、"unit tests"、"QA" 等会话）
- 讨论可能与查询相关的主题
- 会话记录中哪怕路过提及了该概念

拿不准时，包含该会话。返回过多结果总比返回过少好。用户可以轻松浏览结果，但遗漏相关会话会让人沮丧。

按相关性排序返回会话（最相关的在前）。如果确实没有任何会话与查询有任何关联，返回空数组 - 但这应该很少见。

仅返回 JSON 对象，不要 markdown 格式：
{"relevant_indices": [2, 5, 0]}`

type AgenticSearchResult = {
  relevant_indices: number[]
}

/**
 * 从消息中提取可搜索的文本内容。
 */
function extractMessageText(message: SerializedMessage): string {
  if (message.type !== 'user' && message.type !== 'assistant') {
    return ''
  }

  const content = 'message' in message ? message.message?.content : undefined
  if (!content) {
    return ''
  }

  return content
    .map((block) => {
      if ('text' in block && typeof block.text === 'string') {
        return block.text
      }
      return ''
    })
    .filter(Boolean)
    .join(' ')
}

/**
 * 从会话消息中提取截断的会话记录。
 */
function extractTranscript(messages: SerializedMessage[]): string {
  if (messages.length === 0) {
    return ''
  }

  // Take messages from start and end to get context
  const messagesToScan =
    messages.length <= MAX_MESSAGES_TO_SCAN
      ? messages
      : [
          ...messages.slice(0, MAX_MESSAGES_TO_SCAN / 2),
          ...messages.slice(-MAX_MESSAGES_TO_SCAN / 2),
        ]

  const text = messagesToScan
    .map(extractMessageText)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

  return text.length > MAX_TRANSCRIPT_CHARS ? `${text.slice(0, MAX_TRANSCRIPT_CHARS)}…` : text
}

/**
 * 检查日志是否在任何可搜索字段中包含查询词。
 */
function logContainsQuery(log: LogOption, queryLower: string): boolean {
  // Check title
  const title = getLogDisplayTitle(log).toLowerCase()
  if (title.includes(queryLower)) {
    return true
  }

  // Check custom title
  if (log.customTitle?.toLowerCase().includes(queryLower)) {
    return true
  }

  // Check tag
  if (log.tag?.toLowerCase().includes(queryLower)) {
    return true
  }

  // Check branch
  if (log.gitBranch?.toLowerCase().includes(queryLower)) {
    return true
  }

  // Check summary
  if (log.summary?.toLowerCase().includes(queryLower)) {
    return true
  }

  // Check first prompt
  if (log.firstPrompt?.toLowerCase().includes(queryLower)) {
    return true
  }

  // Check transcript (more expensive, do last)
  if (log.messages && log.messages.length > 0) {
    const transcript = extractTranscript(log.messages).toLowerCase()
    if (transcript.includes(queryLower)) {
      return true
    }
  }

  return false
}

/**
 * 使用 Zy 基于查询的语义理解执行 Agentic 搜索，
 * 找到相关会话。
 */
export async function agenticSessionSearch(
  query: string,
  logs: LogOption[],
  signal?: AbortSignal,
): Promise<LogOption[]> {
  if (!query.trim() || logs.length === 0) {
    return []
  }

  const queryLower = query.toLowerCase()

  // 预过滤：找到包含查询词的会话
  // 这确保我们搜索相关会话，而不仅是最近的
  const matchingLogs = logs.filter((log) => logContainsQuery(log, queryLower))

  // Take up to MAX_SESSIONS_TO_SEARCH matching logs
  // If fewer matches, fill remaining slots with recent non-matching logs for context
  let logsToSearch: LogOption[]
  if (matchingLogs.length >= MAX_SESSIONS_TO_SEARCH) {
    logsToSearch = matchingLogs.slice(0, MAX_SESSIONS_TO_SEARCH)
  } else {
    const nonMatchingLogs = logs.filter((log) => !logContainsQuery(log, queryLower))
    const remainingSlots = MAX_SESSIONS_TO_SEARCH - matchingLogs.length
    logsToSearch = [...matchingLogs, ...nonMatchingLogs.slice(0, remainingSlots)]
  }

  // 调试：记录我们拥有的数据
  logForDebugging(
    `Agentic search: ${logsToSearch.length}/${logs.length} logs, query="${query}", ` +
      `matching: ${matchingLogs.length}, with messages: ${count(logsToSearch, (l) => l.messages?.length > 0)}`,
  )

  // 为 lite 日志加载完整日志以获取会话记录内容
  const logsWithTranscriptsPromises = logsToSearch.map(async (log) => {
    if (isLiteLog(log)) {
      try {
        return await loadFullLog(log)
      } catch (error) {
        logError(error as Error)
        // 加载失败则使用 lite 日志（无会话记录）
        return log
      }
    }
    return log
  })
  const logsWithTranscripts = await Promise.all(logsWithTranscriptsPromises)

  logForDebugging(
    `Agentic search: loaded ${count(logsWithTranscripts, (l) => l.messages?.length > 0)}/${logsToSearch.length} logs with transcripts`,
  )

  // 为提示词构建包含所有可搜索元数据的会话列表
  const sessionList = logsWithTranscripts
    .map((log, index) => {
      const parts: string[] = [`${index}:`]

      // 标题（显示标题，可能是自定义或来自首个提示词）
      const displayTitle = getLogDisplayTitle(log)
      parts.push(displayTitle)

      // 与显示标题不同的自定义标题
      if (log.customTitle && log.customTitle !== displayTitle) {
        parts.push(`[custom title: ${log.customTitle}]`)
      }

      // 标签
      if (log.tag) {
        parts.push(`[tag: ${log.tag}]`)
      }

      // Git 分支
      if (log.gitBranch) {
        parts.push(`[branch: ${log.gitBranch}]`)
      }

      // 摘要
      if (log.summary) {
        parts.push(`- Summary: ${log.summary}`)
      }

      // 首个提示词内容（截断）
      if (log.firstPrompt && log.firstPrompt !== 'No prompt') {
        parts.push(`- First message: ${log.firstPrompt.slice(0, 300)}`)
      }

      // 会话记录片段（若消息可用）
      if (log.messages && log.messages.length > 0) {
        const transcript = extractTranscript(log.messages)
        if (transcript) {
          parts.push(`- Transcript: ${transcript}`)
        }
      }

      return parts.join(' ')
    })
    .join('\n')

  const userMessage = `会话列表:
${sessionList}

搜索查询: "${query}"

找出与此查询最相关的会话。`

  // 调试：记录会话列表的前半部分
  logForDebugging(`Agentic search prompt (first 500 chars): ${userMessage.slice(0, 500)}...`)

  try {
    const model = getDefaultCompactModel()!
    logForDebugging(`Agentic search using model: ${model}`)

    const response = await sideQuery({
      model,
      system: SESSION_SEARCH_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text' as const, text: userMessage }] }],
      signal,
      querySource: 'session_search',
    })

    // 从响应中提取文本内容
    const textContent = response.content.find((block) => block.type === 'text')
    if (!textContent || textContent.type !== 'text') {
      logForDebugging('No text content in agentic search response')
      return []
    }

    // 调试：记录响应
    logForDebugging(`Agentic search response: ${textContent.text}`)

    // 解析 JSON 响应
    const jsonMatch = textContent.text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      logForDebugging('Could not find JSON in agentic search response')
      return []
    }

    const result: AgenticSearchResult = jsonParse(jsonMatch[0])
    const relevantIndices = result.relevant_indices || []

    // 将索引映射回日志（索引相对于 logsWithTranscripts）
    const relevantLogs = relevantIndices
      .filter((index) => index >= 0 && index < logsWithTranscripts.length)
      .map((index) => logsWithTranscripts[index]!)

    logForDebugging(`Agentic search found ${relevantLogs.length} relevant sessions`)

    return relevantLogs
  } catch (error) {
    logError(error as Error)
    logForDebugging(`Agentic search error: ${error}`)
    return []
  }
}
