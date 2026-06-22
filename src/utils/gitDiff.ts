import { access, readFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type { StructuredPatchHunk } from 'diff'
import { getCwd } from './cwd.js'
import { getCachedRepository } from './detectRepository.js'
import { execFileNoThrow, execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { isFileWithinReadSizeLimit } from './file.js'
import { findGitRoot, getDefaultBranch, getGitDir, getIsGit, gitExe } from './git.js'

export type GitDiffStats = {
  filesCount: number
  linesAdded: number
  linesRemoved: number
}

export type PerFileStats = {
  added: number
  removed: number
  isBinary: boolean
  isUntracked?: boolean
}

export type GitDiffResult = {
  stats: GitDiffStats
  perFileStats: Map<string, PerFileStats>
  hunks: Map<string, StructuredPatchHunk[]>
}

const GIT_TIMEOUT_MS = 5000
const MAX_FILES = 50
const MAX_DIFF_SIZE_BYTES = 1_000_000 // 1 MB - 跳过大于此值的文件
const MAX_LINES_PER_FILE = 400 // GitHub 自动加载的行数限制
const MAX_FILES_FOR_DETAILS = 500 // 文件数超过此值时跳过逐文件详情

/**
 * 获取 git diff 统计信息和 hunk，比较工作树与 HEAD。
 * 不在 git 仓库中或 git 命令失败时返回 null。
 *
 * 在 merge/rebase/cherry-pick/revert 操作期间返回 null，因为工作树
 * 包含的是非用户主动操作的传入变更。
 */
export async function fetchGitDiff(): Promise<GitDiffResult | null> {
  const isGit = await getIsGit()
  if (!isGit) {
    return null
  }

  // 在临时 git 状态期间跳过 diff 计算，因为工作树包含的是
  // 传入的变更，而非用户有意的编辑
  if (await isInTransientGitState()) {
    return null
  }

  // 快速探测：使用 --shortstat 获取总计而不加载所有内容。
  // 这是 O(1) 内存，让我们在执行昂贵操作前检测到大量 diff（如 jj 工作区）。
  const { stdout: shortstatOut, code: shortstatCode } = await execFileNoThrow(
    gitExe(),
    ['--no-optional-locks', 'diff', 'HEAD', '--shortstat'],
    { timeout: GIT_TIMEOUT_MS, preserveOutputOnError: false },
  )

  if (shortstatCode === 0) {
    const quickStats = parseShortstat(shortstatOut)
    if (quickStats && quickStats.filesCount > MAX_FILES_FOR_DETAILS) {
      // 文件过多——返回准确的总计但跳过逐文件详情，
      // 以避免将数百 MB 加载到内存中
      return {
        stats: quickStats,
        perFileStats: new Map(),
        hunks: new Map(),
      }
    }
  }

  // 通过 --numstat 获取统计信息（所有未提交的变更 vs HEAD）
  const { stdout: numstatOut, code: numstatCode } = await execFileNoThrow(
    gitExe(),
    ['--no-optional-locks', 'diff', 'HEAD', '--numstat'],
    { timeout: GIT_TIMEOUT_MS, preserveOutputOnError: false },
  )

  if (numstatCode !== 0) {
    return null
  }

  const { stats, perFileStats } = parseGitNumstat(numstatOut)

  // 包含未跟踪文件（尚未暂存的新文件）
  // 仅获取文件名——为了性能不读取内容
  const remainingSlots = MAX_FILES - perFileStats.size
  if (remainingSlots > 0) {
    const untrackedStats = await fetchUntrackedFiles(remainingSlots)
    if (untrackedStats) {
      stats.filesCount += untrackedStats.size
      for (const [path, fileStats] of untrackedStats) {
        perFileStats.set(path, fileStats)
      }
    }
  }

  // 仅返回统计信息——hunk 通过 fetchGitDiffHunks() 按需获取，
  // 以避免每次轮询时执行昂贵的 git diff HEAD 调用
  return { stats, perFileStats, hunks: new Map() }
}

/**
 * 按需获取 git diff hunk（用于 DiffDialog）。
 * 与 fetchGitDiff() 分离以避免轮询期间的昂贵调用。
 */
export async function fetchGitDiffHunks(): Promise<Map<string, StructuredPatchHunk[]>> {
  const isGit = await getIsGit()
  if (!isGit) {
    return new Map()
  }

  if (await isInTransientGitState()) {
    return new Map()
  }

  const { stdout: diffOut, code: diffCode } = await execFileNoThrow(
    gitExe(),
    ['--no-optional-locks', 'diff', 'HEAD'],
    { timeout: GIT_TIMEOUT_MS, preserveOutputOnError: false },
  )

  if (diffCode !== 0) {
    return new Map()
  }

  return parseGitDiff(diffOut)
}

export type NumstatResult = {
  stats: GitDiffStats
  perFileStats: Map<string, PerFileStats>
}

/**
 * 解析 git diff --numstat 输出为统计信息。
 * 格式：<added>\t<removed>\t<filename>
 * 二进制文件的计数显示为 '-'。
 * 仅在 perFileStats 中存储前 MAX_FILES 条。
 */
export function parseGitNumstat(stdout: string): NumstatResult {
  const lines = stdout.trim().split('\n').filter(Boolean)
  let added = 0
  let removed = 0
  let validFileCount = 0
  const perFileStats = new Map<string, PerFileStats>()

  for (const line of lines) {
    const parts = line.split('\t')
    // 有效的 numstat 行恰好有 3 个 tab 分隔的部分：added、removed、filename
    if (parts.length < 3) {
      continue
    }

    validFileCount++
    const addStr = parts[0]
    const remStr = parts[1]
    const filePath = parts.slice(2).join('\t') // 文件名可能包含 tab
    const isBinary = addStr === '-' || remStr === '-'
    const fileAdded = isBinary ? 0 : parseInt(addStr ?? '0', 10) || 0
    const fileRemoved = isBinary ? 0 : parseInt(remStr ?? '0', 10) || 0

    added += fileAdded
    removed += fileRemoved

    // 仅存储前 MAX_FILES 条
    if (perFileStats.size < MAX_FILES) {
      perFileStats.set(filePath, {
        added: fileAdded,
        removed: fileRemoved,
        isBinary,
      })
    }
  }

  return {
    stats: {
      filesCount: validFileCount,
      linesAdded: added,
      linesRemoved: removed,
    },
    perFileStats,
  }
}

/**
 * 解析统一 diff 输出为逐文件的 hunk。
 * 按 "diff --git" 分割并解析每个文件的 hunk。
 *
 * 应用限制：
 * - MAX_FILES：达到此文件数后停止
 * - 大于 1MB 的文件：完全跳过（不在结果 map 中）
 * - 小于等于 1MB 的文件：解析但限制为 MAX_LINES_PER_FILE 行
 */
export function parseGitDiff(stdout: string): Map<string, StructuredPatchHunk[]> {
  const result = new Map<string, StructuredPatchHunk[]>()
  if (!stdout.trim()) {
    return result
  }

  // 按文件 diff 分割
  const fileDiffs = stdout.split(/^diff --git /m).filter(Boolean)

  for (const fileDiff of fileDiffs) {
    // 达到 MAX_FILES 后停止
    if (result.size >= MAX_FILES) {
      break
    }

    // 跳过大于 1MB 的文件
    if (fileDiff.length > MAX_DIFF_SIZE_BYTES) {
      continue
    }

    const lines = fileDiff.split('\n')

    // 从第一行提取文件名："a/path/to/file b/path/to/file"
    const headerMatch = lines[0]?.match(/^a\/(.+?) b\/(.+)$/)
    if (!headerMatch) {
      continue
    }
    const filePath = headerMatch[2] ?? headerMatch[1] ?? ''

    // 查找并解析 hunk
    const fileHunks: StructuredPatchHunk[] = []
    let currentHunk: StructuredPatchHunk | null = null
    let lineCount = 0

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i] ?? ''

      // Hunk 头部：@@ -oldStart,oldLines +newStart,newLines @@
      const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
      if (hunkMatch) {
        if (currentHunk) {
          fileHunks.push(currentHunk)
        }
        currentHunk = {
          oldStart: parseInt(hunkMatch[1] ?? '0', 10),
          oldLines: parseInt(hunkMatch[2] ?? '1', 10),
          newStart: parseInt(hunkMatch[3] ?? '0', 10),
          newLines: parseInt(hunkMatch[4] ?? '1', 10),
          lines: [],
        }
        continue
      }

      // 跳过二进制文件标记和其他元数据
      if (
        line.startsWith('index ') ||
        line.startsWith('---') ||
        line.startsWith('+++') ||
        line.startsWith('new file') ||
        line.startsWith('deleted file') ||
        line.startsWith('old mode') ||
        line.startsWith('new mode') ||
        line.startsWith('Binary files')
      ) {
        continue
      }

      // 将 diff 行添加到当前 hunk（有行数限制）
      if (
        currentHunk &&
        (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '')
      ) {
        // 达到限制后停止添加行
        if (lineCount >= MAX_LINES_PER_FILE) {
          continue
        }
        // 强制进行平坦字符串拷贝以断开 V8 切片字符串引用。
        // 当 split() 创建行时，V8 会创建引用父字符串的"切片字符串"。
        // 这会使整个父字符串（约数 MB）在任何行被保留时一直存活。
        // 使用 '' + line 强制新的平坦字符串分配，
        // 不像 slice(0) 那样 V8 可能优化为返回相同引用。
        currentHunk.lines.push(`${line}`)
        lineCount++
      }
    }

    // 不要忘记最后一个 hunk
    if (currentHunk) {
      fileHunks.push(currentHunk)
    }

    if (fileHunks.length > 0) {
      result.set(filePath, fileHunks)
    }
  }

  return result
}

