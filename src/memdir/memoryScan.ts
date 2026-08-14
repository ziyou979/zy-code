/**
 * memory 目录扫描原语。从 findRelevantMemories.ts 中拆出，
 * 使 extractMemories 可导入扫描逻辑，而不引入 sideQuery 和 API client 链；
 * 后者会通过 memdir.ts 形成循环依赖（#25372）。
 */

import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseFrontmatter } from '../services/markdown/frontmatterParser.js'
import { readFileInRange } from '../services/file-persistence/readFileInRange.js'
import { type MemoryType, parseMemoryType } from './memoryTypes.js'

export type MemoryHeader = {
  filename: string
  filePath: string
  mtimeMs: number
  description: string | null
  type: MemoryType | undefined
}

const MAX_MEMORY_FILES = 200
const FRONTMATTER_MAX_LINES = 30

/**
 * 扫描 memory 目录中的 .md 文件，读取 frontmatter，并按从新到旧返回 header 列表
 *（最多 MAX_MEMORY_FILES 项）。findRelevantMemories（query 时召回）和 extractMemories 共用此逻辑；
 * 后者会预先注入该列表，避免提取 agent 浪费一个 turn 执行 `ls`。
 *
 * 单遍扫描：readFileInRange 会在内部 stat 并返回 mtimeMs，因此先读取再排序，
 * 而非 stat—排序—读取。常见场景（N ≤ 200）下，这比单独一轮 stat 减少一半 syscall；
 * N 较大时会多读取少量小文件，但仍避免对最终保留的 200 个文件重复 stat。
 */
export async function scanMemoryFiles(
  memoryDir: string,
  signal: AbortSignal,
): Promise<MemoryHeader[]> {
  try {
    const entries = await readdir(memoryDir, { recursive: true })
    const mdFiles = entries.filter((f) => f.endsWith('.md') && basename(f) !== 'MEMORY.md')

    const headerResults = await Promise.allSettled(
      mdFiles.map(async (relativePath): Promise<MemoryHeader> => {
        const filePath = join(memoryDir, relativePath)
        const { content, mtimeMs } = await readFileInRange(
          filePath,
          0,
          FRONTMATTER_MAX_LINES,
          undefined,
          signal,
        )
        const { frontmatter } = parseFrontmatter(content, filePath)
        return {
          filename: relativePath,
          filePath,
          mtimeMs,
          description: frontmatter.description || null,
          type: parseMemoryType(frontmatter.metadata?.type),
        }
      }),
    )

    return headerResults
      .filter((r): r is PromiseFulfilledResult<MemoryHeader> => r.status === 'fulfilled')
      .map((r) => r.value)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_MEMORY_FILES)
  } catch {
    return []
  }
}

/**
 * 将 memory header 格式化为文本清单：每个文件一行，格式为
 * [type] filename (timestamp): description。召回 selector prompt 和提取 agent prompt 共用。
 */
export function formatMemoryManifest(memories: MemoryHeader[]): string {
  return memories
    .map((m) => {
      const tag = m.type ? `[${m.type}] ` : ''
      const ts = new Date(m.mtimeMs).toISOString()
      return m.description
        ? `- ${tag}${m.filename} (${ts}): ${m.description}`
        : `- ${tag}${m.filename} (${ts})`
    })
    .join('\n')
}
