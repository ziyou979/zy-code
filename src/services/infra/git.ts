import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { open, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import memoize from 'lodash-es/memoize.js'
import { hasBinaryExtension, isBinaryContent } from '../../constants/files.js'
import { getCwd } from '../environment/cwd.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPII } from '../telemetry/diagLogs.js'
import { execFileNoThrow } from '../shell/execFileNoThrow.js'
import { getFsImplementation } from './fsOperations.js'
import {
  getCachedBranch,
  getCachedDefaultBranch,
  getCachedHead,
  getCachedRemoteUrl,
  getWorktreeCountFromFs,
  isShallowClone as isShallowCloneFs,
  resolveGitDir,
} from '../git/gitFilesystem.js'
import { logError } from './log.js'
import { memoizeWithLRU } from '../../utils/memoize.js'
import { whichSync } from '../shell/which.js'
import {
  normalizeGitRemoteUrl,
  type GitFileStatus,
  type GitRepoState,
  type PreservedGitState,
} from '../git/gitUrlUtils.js'
const GIT_ROOT_NOT_FOUND = Symbol('git-root-not-found')

const findGitRootImpl = memoizeWithLRU(
  (startPath: string): string | typeof GIT_ROOT_NOT_FOUND => {
    const startTime = Date.now()
    logForDiagnosticsNoPII('info', 'find_git_root_started')

    let current = resolve(startPath)
    const root = current.substring(0, current.indexOf(sep) + 1) || sep
    let statCount = 0

    while (current !== root) {
      try {
        const gitPath = join(current, '.git')
        statCount++
        const stat = statSync(gitPath)
        // .git 可以是目录（普通仓库）或文件（worktree/子模块）
        if (stat.isDirectory() || stat.isFile()) {
          logForDiagnosticsNoPII('info', 'find_git_root_completed', {
            duration_ms: Date.now() - startTime,
            stat_count: statCount,
            found: true,
          })
          return current.normalize('NFC')
        }
      } catch {
        // 此层级不存在 .git，继续向上查找
      }
      const parent = dirname(current)
      if (parent === current) {
        break
      }
      current = parent
    }

    // 同样检查根目录
    try {
      const gitPath = join(root, '.git')
      statCount++
      const stat = statSync(gitPath)
      if (stat.isDirectory() || stat.isFile()) {
        logForDiagnosticsNoPII('info', 'find_git_root_completed', {
          duration_ms: Date.now() - startTime,
          stat_count: statCount,
          found: true,
        })
        return root.normalize('NFC')
      }
    } catch {
      // 根目录不存在 .git
    }

    logForDiagnosticsNoPII('info', 'find_git_root_completed', {
      duration_ms: Date.now() - startTime,
      stat_count: statCount,
      found: false,
    })
    return GIT_ROOT_NOT_FOUND
  },
  (path) => path,
  50,
)

/**
 * 通过向上遍历目录树查找 git 根目录。
 * 查找 .git 目录或文件（worktree/子模块使用文件形式）。
 * 返回包含 .git 的目录，未找到则返回 null。
 *
 * 按 startPath 进行 LRU 缓存记忆化（最多 50 条）以防止无限增长——
 * gitDiff 使用 dirname(file) 调用此函数，因此编辑不同目录中的多个文件
 * 否则会无限累积缓存条目。
 */
export const findGitRoot = createFindGitRoot()

function createFindGitRoot(): {
  (startPath: string): string | null
  cache: typeof findGitRootImpl.cache
} {
  function wrapper(startPath: string): string | null {
    const result = findGitRootImpl(startPath)
    return result === GIT_ROOT_NOT_FOUND ? null : result
  }
  wrapper.cache = findGitRootImpl.cache
  return wrapper
}

/**
 * 将 git 根目录解析为规范的主仓库根目录。
 * 对于普通仓库这是空操作。对于 worktree，沿着
 * `.git` 文件 → `gitdir:` → `commondir` 链查找主仓库的工作目录。
 *
 * 子模块（`.git` 是文件但没有 `commondir`）会回退到输入的根目录，
 * 这是正确的，因为子模块是独立的仓库。
 *
 * 使用小型 LRU 进行记忆化，避免在热路径（权限检查、prompt 构建）上
 * 重复读取文件。
 */
const resolveCanonicalRoot = memoizeWithLRU(
  (gitRoot: string): string => {
    try {
      // 在 worktree 中，.git 是包含 gitdir: <path> 的文件
      // 在普通仓库中，.git 是目录（readFileSync 会抛出 EISDIR）。
      const gitContent = readFileSync(join(gitRoot, '.git'), 'utf-8').trim()
      if (!gitContent.startsWith('gitdir:')) {
        return gitRoot
      }
      const worktreeGitDir = resolve(gitRoot, gitContent.slice('gitdir:'.length).trim())
      // commondir 指向共享的 .git 目录（相对于 worktree gitdir）。
      // 子模块没有 commondir（readFileSync 抛出 ENOENT）→ 回退。
      const commonDir = resolve(
        worktreeGitDir,
        readFileSync(join(worktreeGitDir, 'commondir'), 'utf-8').trim(),
      )
      // 安全性：在克隆/下载的仓库中，.git 文件和 commondir 可被攻击者控制。
      // 如果不进行验证，恶意仓库可以将 commondir 指向受害者已信任的任何路径，
      // 绕过信任对话框并在启动时从 .zy/settings.json 执行钩子。
      //
      // 验证结构是否与 `git worktree add` 创建的一致：
      //   1. worktreeGitDir 是 <commonDir>/worktrees/ 的直接子目录
      //      → 确保我们读取的 commondir 文件位于解析后的 common dir 内部，
      //        而不是攻击者的仓库内部
      //   2. <worktreeGitDir>/gitdir 指回 <gitRoot>/.git
      //      → 确保攻击者无法通过猜测路径借用受害者现有的 worktree 条目
      // 两者都是必需的：仅 (1) 在受害者拥有受信任仓库的 worktree 时会失败；
      // 仅 (2) 会失败因为攻击者控制 worktreeGitDir。
      if (resolve(dirname(worktreeGitDir)) !== join(commonDir, 'worktrees')) {
        return gitRoot
      }
      // Git 使用 strbuf_realpath()（解析符号链接）写入 gitdir，但
      // findGitRoot() 返回的 gitRoot 仅是词法解析的。对 gitRoot 执行 realpath
      // 使得通过符号链接路径访问的合法 worktree（如 macOS /tmp → /private/tmp）
      // 不会被拒绝。对目录执行 realpath 然后拼接 '.git'——对 .git 文件本身
      // 执行 realpath 会跟踪符号链接的 .git，让攻击者借用受害者的反向链接。
      const backlink = realpathSync(readFileSync(join(worktreeGitDir, 'gitdir'), 'utf-8').trim())
      if (backlink !== join(realpathSync(gitRoot), '.git')) {
        return gitRoot
      }
      // 裸仓库 worktree：common dir 不在工作目录内。
      // 使用 common dir 本身作为稳定标识（anthropics/zy-code#27994）。
      if (basename(commonDir) !== '.git') {
        return commonDir.normalize('NFC')
      }
      return dirname(commonDir).normalize('NFC')
    } catch {
      return gitRoot
    }
  },
  (root) => root,
  50,
)

/**
 * 查找规范的 git 仓库根目录，解析 worktree 引用。
 *
 * 与 findGitRoot 不同（返回 worktree 目录，即 `.git` 文件所在位置），
 * 此函数返回主仓库的工作目录。这确保同一仓库的所有 worktree
 * 映射到相同的项目标识。
 *
 * 对于项目范围的状态（自动记忆、项目配置、Agent 记忆），
 * 请使用此函数代替 findGitRoot，以便 worktree 与主仓库共享状态。
 */
export const findCanonicalGitRoot = createFindCanonicalGitRoot()

function createFindCanonicalGitRoot(): {
  (startPath: string): string | null
  cache: typeof resolveCanonicalRoot.cache
} {
  function wrapper(startPath: string): string | null {
    const root = findGitRoot(startPath)
    if (!root) {
      return null
    }
    return resolveCanonicalRoot(root)
  }
  wrapper.cache = resolveCanonicalRoot.cache
  return wrapper
}

export const gitExe = memoize((): string => {
  // 每次生成进程时都需要查找路径。
  // 我们改为只查找一次来避免重复查找。
  return whichSync('git') || 'git'
})

export const getIsGit = memoize(async (): Promise<boolean> => {
  const startTime = Date.now()
  logForDiagnosticsNoPII('info', 'is_git_check_started')

  const isGit = findGitRoot(getCwd()) !== null

  logForDiagnosticsNoPII('info', 'is_git_check_completed', {
    duration_ms: Date.now() - startTime,
    is_git: isGit,
  })
  return isGit
})

export function getGitDir(cwd: string): Promise<string | null> {
  return resolveGitDir(cwd)
}

export async function isAtGitRoot(): Promise<boolean> {
  const cwd = getCwd()
  const gitRoot = findGitRoot(cwd)
  if (!gitRoot) {
    return false
  }
  // 解析符号链接以进行准确比较
  try {
    const [resolvedCwd, resolvedGitRoot] = await Promise.all([realpath(cwd), realpath(gitRoot)])
    return resolvedCwd === resolvedGitRoot
  } catch {
    return cwd === gitRoot
  }
}

export const dirIsInGitRepo = async (cwd: string): Promise<boolean> => {
  return findGitRoot(cwd) !== null
}

export const getHead = async (): Promise<string> => {
  return getCachedHead()
}

export const getBranch = async (): Promise<string> => {
  return getCachedBranch()
}

export const getDefaultBranch = async (): Promise<string> => {
  return getCachedDefaultBranch()
}

export const getRemoteUrl = async (): Promise<string | null> => {
  return getCachedRemoteUrl()
}

/**
 * 返回规范化 git remote URL 的 SHA256 哈希值（前 16 个字符）。
 * 这提供了一个全局唯一的仓库标识符，具有以下特性：
 * - 无论使用 SSH 还是 HTTPS 克隆，结果相同
 * - 不在日志中暴露实际仓库名称
 */
export async function getRepoRemoteHash(): Promise<string | null> {
  const remoteUrl = await getRemoteUrl()
  if (!remoteUrl) {
    return null
  }

  const normalized = normalizeGitRemoteUrl(remoteUrl)
  if (!normalized) {
    return null
  }

  const hash = createHash('sha256').update(normalized).digest('hex')
  return hash.substring(0, 16)
}

export const getIsHeadOnRemote = async (): Promise<boolean> => {
  const { code } = await execFileNoThrow(gitExe(), ['rev-parse', '@{u}'], {
    preserveOutputOnError: false,
  })
  return code === 0
}

export const hasUnpushedCommits = async (): Promise<boolean> => {
  const { stdout, code } = await execFileNoThrow(gitExe(), ['rev-list', '--count', '@{u}..HEAD'], {
    preserveOutputOnError: false,
  })
  return code === 0 && parseInt(stdout.trim(), 10) > 0
}

export const getIsClean = async (options?: { ignoreUntracked?: boolean }): Promise<boolean> => {
  const args = ['--no-optional-locks', 'status', '--porcelain']
  if (options?.ignoreUntracked) {
    args.push('-uno')
  }
  const { stdout } = await execFileNoThrow(gitExe(), args, {
    preserveOutputOnError: false,
  })
  return stdout.trim().length === 0
}

export const getChangedFiles = async (): Promise<string[]> => {
  const { stdout } = await execFileNoThrow(
    gitExe(),
    ['--no-optional-locks', 'status', '--porcelain'],
    {
      preserveOutputOnError: false,
    },
  )
  return stdout
    .trim()
    .split('\n')
    .map((line) => line.trim().split(' ', 2)[1]?.trim()) // 移除状态前缀（如 "M ", "A ", "??"）
    .filter((line) => typeof line === 'string') // 移除空条目
}

export const getFileStatus = async (): Promise<GitFileStatus> => {
  const { stdout } = await execFileNoThrow(
    gitExe(),
    ['--no-optional-locks', 'status', '--porcelain'],
    {
      preserveOutputOnError: false,
    },
  )

  const tracked: string[] = []
  const untracked: string[] = []

  stdout
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .forEach((line) => {
      const status = line.substring(0, 2)
      const filename = line.substring(2).trim()

      if (status === '??') {
        untracked.push(filename)
      } else if (filename) {
        tracked.push(filename)
      }
    })

  return { tracked, untracked }
}

export const getWorktreeCount = async (): Promise<number> => {
  return getWorktreeCountFromFs()
}

/**
 * 暂存所有变更（包括未跟踪文件），使 git 回到干净的 porcelain 状态
 * 重要：此函数在 stash 前先暂存未跟踪文件，以防止数据丢失
 * @param message - 可选的 stash 自定义消息
 * @returns Promise<boolean> - stash 成功返回 true，否则返回 false
 */
export const stashToCleanState = async (message?: string): Promise<boolean> => {
  try {
    const stashMessage = message || `ZY Code auto-stash - ${new Date().toISOString()}`

    // 首先检查是否有未跟踪文件
    const { untracked } = await getFileStatus()

    // 如果有未跟踪文件，先将它们添加到索引中
    // 这可以防止它们被删除
    if (untracked.length > 0) {
      const { code: addCode } = await execFileNoThrow(gitExe(), ['add', ...untracked], {
        preserveOutputOnError: false,
      })

      if (addCode !== 0) {
        return false
      }
    }

    // 现在 stash 所有内容（已暂存和未暂存的变更）
    const { code } = await execFileNoThrow(gitExe(), ['stash', 'push', '--message', stashMessage], {
      preserveOutputOnError: false,
    })
    return code === 0
  } catch (_) {
    return false
  }
}

export async function getGitState(): Promise<GitRepoState | null> {
  try {
    const [commitHash, branchName, remoteUrl, isHeadOnRemote, isClean, worktreeCount] =
      await Promise.all([
        getHead(),
        getBranch(),
        getRemoteUrl(),
        getIsHeadOnRemote(),
        getIsClean(),
        getWorktreeCount(),
      ])

    return {
      commitHash,
      branchName,
      remoteUrl,
      isHeadOnRemote,
      isClean,
      worktreeCount,
    }
  } catch (_) {
    // 静默失败——git 状态获取是尽力而为的
    return null
  }
}

export async function getGithubRepo(): Promise<string | null> {
  const { parseGitRemote } = await import('../git/detectRepository.js')
  const remoteUrl = await getRemoteUrl()
  if (!remoteUrl) {
    logForDebugging('Local GitHub repo: unknown')
    return null
  }
  // 仅返回 github.com 的结果——调用方（如 issue 提交）
  // 假定结果是 github.com 仓库。
  const parsed = parseGitRemote(remoteUrl)
  if (parsed && parsed.host === 'github.com') {
    const result = `${parsed.owner}/${parsed.name}`
    logForDebugging(`Local GitHub repo: ${result}`)
    return result
  }
  logForDebugging('Local GitHub repo: unknown')
  return null
}

// 未跟踪文件捕获的大小限制
const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024 // 每个文件 500MB
const MAX_TOTAL_SIZE_BYTES = 5 * 1024 * 1024 * 1024 // 总计 5GB
const MAX_FILE_COUNT = 20000

// 用于二进制检测和内容复用的初始读取缓冲区。64KB 可在一次读取中覆盖
// 大多数源文件；isBinaryContent() 内部仅扫描前 8KB 进行二进制启发式判断，
// 所以额外的字节纯粹是为了在文件是文本时避免第二次读取。
const SNIFF_BUFFER_SIZE = 64 * 1024

/**
 * 查找最佳远程分支作为基准。
 * 优先级：跟踪分支 > origin/main > origin/staging > origin/master
 */
export async function findRemoteBase(): Promise<string | null> {
  // 第一次尝试：获取当前分支的跟踪分支
  const { stdout: trackingBranch, code: trackingCode } = await execFileNoThrow(
    gitExe(),
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    { preserveOutputOnError: false },
  )

  if (trackingCode === 0 && trackingBranch.trim()) {
    return trackingBranch.trim()
  }

  // 第二次尝试：检查 origin 上的常见默认分支名
  const { stdout: remoteRefs, code: remoteCode } = await execFileNoThrow(
    gitExe(),
    ['remote', 'show', 'origin', '--', 'HEAD'],
    { preserveOutputOnError: false },
  )

  if (remoteCode === 0) {
    // 从 remote show 输出中解析默认分支
    const match = remoteRefs.match(/HEAD branch: (\S+)/)
    if (match?.[1]) {
      return `origin/${match[1]}`
    }
  }

  // 第三次尝试：检查哪些常见分支存在
  const candidates = ['origin/main', 'origin/staging', 'origin/master']
  for (const candidate of candidates) {
    const { code } = await execFileNoThrow(gitExe(), ['rev-parse', '--verify', candidate], {
      preserveOutputOnError: false,
    })
    if (code === 0) {
      return candidate
    }
  }

  return null
}

/**
 * 通过查找 <gitDir>/shallow 来检查是否为浅克隆。
 */
function isShallowClone(): Promise<boolean> {
  return isShallowCloneFs()
}

/**
 * 捕获未跟踪文件（git diff 不包含它们）。
 * 遵循大小限制并跳过二进制文件。
 */
async function captureUntrackedFiles(): Promise<Array<{ path: string; content: string }>> {
  const { stdout, code } = await execFileNoThrow(
    gitExe(),
    ['ls-files', '--others', '--exclude-standard'],
    { preserveOutputOnError: false },
  )

  const trimmed = stdout.trim()
  if (code !== 0 || !trimmed) {
    return []
  }

  const files = trimmed.split('\n').filter(Boolean)
  const result: Array<{ path: string; content: string }> = []
  let totalSize = 0

  for (const filePath of files) {
    // 检查文件数量限制
    if (result.length >= MAX_FILE_COUNT) {
      logForDebugging(`Untracked file capture: reached max file count (${MAX_FILE_COUNT})`)
      break
    }

    // 通过扩展名跳过二进制文件——零 I/O
    if (hasBinaryExtension(filePath)) {
      continue
    }

    try {
      const stats = await stat(filePath)
      const fileSize = stats.size

      // 跳过超过单文件大小限制的文件
      if (fileSize > MAX_FILE_SIZE_BYTES) {
        logForDebugging(
          `Untracked file capture: skipping ${filePath} (exceeds ${MAX_FILE_SIZE_BYTES} bytes)`,
        )
        continue
      }

      // 检查总大小限制
      if (totalSize + fileSize > MAX_TOTAL_SIZE_BYTES) {
        logForDebugging(
          `Untracked file capture: reached total size limit (${MAX_TOTAL_SIZE_BYTES} bytes)`,
        )
        break
      }

      // 空文件——无需打开
      if (fileSize === 0) {
        result.push({ path: filePath, content: '' })
        continue
      }

      // 对最多 SNIFF_BUFFER_SIZE 字节进行二进制嗅探。即使 MAX_FILE_SIZE_BYTES
      // 允许到 500MB，二进制文件读取也限制在 SNIFF_BUFFER_SIZE。
      // 如果文件适合嗅探缓冲区，我们将其复用为内容；对于较大的文本文件，
      // 回退到带编码的 readFile，让运行时直接解码为字符串，
      // 而不在 JS 中实体化全尺寸 Buffer。
      const sniffSize = Math.min(SNIFF_BUFFER_SIZE, fileSize)
      const fd = await open(filePath, 'r')
      try {
        const sniffBuf = Buffer.alloc(sniffSize)
        const { bytesRead } = await fd.read(sniffBuf, 0, sniffSize, 0)
        const sniff = sniffBuf.subarray(0, bytesRead)

        if (isBinaryContent(sniff)) {
          continue
        }

        let content: string
        if (fileSize <= sniffSize) {
          // 嗅探已覆盖整个文件
          content = sniff.toString('utf-8')
        } else {
          // 带编码的 readFile 直接解码为字符串，避免全尺寸 Buffer
          // 与解码后的字符串并存。额外的 open/close 比大文件
          // 的峰值内存翻倍要划算。
          content = await readFile(filePath, 'utf-8')
        }

        result.push({ path: filePath, content })
        totalSize += fileSize
      } finally {
        await fd.close()
      }
    } catch (err) {
      // 跳过无法读取的文件
      logForDebugging(`Failed to read untracked file ${filePath}: ${err}`)
    }
  }

  return result
}

/**
 * 为 issue 提交保留 git 状态。
 * 使用远程基准以获得更稳定的回放能力。
 *
 * 处理的边界情况：
 * - Detached HEAD：直接回退到与默认分支的 merge-base
 * - 无远程：远程字段返回 null，使用仅 HEAD 模式
 * - 浅克隆：回退到仅 HEAD 模式
 */
export async function preserveGitStateForIssue(): Promise<PreservedGitState | null> {
  try {
    const isGit = await getIsGit()
    if (!isGit) {
      return null
    }

    // 检查是否为浅克隆——回退到更简单的模式
    if (await isShallowClone()) {
      logForDebugging('Shallow clone detected, using HEAD-only mode for issue')
      const [{ stdout: patch }, untrackedFiles] = await Promise.all([
        execFileNoThrow(gitExe(), ['diff', 'HEAD']),
        captureUntrackedFiles(),
      ])
      return {
        remote_base_sha: null,
        remote_base: null,
        patch: patch || '',
        untracked_files: untrackedFiles,
        format_patch: null,
        head_sha: null,
        branch_name: null,
      }
    }

    // 查找最佳远程基准
    const remoteBase = await findRemoteBase()

    if (!remoteBase) {
      // 未找到远程——使用仅 HEAD 模式
      logForDebugging('No remote found, using HEAD-only mode for issue')
      const [{ stdout: patch }, untrackedFiles] = await Promise.all([
        execFileNoThrow(gitExe(), ['diff', 'HEAD']),
        captureUntrackedFiles(),
      ])
      return {
        remote_base_sha: null,
        remote_base: null,
        patch: patch || '',
        untracked_files: untrackedFiles,
        format_patch: null,
        head_sha: null,
        branch_name: null,
      }
    }

    // 获取与远程的 merge-base
    const { stdout: mergeBase, code: mergeBaseCode } = await execFileNoThrow(
      gitExe(),
      ['merge-base', 'HEAD', remoteBase],
      { preserveOutputOnError: false },
    )

    if (mergeBaseCode !== 0 || !mergeBase.trim()) {
      // merge-base 失败——回退到仅 HEAD 模式
      logForDebugging('Merge-base failed, using HEAD-only mode for issue')
      const [{ stdout: patch }, untrackedFiles] = await Promise.all([
        execFileNoThrow(gitExe(), ['diff', 'HEAD']),
        captureUntrackedFiles(),
      ])
      return {
        remote_base_sha: null,
        remote_base: null,
        patch: patch || '',
        untracked_files: untrackedFiles,
        format_patch: null,
        head_sha: null,
        branch_name: null,
      }
    }

    const remoteBaseSha = mergeBase.trim()

    // 以下 5 个命令仅依赖 remoteBaseSha——并行运行。
    // 串行约 5×90ms → 并行约 90ms（在 Bun native 上，用于 /issue 和 /share）。
    const [
      { stdout: patch },
      untrackedFiles,
      { stdout: formatPatchOut, code: formatPatchCode },
      { stdout: headSha },
      { stdout: branchName },
    ] = await Promise.all([
      // 从 merge-base 到当前状态的 patch（包含已暂存的变更）
      execFileNoThrow(gitExe(), ['diff', remoteBaseSha]),
      // 单独捕获未跟踪文件
      captureUntrackedFiles(),
      // merge-base 与 HEAD 之间已提交变更的 format-patch。
      // 保留实际的提交链（作者、日期、消息），使回放容器能够用真实提交
      // 而非压缩 diff 来重建分支。使用 --stdout 将所有 patch 输出为单个文本流。
      execFileNoThrow(gitExe(), ['format-patch', `${remoteBaseSha}..HEAD`, '--stdout']),
      // 用于回放的 HEAD SHA
      execFileNoThrow(gitExe(), ['rev-parse', 'HEAD']),
      // 用于回放的分支名
      execFileNoThrow(gitExe(), ['rev-parse', '--abbrev-ref', 'HEAD']),
    ])

    let formatPatch: string | null = null
    if (formatPatchCode === 0 && formatPatchOut && formatPatchOut.trim()) {
      formatPatch = formatPatchOut
    }

    const trimmedBranch = branchName?.trim()
    return {
      remote_base_sha: remoteBaseSha,
      remote_base: remoteBase,
      patch: patch || '',
      untracked_files: untrackedFiles,
      format_patch: formatPatch,
      head_sha: headSha?.trim() || null,
      branch_name: trimmedBranch && trimmedBranch !== 'HEAD' ? trimmedBranch : null,
    }
  } catch (err) {
    logError(err)
    return null
  }
}

/**
 * 检查当前工作目录是否看起来像一个裸 git 仓库，
 * 或者是否被操纵成看起来像裸仓库（沙箱逃逸攻击向量）。
 *
 * 安全性：Git 的 is_git_directory() 函数（setup.c:417-455）检查：
 * 1. HEAD 文件——必须是有效的引用
 * 2. objects/ 目录——必须存在且可访问
 * 3. refs/ 目录——必须存在且可访问
 *
 * 如果这三者都存在于当前目录中（而非 .git 子目录中），
 * Git 会将当前目录视为裸仓库，并执行 cwd 中的
 * hooks/pre-commit 和其他钩子脚本。
 *
 * 攻击场景：
 * 1. 攻击者在 cwd 中创建 HEAD、objects/、refs/ 和 hooks/pre-commit
 * 2. 攻击者删除或损坏 .git/HEAD 使正常 git 目录无效
 * 3. 当用户运行 'git status' 时，Git 将 cwd 视为 git 目录并运行钩子
 *
 * @returns 如果 cwd 看起来像裸仓库/被利用的 git 目录则返回 true
 */
/* eslint-disable custom-rules/no-sync-fs -- sync permission-eval check */
export function isCurrentDirectoryBareGitRepo(): boolean {
  const fs = getFsImplementation()
  const cwd = getCwd()

  const gitPath = join(cwd, '.git')
  try {
    const stats = fs.statSync(gitPath)
    if (stats.isFile()) {
      // worktree/子模块——Git 跟随 gitdir 引用
      return false
    }
    if (stats.isDirectory()) {
      const gitHeadPath = join(gitPath, 'HEAD')
      try {
        // 安全性：检查 isFile()。攻击者将 .git/HEAD 创建为目录
        // 可以通过 statSync 检查，但 Git 的 setup_git_directory
        // 会拒绝它（不是有效的 HEAD）并回退到 cwd 发现。
        if (fs.statSync(gitHeadPath).isFile()) {
          // 正常仓库——.git/HEAD 有效，Git 不会回退到 cwd
          return false
        }
        // .git/HEAD 存在但不是普通文件——继续向下
      } catch {
        // .git 存在但没有 HEAD——继续到裸仓库检查
      }
    }
  } catch {
    // 不存在 .git——继续到裸仓库指标检查
  }

  // 未找到有效的 .git/HEAD。检查 cwd 是否有裸 git 仓库指标。
  // 谨慎处理——如果在没有有效 .git 引用的情况下存在任何一个指标就标记。
  // 每个指标单独 try/catch，避免一个错误遮蔽另一个。
  try {
    if (fs.statSync(join(cwd, 'HEAD')).isFile()) {
      return true
    }
  } catch {
    // 无 HEAD
  }
  try {
    if (fs.statSync(join(cwd, 'objects')).isDirectory()) {
      return true
    }
  } catch {
    // 无 objects/
  }
  try {
    if (fs.statSync(join(cwd, 'refs')).isDirectory()) {
      return true
    }
  } catch {
    // 无 refs/
  }
  return false
}
/* eslint-enable custom-rules/no-sync-fs */