/**
 * 检查是否处于临时 git 状态（merge、rebase、cherry-pick 或 revert）。
 * 在这些操作期间跳过 diff 计算，因为工作树包含的是
 * 非用户主动操作的传入变更。
 *
 * 使用 fs.access 检查临时引用文件，避免进程生成。
 */
async function isInTransientGitState(): Promise<boolean> {
  const gitDir = await getGitDir(getCwd())
  if (!gitDir) {
    return false
  }

  const transientFiles = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']

  const results = await Promise.all(
    transientFiles.map((file) =>
      access(join(gitDir, file))
        .then(() => true)
        .catch(() => false),
    ),
  )
  return results.some(Boolean)
}

/**
 * 获取未跟踪文件名（不读取内容）。
 * 仅返回文件路径——它们将在展示时带有暂存提示。
 *
 * @param maxFiles 包含的最大未跟踪文件数
 */
async function fetchUntrackedFiles(maxFiles: number): Promise<Map<string, PerFileStats> | null> {
  // 获取未跟踪文件列表（排除 gitignore 中的文件）
  const { stdout, code } = await execFileNoThrow(
    gitExe(),
    ['--no-optional-locks', 'ls-files', '--others', '--exclude-standard'],
    { timeout: GIT_TIMEOUT_MS, preserveOutputOnError: false },
  )

  if (code !== 0 || !stdout.trim()) {
    return null
  }

  const untrackedPaths = stdout.trim().split('\n').filter(Boolean)
  if (untrackedPaths.length === 0) {
    return null
  }

  const perFileStats = new Map<string, PerFileStats>()

  // 仅记录文件名，不读取内容
  for (const filePath of untrackedPaths.slice(0, maxFiles)) {
    perFileStats.set(filePath, {
      added: 0,
      removed: 0,
      isBinary: false,
      isUntracked: true,
    })
  }

  return perFileStats
}

