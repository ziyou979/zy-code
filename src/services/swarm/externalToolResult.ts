/**
 * 工具结果外置存储模块
 *
 * 将大型工具结果写入磁盘，内存只保留预览和定位引用。
 * 用于 in-process runner 中减少单 agent 内存占用。
 *
 * 不属于 src/utils/ 因为它涉及磁盘 I/O 和领域特定策略。
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { StoredToolResultReference } from '../../tasks/in-process-teammate-task/types.js'
import { TOOL_RESULT_EXTERNAL_THRESHOLD_BYTES } from '../../tasks/in-process-teammate-task/types.js'
import type { ContentBlock } from '../../types/llm.js'
import { logForDebugging } from '../../utils/debug.js'
import { getZyConfigHomeDir } from '../../utils/envUtils.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'

/**
 * 获取工具结果存储目录。
 * 每个 agent 使用独立的子目录。
 */
function getExternalResultsDir(taskId: string): string {
  return join(getZyConfigHomeDir(), 'external-tool-results', taskId)
}

/**
 * 存储工具结果到磁盘，返回引用。
 * 如果结果大小低于阈值，返回 null（不存储）。
 */
export async function storeToolResultExternally(
  taskId: string,
  toolCallId: string,
  content: ContentBlock[],
): Promise<StoredToolResultReference | null> {
  const serialized = jsonStringify(content)
  const byteLength = new TextEncoder().encode(serialized).length

  if (byteLength < TOOL_RESULT_EXTERNAL_THRESHOLD_BYTES) {
    return null
  }

  const dir = getExternalResultsDir(taskId)
  await mkdir(dir, { recursive: true })

  const fileName = `${toolCallId}.json`
  const filePath = join(dir, fileName)

  try {
    await writeFile(filePath, serialized)

    // 提取纯文本预览（最多 500 字符）
    const previewText = extractPreview(content, 500)

    logForDebugging(
      `[externalToolResult] Stored ${byteLength} bytes for ${toolCallId} at ${filePath}`,
    )

    return {
      type: 'stored_tool_result',
      toolCallId,
      path: filePath,
      byteLength,
      preview: previewText,
    }
  } catch (err) {
    logForDebugging(`[externalToolResult] Failed to store ${toolCallId}: ${err}`)
    return null
  }
}

/**
 * 从磁盘加载外置的工具结果。
 */
export async function loadExternalToolResult(
  ref: StoredToolResultReference,
): Promise<ContentBlock[] | null> {
  try {
    const raw = await readFile(ref.path, 'utf-8')
    const parsed = jsonParse(raw)
    if (!Array.isArray(parsed)) {
      return null
    }
    return parsed as ContentBlock[]
  } catch (err) {
    logForDebugging(`[externalToolResult] Failed to load ${ref.toolCallId}: ${err}`)
    return null
  }
}

/**
 * 清除指定 task 的所有外置工具结果。
 */
export async function clearExternalToolResults(taskId: string): Promise<void> {
  const dir = getExternalResultsDir(taskId)
  try {
    // 先清空目录内容
    const { readdir } = await import('node:fs/promises')
    const files = await readdir(dir)
    await Promise.all(files.map((f) => unlink(join(dir, f))))
    await unlink(dir)
    logForDebugging(`[externalToolResult] Cleared all results for ${taskId}`)
  } catch (err) {
    // 目录不存在或已清理
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logForDebugging(`[externalToolResult] Failed to clear ${taskId}: ${err}`)
    }
  }
}

/**
 * 从 content blocks 中提取纯文本预览。
 */
function extractPreview(content: ContentBlock[], maxLen: number): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') {
      parts.push(block.text)
    } else if (block.type === 'tool_result') {
      if (typeof block.content === 'string') {
        parts.push(block.content)
      } else if (Array.isArray(block.content)) {
        for (const item of block.content) {
          if (typeof item === 'object' && 'text' in item) {
            parts.push((item as { text: string }).text)
          }
        }
      }
    }
  }
  const joined = parts.join('\n')
  if (joined.length <= maxLen) {
    return joined
  }
  return joined.slice(0, maxLen) + '...'
}
