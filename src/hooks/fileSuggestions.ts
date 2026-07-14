import { statSync } from 'node:fs'
import * as path from 'node:path'
import ignore from 'ignore'
import {
  loadMarkdownFilesForSubdir,
  ZY_CONFIG_DIRECTORIES,
} from 'src/utils/markdownConfigLoader.js'
import type { SuggestionItem } from '../components/PromptInput/PromptInputFooterSuggestions.js'
import { CHUNK_MS, FileIndex, yieldToEventLoop } from '../native-ts/file-index/index.js'
import { logEvent } from '../services/analytics/index.js'
// @ts-expect-error
import type { FileSuggestionCommandInput } from '../types/fileSuggestion.js'
import { getGlobalConfig } from '../services/config/config.js'
import { getCwd } from '../utils/cwd.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { execFileNoThrowWithCwd } from '../services/shell/execFileNoThrow.js'
import { getFsImplementation } from '../utils/fsOperations.js'
import { findGitRoot, gitExe } from '../utils/git.js'
import { createBaseHookInput, executeFileSuggestionCommand } from '../services/hooks.js'
import { logError } from '../utils/log.js'
import { expandPath } from '../utils/path.js'
import { ripGrep } from '../utils/ripgrep.js'
import { getInitialSettings } from '../services/settings/settings.js'
import { createSignal } from '../utils/signal.js'

// 延迟构建的单例
let fileIndex: FileIndex | null = null

function getFileIndex(): FileIndex {
  if (!fileIndex) {
    fileIndex = new FileIndex()
  }
  return fileIndex
}

let fileListRefreshPromise: Promise<FileIndex> | null = null
// 当正在进行的索引构建完成时触发的信号。让 typeahead UI
// 重新运行上次搜索，使部分结果升级为完整结果。
const indexBuildComplete = createSignal()
export const onIndexBuildComplete = indexBuildComplete.subscribe
let cacheGeneration = 0

// 后台获取未跟踪文件
let untrackedFetchPromise: Promise<void> | null = null

// 缓存已跟踪文件，以便与未跟踪文件一起重建索引
let cachedTrackedFiles: string[] = []
// 缓存配置文件，以便 mergeUntrackedIntoNormalizedCache 保留它们
let cachedConfigFiles: string[] = []
// 缓存已跟踪目录，以便 mergeUntrackedIntoNormalizedCache 不必
// 在每次合并时重新计算约 27 万次 path.dirname() 调用
let cachedTrackedDirs: string[] = []

// .ignore/.rgignore 模式缓存（以 repoRoot:cwd 为键）
let ignorePatternsCache: ReturnType<typeof ignore> | null = null
let ignorePatternsCacheKey: string | null = null

// 后台刷新的节流状态。当已跟踪文件发生变更（add/checkout/commit/rm）时，
// .git/index 的 mtime 会触发立即刷新。时间下限仍每 5 秒刷新一次以获取
// 未跟踪文件，因为未跟踪文件不会更新索引。
let lastRefreshMs = 0
let lastGitIndexMtime: number | null = null

// 加载到 Rust 索引中的路径列表签名。使用两个独立签名是因为
// 两个 loadFromFileList 调用点使用了不同结构的数组——共享签名
// 会来回跳动而永远不匹配。当 git ls-files 返回未变更的列表时
// 跳过 nucleo.restart()（例如对已跟踪文件执行 `git add` 会更新
// 索引 mtime 但不改变列表）。
let loadedTrackedSignature: string | null = null
let loadedMergedSignature: string | null = null

/**
 * 清除所有文件建议缓存。
 * 在恢复会话时调用此函数以确保文件发现是最新的。
 */
export function clearFileSuggestionCaches(): void {
  fileIndex = null
  fileListRefreshPromise = null
  cacheGeneration++
  untrackedFetchPromise = null
  cachedTrackedFiles = []
  cachedConfigFiles = []
  cachedTrackedDirs = []
  indexBuildComplete.clear()
  ignorePatternsCache = null
  ignorePatternsCacheKey = null
  lastRefreshMs = 0
  lastGitIndexMtime = null
  loadedTrackedSignature = null
  loadedMergedSignature = null
}

