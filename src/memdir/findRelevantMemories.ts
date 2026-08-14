import { feature } from 'bun:bundle'
import { getDefaultStandardModel } from '../services/model/model.js'
import { logForDebugging } from '../services/infra/debug.js'
import { errorMessage } from '../utils/errors.js'
import { sideQuery } from '../services/query/sideQuery.js'
import { jsonParse } from '../services/infra/slowOperations.js'
import { formatMemoryManifest, type MemoryHeader, scanMemoryFiles } from './memoryScan.js'

export type RelevantMemory = {
  path: string
  mtimeMs: number
}

const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to ZY Code as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a list of filenames for the memories that will clearly be useful to ZY Code as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- If a list of recently-used tools is provided, do not select memories that are usage reference or API documentation for those tools (ZY Code is already exercising them). DO still select memories containing warnings, gotchas, or known issues about those tools — active use is exactly when those matter.
`

/**
 * 扫描 memory 文件头，并请 Sonnet 选出与 query 最相关的 memory 文件。
 *
 * 返回最相关 memory 的绝对路径和 mtime（最多 5 个）。排除已加载到 system prompt 的 MEMORY.md。
 * mtime 会一路透传，使调用方无需再次 stat 即可向主 model 展示新鲜度。
 *
 * 调用 Sonnet 前，`alreadySurfaced` 会过滤之前 turn 已展示的路径，
 * 使 selector 将 5 个名额用于新候选，而非重复挑选最终会被调用方丢弃的文件。
 */
export async function findRelevantMemories(
  query: string,
  memoryDir: string,
  signal: AbortSignal,
  recentTools: readonly string[] = [],
  alreadySurfaced: ReadonlySet<string> = new Set(),
): Promise<RelevantMemory[]> {
  const memories = (await scanMemoryFiles(memoryDir, signal)).filter(
    (m) => !alreadySurfaced.has(m.filePath),
  )
  if (memories.length === 0) {
    return []
  }

  const selectedFilenames = await selectRelevantMemories(query, memories, signal, recentTools)
  const byFilename = new Map(memories.map((m) => [m.filename, m]))
  const selected = selectedFilenames
    .map((filename) => byFilename.get(filename))
    .filter((m): m is MemoryHeader => m !== undefined)

  // 即使选择为空也会上报：selection-rate 需要分母，
  // 而 age 为 -1 可区分“已运行但未选中”与“从未运行”。
  if (feature('MEMORY_SHAPE_TELEMETRY')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { logMemoryRecallShape } = require('./memoryShapeTelemetry.js') as unknown as {
      logMemoryRecallShape: (all: MemoryHeader[], selected: MemoryHeader[]) => void
    }
    /* eslint-enable @typescript-eslint/no-require-imports */
    logMemoryRecallShape(memories, selected)
  }

  return selected.map((m) => ({ path: m.filePath, mtimeMs: m.mtimeMs }))
}

async function selectRelevantMemories(
  query: string,
  memories: MemoryHeader[],
  signal: AbortSignal,
  recentTools: readonly string[],
): Promise<string[]> {
  const validFilenames = new Set(memories.map((m) => m.filename))

  const manifest = formatMemoryManifest(memories)

  // ZY Code 正在使用 Tool（如 mcp__X__spawn）时，展示该 Tool 的参考文档只会造成干扰，
  // 因为对话中已包含可用的用法。否则 selector 会因关键词重叠而误匹配
  //（query 中的 "spawn" + memory 描述中的 "spawn" → 假阳性）。
  const toolsSection =
    recentTools.length > 0 ? `\n\nRecently used tools: ${recentTools.join(', ')}` : ''

  try {
    const result = await sideQuery({
      model: getDefaultStandardModel()!,
      system: SELECT_MEMORIES_SYSTEM_PROMPT,
      skipSystemPromptPrefix: true,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text' as const,
              text: `Query: ${query}\n\nAvailable memories:\n${manifest}${toolsSection}`,
            },
          ],
        },
      ],
      max_tokens: 256,
      outputFormat: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            selected_memories: { type: 'array', items: { type: 'string' } },
          },
          required: ['selected_memories'],
          additionalProperties: false,
        },
      },
      signal,
      querySource: 'memdir_relevance' as const,
    })

    const textBlock = result.content.find((block) => block.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      return []
    }

    const parsed: { selected_memories: string[] } = jsonParse(textBlock.text)
    return parsed.selected_memories.filter((f) => validFilenames.has(f))
  } catch (e) {
    if (signal.aborted) {
      return []
    }
    logForDebugging(`[memdir] selectRelevantMemories failed: ${errorMessage(e)}`, { level: 'warn' })
    return []
  }
}