/**
 * 解析 git diff --shortstat 输出为统计信息。
 * 格式：" 1648 files changed, 52341 insertions(+), 8123 deletions(-)"
 *
 * 无论 diff 大小如何，内存消耗都是 O(1)——git 在不加载全部内容的情况下
 * 计算总计。用作昂贵操作前的快速探测。
 */
export function parseShortstat(stdout: string): GitDiffStats | null {
  // 匹配："N files changed" 加可选的 ", N insertions(+)" 和 ", N deletions(-)"
  const match = stdout.match(
    /(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/,
  )
  if (!match) {
    return null
  }
  return {
    filesCount: parseInt(match[1] ?? '0', 10),
    linesAdded: parseInt(match[2] ?? '0', 10),
    linesRemoved: parseInt(match[3] ?? '0', 10),
  }
}

const SINGLE_FILE_DIFF_TIMEOUT_MS = 3000

export type ToolUseDiff = {
  filename: string
  status: 'modified' | 'added'
  additions: number
  deletions: number
  changes: number
  patch: string
  /** 可用时的 GitHub "owner/repo"（非 github.com 或未知仓库时为 null） */
  repository: string | null
}

/**
 * 获取单个文件与默认分支 merge base 的结构化 diff。
 * 这产生类似 PR 的 diff，显示分支分叉以来的所有变更。
 * 如果无法确定 merge base（如在默认分支上），则回退到与 HEAD 做 diff。
 * 对于未跟踪文件，生成显示所有新增的合成 diff。
 * 不在 git 仓库中或 git 命令失败时返回 null。
 */
export async function fetchSingleFileGitDiff(
  absoluteFilePath: string,
): Promise<ToolUseDiff | null> {
  const gitRoot = findGitRoot(dirname(absoluteFilePath))
  if (!gitRoot) {
    return null
  }

  const gitPath = relative(gitRoot, absoluteFilePath).split(sep).join('/')
  const repository = getCachedRepository()

  // 检查文件是否被 git 跟踪
  const { code: lsFilesCode } = await execFileNoThrowWithCwd(
    gitExe(),
    ['--no-optional-locks', 'ls-files', '--error-unmatch', gitPath],
    { cwd: gitRoot, timeout: SINGLE_FILE_DIFF_TIMEOUT_MS },
  )

  if (lsFilesCode === 0) {
    // 文件已跟踪——与 merge base 做 diff 以获得类似 PR 的视图
    const diffRef = await getDiffRef(gitRoot)
    const { stdout, code } = await execFileNoThrowWithCwd(
      gitExe(),
      ['--no-optional-locks', 'diff', diffRef, '--', gitPath],
      { cwd: gitRoot, timeout: SINGLE_FILE_DIFF_TIMEOUT_MS },
    )
    if (code !== 0) {
      return null
    }
    if (!stdout) {
      return null
    }
    return {
      ...parseRawDiffToToolUseDiff(gitPath, stdout, 'modified'),
      repository,
    }
  }

  // 文件未跟踪——生成合成 diff
  const syntheticDiff = await generateSyntheticDiff(gitPath, absoluteFilePath)
  if (!syntheticDiff) {
    return null
  }
  return { ...syntheticDiff, repository }
}

/**
 * 将原始统一 diff 输出解析为结构化 ToolUseDiff 格式。
 * 仅提取 hunk 内容（从 @@ 开始）作为 patch，并统计新增/删除行数。
 */
function parseRawDiffToToolUseDiff(
  filename: string,
  rawDiff: string,
  status: 'modified' | 'added',
): Omit<ToolUseDiff, 'repository'> {
  const lines = rawDiff.split('\n')
  const patchLines: string[] = []
  let inHunks = false
  let additions = 0
  let deletions = 0

  for (const line of lines) {
    if (line.startsWith('@@')) {
      inHunks = true
    }
    if (inHunks) {
      patchLines.push(line)
      if (line.startsWith('+') && !line.startsWith('+++')) {
        additions++
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deletions++
      }
    }
  }

  return {
    filename,
    status,
    additions,
    deletions,
    changes: additions + deletions,
    patch: patchLines.join('\n'),
  }
}

/**
 * 确定用于类似 PR diff 的最佳比较引用。
 * 优先级：
 * 1. ZY_CODE_BASE_REF 环境变量（外部设置，如由 CCR 管理容器设置）
 * 2. 与默认分支的 merge base（最佳猜测）
 * 3. HEAD（merge-base 失败时的回退）
 */
async function getDiffRef(gitRoot: string): Promise<string> {
  const baseBranch = process.env.ZY_CODE_BASE_REF || (await getDefaultBranch())
  const { stdout, code } = await execFileNoThrowWithCwd(
    gitExe(),
    ['--no-optional-locks', 'merge-base', 'HEAD', baseBranch],
    { cwd: gitRoot, timeout: SINGLE_FILE_DIFF_TIMEOUT_MS },
  )
  if (code === 0 && stdout.trim()) {
    return stdout.trim()
  }
  return 'HEAD'
}

async function generateSyntheticDiff(
  gitPath: string,
  absoluteFilePath: string,
): Promise<Omit<ToolUseDiff, 'repository'> | null> {
  try {
    if (!isFileWithinReadSizeLimit(absoluteFilePath, MAX_DIFF_SIZE_BYTES)) {
      return null
    }
    const content = await readFile(absoluteFilePath, 'utf-8')
    const lines = content.split('\n')
    // 如果文件以换行符结尾，移除 split 产生的末尾空行
    if (lines.length > 0 && lines.at(-1) === '') {
      lines.pop()
    }
    const lineCount = lines.length
    const addedLines = lines.map((line) => `+${line}`).join('\n')
    const patch = `@@ -0,0 +1,${lineCount} @@\n${addedLines}`
    return {
      filename: gitPath,
      status: 'added',
      additions: lineCount,
      deletions: 0,
      changes: lineCount,
      patch,
    }
  } catch {
    return null
  }
}