/**
 * 路径列表的内容哈希。仅用 length|first|last 采样会遗漏中间文件
 * 的重命名（相同长度、相同端点 → 过期条目滞留在 nucleo 中）。
 *
 * 每隔 N 条路径采样一次（加上长度）。在 34.6 万路径的列表上，
 * 仅对约 700 条路径计算哈希而非 14MB——足以捕获 git 操作
 * （checkout、rebase、add/rm），且在 <1ms 内完成。恰好落在
 * 采样间隔之间的单个中段重命名会被遗漏，但 5 秒刷新下限
 * 会在下一轮补上。
 */
export function pathListSignature(paths: string[]): string {
  const n = paths.length
  const stride = Math.max(1, Math.floor(n / 500))
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < n; i += stride) {
    const p = paths[i]!
    for (let j = 0; j < p.length; j++) {
      h = ((h ^ p.charCodeAt(j)) * 0x01000193) | 0
    }
    h = (h * 0x01000193) | 0
  }
  // 步长从 0 开始（第一条路径始终被哈希）；显式包含最后一条，
  // 以便捕获尾部单文件的添加/删除
  if (n > 0) {
    const last = paths[n - 1]!
    for (let j = 0; j < last.length; j++) {
      h = ((h ^ last.charCodeAt(j)) * 0x01000193) | 0
    }
  }
  return `${n}:${(h >>> 0).toString(16)}`
}

/**
 * 读取 .git/index 的状态以检测 git 状态变更，无需启动 git ls-files。
 * 对于 worktree（.git 是文件 → ENOTDIR）、尚无索引的新仓库（ENOENT）
 * 以及非 git 目录返回 null——调用方回退到时间节流。
 */
function getGitIndexMtime(): number | null {
  const repoRoot = findGitRoot(getCwd())
  if (!repoRoot) {
    return null
  }
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs -- mtimeMs is the operation here, not a pre-check. findGitRoot above already stat-walks synchronously; one more stat is marginal vs spawning git ls-files on every keystroke. Async would force startBackgroundCacheRefresh to become async, breaking the synchronous fileListRefreshPromise contract at the cold-start await site.
    return statSync(path.join(repoRoot, '.git', 'index')).mtimeMs
  } catch {
    return null
  }
}

/**
 * 将 git 路径相对于 originalCwd 进行归一化
 */
function normalizeGitPaths(files: string[], repoRoot: string, originalCwd: string): string[] {
  if (originalCwd === repoRoot) {
    return files
  }
  return files.map((f) => {
    const absolutePath = path.join(repoRoot, f)
    return path.relative(originalCwd, absolutePath)
  })
}

/**
 * 将已归一化的未跟踪文件合并到缓存中
 */
async function mergeUntrackedIntoNormalizedCache(normalizedUntracked: string[]): Promise<void> {
  if (normalizedUntracked.length === 0) {
    return
  }
  if (!fileIndex || cachedTrackedFiles.length === 0) {
    return
  }

  const untrackedDirs = await getDirectoryNamesAsync(normalizedUntracked)
  const allPaths = [
    ...cachedTrackedFiles,
    ...cachedConfigFiles,
    ...cachedTrackedDirs,
    ...normalizedUntracked,
    ...untrackedDirs,
  ]
  const sig = pathListSignature(allPaths)
  if (sig === loadedMergedSignature) {
    logForDebugging(`[FileIndex] 跳过索引重建 — 合并路径未变更`)
    return
  }
  await fileIndex.loadFromFileListAsync(allPaths).done
  loadedMergedSignature = sig
  logForDebugging(
    `[FileIndex] 已用 ${cachedTrackedFiles.length} 个已跟踪 + ${normalizedUntracked.length} 个未跟踪文件重建索引`,
  )
}

/**
 * 从 .ignore 或 .rgignore 文件加载 ripgrep 专用的忽略模式。
 * 如果找到模式则返回 ignore 实例，否则返回 null。
 * 结果按 repoRoot:cwd 组合缓存。
 */
