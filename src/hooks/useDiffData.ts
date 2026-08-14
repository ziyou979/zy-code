import type { StructuredPatchHunk } from 'diff'
import { useEffect, useMemo, useState } from 'react'
import {
  fetchGitDiff,
  fetchGitDiffHunks,
  type GitDiffResult,
  type GitDiffStats,
} from '../services/git/gitDiff.js'

const MAX_LINES_PER_FILE = 400

export type DiffFile = {
  path: string
  linesAdded: number
  linesRemoved: number
  isBinary: boolean
  isLargeFile: boolean
  isTruncated: boolean
  isNewFile?: boolean
  isUntracked?: boolean
}

export type DiffData = {
  stats: GitDiffStats | null
  files: DiffFile[]
  hunks: Map<string, StructuredPatchHunk[]>
  loading: boolean
}

/**
 * 按需获取当前 git diff 数据的 hook。
 * 组件挂载时同时获取统计信息和 diff 块。
 */
export function useDiffData(): DiffData {
  const [diffResult, setDiffResult] = useState<GitDiffResult | null>(null)
  const [hunks, setHunks] = useState<Map<string, StructuredPatchHunk[]>>(new Map())
  const [loading, setLoading] = useState(true)

  // 挂载时获取 diff 数据
  useEffect(() => {
    let cancelled = false

    async function loadDiffData() {
      try {
        // 同时获取统计信息和 diff 块
        const [statsResult, hunksResult] = await Promise.all([fetchGitDiff(), fetchGitDiffHunks()])

        if (!cancelled) {
          setDiffResult(statsResult)
          setHunks(hunksResult)
          setLoading(false)
        }
      } catch (_error) {
        if (!cancelled) {
          setDiffResult(null)
          setHunks(new Map())
          setLoading(false)
        }
      }
    }

    void loadDiffData()

    return () => {
      cancelled = true
    }
  }, [])

  return useMemo(() => {
    if (!diffResult) {
      return { stats: null, files: [], hunks: new Map(), loading }
    }

    const { stats, perFileStats } = diffResult
    const files: DiffFile[] = []

    // 遍历 perFileStats，纳入大文件和被跳过文件在内的全部文件
    for (const [path, fileStats] of perFileStats) {
      const fileHunks = hunks.get(path)
      const isUntracked = fileStats.isUntracked ?? false

      // 识别大文件：存在于 perFileStats，但不在 hunks 中，且不是二进制或未跟踪文件
      const isLargeFile = !fileStats.isBinary && !isUntracked && !fileHunks

      // 识别被截断的文件（总量超过限制即表示发生了截断）
      const totalLines = fileStats.added + fileStats.removed
      const isTruncated = !isLargeFile && !fileStats.isBinary && totalLines > MAX_LINES_PER_FILE

      files.push({
        path,
        linesAdded: fileStats.added,
        linesRemoved: fileStats.removed,
        isBinary: fileStats.isBinary,
        isLargeFile,
        isTruncated,
        isUntracked,
      })
    }

    files.sort((a, b) => a.path.localeCompare(b.path))

    return { stats, files, hunks, loading: false }
  }, [diffResult, hunks, loading])
}