async function loadRipgrepIgnorePatterns(
  repoRoot: string,
  cwd: string,
): Promise<ReturnType<typeof ignore> | null> {
  const cacheKey = `${repoRoot}:${cwd}`

  // 如果有缓存结果则返回
  if (ignorePatternsCacheKey === cacheKey) {
    return ignorePatternsCache
  }

  const fs = getFsImplementation()
  const ignoreFiles = ['.ignore', '.rgignore']
  const directories = [...new Set([repoRoot, cwd])]

  const ig = ignore()
  let hasPatterns = false

  const paths = directories.flatMap((dir) => ignoreFiles.map((f) => path.join(dir, f)))
  const contents = await Promise.all(
    paths.map((p) => fs.readFile(p, { encoding: 'utf8' }).catch(() => null)),
  )
  for (const [i, content] of contents.entries()) {
    if (content === null) {
      continue
    }
    ig.add(content)
    hasPatterns = true
    logForDebugging(`[FileIndex] 已从 ${paths[i]} 加载忽略模式`)
  }

  const result = hasPatterns ? ig : null
  ignorePatternsCache = result
  ignorePatternsCacheKey = cacheKey

  return result
}

/**
 * 使用 git ls-files 获取文件（对于 git 仓库比 ripgrep 快得多）
 * 立即返回已跟踪文件，在后台获取未跟踪文件
 * @param respectGitignore 如果为 true，从未跟踪结果中排除 gitignored 文件
 *
 * 注意：与 ripgrep --follow 不同，git ls-files 不跟随符号链接。
 * 这是有意为之，因为 git 将符号链接作为符号链接跟踪。
 */
async function getFilesUsingGit(
  abortSignal: AbortSignal,
  respectGitignore: boolean,
): Promise<string[] | null> {
  const startTime = Date.now()
  logForDebugging(`[FileIndex] getFilesUsingGit 已调用`)

  // 检查是否在 git 仓库中。findGitRoot 对每个路径做了 LRU 缓存。
  const repoRoot = findGitRoot(getCwd())
  if (!repoRoot) {
    logForDebugging(`[FileIndex] 非 git 仓库，返回 null`)
    return null
  }

  try {
    const cwd = getCwd()

    // 获取已跟踪文件（快速 - 从 git 索引读取）
    // 从 repoRoot 运行，使路径相对于仓库根目录而非 CWD
    const lsFilesStart = Date.now()
    const trackedResult = await execFileNoThrowWithCwd(
      gitExe(),
      ['-c', 'core.quotepath=false', 'ls-files', '--recurse-submodules'],
      { timeout: 5000, abortSignal, cwd: repoRoot },
    )
    logForDebugging(`[FileIndex] git ls-files（已跟踪）耗时 ${Date.now() - lsFilesStart}ms`)

    if (trackedResult.code !== 0) {
      logForDebugging(
        `[FileIndex] git ls-files 失败 (code=${trackedResult.code}, stderr=${trackedResult.stderr})，回退到 ripgrep`,
      )
      return null
    }

    const trackedFiles = trackedResult.stdout.trim().split('\n').filter(Boolean)

    // 将路径相对于当前工作目录归一化
    let normalizedTracked = normalizeGitPaths(trackedFiles, repoRoot, cwd)

    // 如果存在 .ignore/.rgignore 模式则应用（比回退到 ripgrep 更快）
    const ignorePatterns = await loadRipgrepIgnorePatterns(repoRoot, cwd)
    if (ignorePatterns) {
      const beforeCount = normalizedTracked.length
      normalizedTracked = ignorePatterns.filter(normalizedTracked)
      logForDebugging(
        `[FileIndex] 已应用忽略模式：${beforeCount} -> ${normalizedTracked.length} 个文件`,
      )
    }

    // 缓存已跟踪文件，稍后与未跟踪文件合并
    cachedTrackedFiles = normalizedTracked

    const duration = Date.now() - startTime
    logForDebugging(
      `[FileIndex] git ls-files：${normalizedTracked.length} 个已跟踪文件，耗时 ${duration}ms`,
    )

    logEvent('zy_file_suggestions_git_ls_files', {
      file_count: normalizedTracked.length,
      tracked_count: normalizedTracked.length,
      untracked_count: 0,
      duration_ms: duration,
    })

    // 启动后台获取未跟踪文件（不等待）
    if (!untrackedFetchPromise) {
      const untrackedArgs = respectGitignore
        ? ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard']
        : ['-c', 'core.quotepath=false', 'ls-files', '--others']

      const generation = cacheGeneration
      untrackedFetchPromise = execFileNoThrowWithCwd(gitExe(), untrackedArgs, {
        timeout: 10000,
        cwd: repoRoot,
      })
        .then(async (untrackedResult) => {
          if (generation !== cacheGeneration) {
            return // 缓存已清除；不要合并过期的未跟踪文件
          }
          if (untrackedResult.code === 0) {
            const rawUntrackedFiles = untrackedResult.stdout.trim().split('\n').filter(Boolean)

            // 在应用忽略模式之前归一化路径（与已跟踪文件一致）
            let normalizedUntracked = normalizeGitPaths(rawUntrackedFiles, repoRoot, cwd)

            // 对已归一化的未跟踪文件应用 .ignore/.rgignore 模式
            const ignorePatterns = await loadRipgrepIgnorePatterns(repoRoot, cwd)
            if (ignorePatterns && normalizedUntracked.length > 0) {
              const beforeCount = normalizedUntracked.length
              normalizedUntracked = ignorePatterns.filter(normalizedUntracked)
              logForDebugging(
                `[FileIndex] 已对未跟踪文件应用忽略模式：${beforeCount} -> ${normalizedUntracked.length} 个文件`,
              )
            }

            logForDebugging(`[FileIndex] 后台未跟踪文件获取：${normalizedUntracked.length} 个文件`)
            // 将已归一化的文件直接传递给合并函数
            void mergeUntrackedIntoNormalizedCache(normalizedUntracked)
          }
        })
        .catch((error) => {
          logForDebugging(`[FileIndex] 后台未跟踪文件获取失败：${error}`)
        })
        .finally(() => {
          untrackedFetchPromise = null
        })
    }

    return normalizedTracked
  } catch (error) {
    logForDebugging(`[FileIndex] git ls-files 错误：${errorMessage(error)}`)
    return null
  }
}

/**
 * 此函数收集每个文件路径的所有父目录，
 * 并返回带有尾部分隔符的唯一目录名称列表。
 * 例如，如果输入是 ['src/index.js', 'src/utils/helpers.js']，
 * 输出将是 ['src/', 'src/utils/']。
 * @param files 文件路径数组
 * @returns 带有尾部分隔符的唯一目录名称数组
 */
export function getDirectoryNames(files: string[]): string[] {
  const directoryNames = new Set<string>()
  collectDirectoryNames(files, 0, files.length, directoryNames)
  return [...directoryNames].map((d) => d + path.sep)
}

/**
 * 异步变体：每约 1 万个文件让出一次，避免 27 万+ 文件列表
 * 连续占用主线程超过 10ms。
 */
export async function getDirectoryNamesAsync(files: string[]): Promise<string[]> {
  const directoryNames = new Set<string>()
  // 基于时间的分块：在 CHUNK_MS 的工作量后让出，使慢速机器获得
  // 更小的分块并保持响应。
  let chunkStart = performance.now()
  for (let i = 0; i < files.length; i++) {
    collectDirectoryNames(files, i, i + 1, directoryNames)
    if ((i & 0xff) === 0xff && performance.now() - chunkStart > CHUNK_MS) {
      await yieldToEventLoop()
      chunkStart = performance.now()
    }
  }
  return [...directoryNames].map((d) => d + path.sep)
}

function collectDirectoryNames(
  files: string[],
  start: number,
  end: number,
  out: Set<string>,
): void {
  for (let i = start; i < end; i++) {
    let currentDir = path.dirname(files[i]!)
    // 如果已处理过此目录及其所有父目录则提前退出。
    // 根目录检测：path.dirname 在根目录返回其输入（不动点），
    // 因此当 dirname 不再变化时停止。在 add() 之前检查
    // 可将根目录排除在结果集之外（与旧 path.parse().root 守卫一致）。
    // 这避免了 path.parse()，后者会为每个文件分配一个 5 字段对象。
    while (currentDir !== '.' && !out.has(currentDir)) {
      const parent = path.dirname(currentDir)
      if (parent === currentDir) {
        break
      }
      out.add(currentDir)
      currentDir = parent
    }
  }
}

/**
 * 获取 Zy 配置目录中的额外文件
 */
async function getZyConfigFiles(cwd: string): Promise<string[]> {
  const markdownFileArrays = await Promise.all(
    ZY_CONFIG_DIRECTORIES.map((subdir) => loadMarkdownFilesForSubdir(subdir, cwd)),
  )
  return markdownFileArrays.flatMap((markdownFiles) => markdownFiles.map((f) => f.filePath))
}

/**
 * 使用 git ls-files（快速）或 ripgrep（回退）获取项目文件
 */
async function getProjectFiles(
  abortSignal: AbortSignal,
  respectGitignore: boolean,
): Promise<string[]> {
  logForDebugging(`[FileIndex] getProjectFiles 已调用，respectGitignore=${respectGitignore}`)

  // 优先尝试 git ls-files（对于 git 仓库快得多）
  const gitFiles = await getFilesUsingGit(abortSignal, respectGitignore)
  if (gitFiles !== null) {
    logForDebugging(`[FileIndex] 使用 git ls-files 结果（${gitFiles.length} 个文件）`)
    return gitFiles
  }

  // 回退到 ripgrep
  logForDebugging(`[FileIndex] git ls-files 返回 null，回退到 ripgrep`)
  const startTime = Date.now()
  const rgArgs = [
    '--files',
    '--follow',
    '--hidden',
    '--glob',
    '!.git/',
    '--glob',
    '!.svn/',
    '--glob',
    '!.hg/',
    '--glob',
    '!.bzr/',
    '--glob',
    '!.jj/',
    '--glob',
    '!.sl/',
  ]
  if (!respectGitignore) {
    rgArgs.push('--no-ignore-vcs')
  }

  const files = await ripGrep(rgArgs, '.', abortSignal)
  const relativePaths = files.map((f) => path.relative(getCwd(), f))

  const duration = Date.now() - startTime
  logForDebugging(`[FileIndex] ripgrep：${relativePaths.length} 个文件，耗时 ${duration}ms`)

  logEvent('zy_file_suggestions_ripgrep', {
    file_count: relativePaths.length,
    duration_ms: duration,
  })

  return relativePaths
}

/**
 * 获取文件及其目录路径，用于提供路径建议。
 * 对于 git 仓库使用 git ls-files（快速）或 ripgrep 作为回退。
 * 返回已填充的 FileIndex，用于快速模糊搜索。
 */
export async function getPathsForSuggestions(): Promise<FileIndex> {
  const signal = AbortSignal.timeout(10_000)
  const index = getFileIndex()

  try {
    // 先检查项目设置，然后回退到全局配置
    const projectSettings = getInitialSettings()
    const globalConfig = getGlobalConfig()
    const respectGitignore =
      projectSettings.respectGitignore ?? globalConfig.respectGitignore ?? true

    const cwd = getCwd()
    const [projectFiles, configFiles] = await Promise.all([
      getProjectFiles(signal, respectGitignore),
      getZyConfigFiles(cwd),
    ])

    // 缓存供 mergeUntrackedIntoNormalizedCache 使用
    cachedConfigFiles = configFiles

    const allFiles = [...projectFiles, ...configFiles]
    const directories = await getDirectoryNamesAsync(allFiles)
    cachedTrackedDirs = directories
    const allPathsList = [...directories, ...allFiles]

    // 当列表未变更时跳过重建。这是输入会话中的常见情况——
    // git ls-files 返回相同的输出。
    const sig = pathListSignature(allPathsList)
    if (sig !== loadedTrackedSignature) {
      // 等待完整构建，使冷启动返回完整结果。构建每约 4ms
      // 让出一次，UI 保持响应——用户可以在约 120ms 等待期间
      // 继续输入而不会出现输入延迟。
      await index.loadFromFileListAsync(allPathsList).done
      loadedTrackedSignature = sig
      // 我们刚刚用仅含已跟踪数据的索引替换了合并索引。
      // 强制下次未跟踪合并重建，即使其自身签名匹配。
      loadedMergedSignature = null
    } else {
      logForDebugging(`[FileIndex] 跳过索引重建 — 已跟踪路径未变更`)
    }
  } catch (error) {
    logError(error)
  }

  return index
}

/**
 * 查找两个字符串之间的公共前缀
 */
function findCommonPrefix(a: string, b: string): string {
  const minLength = Math.min(a.length, b.length)
  let i = 0
  while (i < minLength && a[i] === b[i]) {
    i++
  }
  return a.substring(0, i)
}

/**
 * 查找建议项数组中的最长公共前缀
 */
export function findLongestCommonPrefix(suggestions: SuggestionItem[]): string {
  if (suggestions.length === 0) {
    return ''
  }

  const strings = suggestions.map((item) => item.displayText)
  let prefix = strings[0]!
  for (let i = 1; i < strings.length; i++) {
    const currentString = strings[i]!
    prefix = findCommonPrefix(prefix, currentString)
    if (prefix === '') {
      return ''
    }
  }
  return prefix
}

/**
 * 创建文件建议项
 */
function createFileSuggestionItem(filePath: string, score?: number): SuggestionItem {
  return {
    id: `file-${filePath}`,
    displayText: filePath,
    metadata: score !== undefined ? { score } : undefined,
  }
}

/**
 * 使用 TS 文件索引查找给定查询匹配的文件和文件夹
 */
const MAX_SUGGESTIONS = 15
function findMatchingFiles(fileIndex: FileIndex, partialPath: string): SuggestionItem[] {
  const results = fileIndex.search(partialPath, MAX_SUGGESTIONS)
  return results.map((result) => createFileSuggestionItem(result.path, result.score))
}

/**
 * 如果尚未进行，则启动文件索引缓存的后台刷新。
 *
 * 节流：当缓存已存在时，除非 git 状态实际发生了变更，
 * 否则跳过刷新。这防止每次按键都启动 git ls-files
 * 并重建 nucleo 索引。
 */
const REFRESH_THROTTLE_MS = 5_000
export function startBackgroundCacheRefresh(): void {
  if (fileListRefreshPromise) {
    return
  }

  // 仅在缓存已存在时节流——冷启动必须始终填充。
  // 当 .git/index mtime 变更（已跟踪文件）时立即刷新。
  // 否则最多每 5 秒刷新一次——此下限用于获取新增的未跟踪文件，
  // 因为未跟踪文件不会更新 .git/index。下游签名检查会在
  // 5 秒刷新未发现实际变更时跳过重建。
  const indexMtime = getGitIndexMtime()
  if (fileIndex) {
    const gitStateChanged = indexMtime !== null && indexMtime !== lastGitIndexMtime
    if (!gitStateChanged && Date.now() - lastRefreshMs < REFRESH_THROTTLE_MS) {
      return
    }
  }

  const generation = cacheGeneration
  const refreshStart = Date.now()
  // 确保 FileIndex 单例存在——在构建运行期间可通过
  // readyCount 逐步查询。提前搜索的调用方获得部分结果；
  // indexBuildComplete 在 .done 之后触发，以便它们重新搜索。
  getFileIndex()
  fileListRefreshPromise = getPathsForSuggestions()
    .then((result) => {
      if (generation !== cacheGeneration) {
        return result // 缓存已清除；不要用过期数据覆盖
      }
      fileListRefreshPromise = null
      indexBuildComplete.emit()
      // 成功时提交开始时间的 mtime 观察。如果 git 状态
      // 在刷新过程中变更，下次调用将看到更新的 mtime
      // 并正确地再次刷新。
      lastGitIndexMtime = indexMtime
      lastRefreshMs = Date.now()
      logForDebugging(`[FileIndex] 缓存刷新完成，耗时 ${Date.now() - refreshStart}ms`)
      return result
    })
    .catch((error) => {
      logForDebugging(`[FileIndex] 缓存刷新失败：${errorMessage(error)}`)
      logError(error)
      if (generation === cacheGeneration) {
        fileListRefreshPromise = null // 允许下次调用时重试
      }
      return getFileIndex()
    })
}

/**
 * 获取当前工作目录中的顶层文件和目录
 * @returns 当前目录中的文件/目录路径数组
 */
async function getTopLevelPaths(): Promise<string[]> {
  const fs = getFsImplementation()
  const cwd = getCwd()

  try {
    const entries = await fs.readdir(cwd)
    return entries.map((entry) => {
      const fullPath = path.join(cwd, entry.name)
      const relativePath = path.relative(cwd, fullPath)
      // 为目录添加尾部分隔符
      return entry.isDirectory() ? relativePath + path.sep : relativePath
    })
  } catch (error) {
    logError(error as Error)
    return []
  }
}

/**
 * 根据当前输入和光标位置生成文件建议
 * @param partialPath 要匹配的部分文件路径
 * @param showOnEmpty 是否在 partialPath 为空时仍显示建议（用于 @ 符号）
 */
export async function generateFileSuggestions(
  partialPath: string,
  showOnEmpty = false,
): Promise<SuggestionItem[]> {
  // 如果输入为空且不需要在空输入时显示建议，则返回空
  if (!partialPath && !showOnEmpty) {
    return []
  }

  // 如果配置了自定义命令则直接使用。我们不在其中混入配置文件，
  // 因为命令使用自己的搜索逻辑返回预排序结果。
  if (getInitialSettings().fileSuggestion?.type === 'command') {
    const input: FileSuggestionCommandInput = {
      ...createBaseHookInput(),
      query: partialPath,
    }
    const results = await executeFileSuggestionCommand(input)
    return results.slice(0, MAX_SUGGESTIONS).map(createFileSuggestionItem)
  }

  // 如果部分路径为空或只是一个点，返回当前目录建议
  if (partialPath === '' || partialPath === '.' || partialPath === './') {
    const topLevelPaths = await getTopLevelPaths()
    startBackgroundCacheRefresh()
    return topLevelPaths.slice(0, MAX_SUGGESTIONS).map(createFileSuggestionItem)
  }

  const startTime = Date.now()

  try {
    // 启动后台刷新。索引可逐步查询——构建期间的搜索
    // 从已就绪的分块返回部分结果，typeahead 回调
    // （setOnIndexBuildComplete）在构建完成时重新触发搜索，
    // 将部分结果升级为完整结果。
    const wasBuilding = fileListRefreshPromise !== null
    startBackgroundCacheRefresh()

    // 处理 './' 和 '.\' 两种情况
    let normalizedPath = partialPath
    const currentDirPrefix = `.${path.sep}`
    if (partialPath.startsWith(currentDirPrefix)) {
      normalizedPath = partialPath.substring(2)
    }

    // 处理波浪号展开为 home 目录
    if (normalizedPath.startsWith('~')) {
      normalizedPath = expandPath(normalizedPath)
    }

    const matches = fileIndex ? findMatchingFiles(fileIndex, normalizedPath) : []

    const duration = Date.now() - startTime
    logForDebugging(
      `[FileIndex] generateFileSuggestions：${matches.length} 个结果，耗时 ${duration}ms（${wasBuilding ? '部分' : '完整'}索引）`,
    )
    logEvent('zy_file_suggestions_query', {
      duration_ms: duration,
      cache_hit: !wasBuilding,
      result_count: matches.length,
      query_length: partialPath.length,
    })

    return matches
  } catch (error) {
    logError(error)
    return []
  }
}

/**
 * 将文件建议应用到输入中
 */
export function applyFileSuggestion(
  suggestion: string | SuggestionItem,
  input: string,
  partialPath: string,
  startPos: number,
  onInputChange: (value: string) => void,
  setCursorOffset: (offset: number) => void,
): void {
  // 从字符串或 SuggestionItem 中提取建议文本
  const suggestionText = typeof suggestion === 'string' ? suggestion : suggestion.displayText

  // 用选中的文件路径替换部分路径
  const newInput =
    input.substring(0, startPos) + suggestionText + input.substring(startPos + partialPath.length)
  onInputChange(newInput)

  // 将光标移动到文件路径末尾
  const newCursorPos = startPos + suggestionText.length
  setCursorOffset(newCursorPos)
}
