import { feature } from 'bun:bundle'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readdir, readFile, stat, symlink, utimes } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import chalk from 'chalk'
import ignore from 'ignore'
import { isInITerm2 } from 'src/services/swarm/backends/detection.js'
import { saveCurrentProjectConfig } from '../config/config.js'
import { getCwd } from '../environment/cwd.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { isInternalBuild } from '../../services/infra/envUtils.js'
import { errorMessage, getErrnoCode } from '../../utils/errors.js'
import { execFileNoThrow, execFileNoThrowWithCwd } from '../shell/execFileNoThrow.js'
import { parseGitConfigValue } from '../git/gitConfigParser.js'
import {
  getCommonDir,
  readWorktreeHeadSha,
  resolveGitDir,
  resolveRef,
} from '../git/gitFilesystem.js'
import {
  findCanonicalGitRoot,
  findGitRoot,
  getBranch,
  getDefaultBranch,
  gitExe,
} from '../../services/infra/git.js'
import {
  executeWorktreeCreateHook,
  executeWorktreeRemoveHook,
  hasWorktreeCreateHook,
} from '../hooks.js'
import { containsPathTraversal } from '../../utils/path.js'
import { getPlatform } from '../shell/platform.js'
import { getInitialSettings, getRelativeSettingsFilePathForSource } from '../settings/settings.js'
import { sleep } from '../../utils/sleep.js'

const VALID_WORKTREE_SLUG_SEGMENT = /^[a-zA-Z0-9._-]+$/
const MAX_WORKTREE_SLUG_LENGTH = 64

/**
 * 校验 worktree slug，防止路径遍历和目录逃逸。
 *
 * slug 通过 path.join 拼接到 `.zy/worktrees/<slug>`，该函数会规范化 `..` 段，
 * 因此 `../../../target` 会逃逸 worktrees 目录。同样，绝对路径（以 `/` 或
 * `C:\` 开头）会完全丢弃前缀。
 *
 * 允许使用正斜杠嵌套（如 `asm/feature-foo`）；每个路径段都会独立按 allowlist
 * 校验，因此仍会拒绝 `.`、`..` 路径段和驱动器标识字符。
 *
 * 同步抛错；调用方依赖它在任何副作用（git 命令、hook 执行、chdir）前完成。
 */
export function validateWorktreeSlug(slug: string): void {
  if (slug.length > MAX_WORKTREE_SLUG_LENGTH) {
    throw new Error(
      `Invalid worktree name: must be ${MAX_WORKTREE_SLUG_LENGTH} characters or fewer (got ${slug.length})`,
    )
  }
  // 首尾的 `/` 会使 path.join 生成绝对路径或悬空路径段。拆分后逐段校验可拒绝
  // 这两种情况（空段无法通过正则），同时允许 `user/feature`。
  for (const segment of slug.split('/')) {
    if (segment === '.' || segment === '..') {
      throw new Error(`Invalid worktree name "${slug}": must not contain "." or ".." path segments`)
    }
    if (!VALID_WORKTREE_SLUG_SEGMENT.test(segment)) {
      throw new Error(
        `Invalid worktree name "${slug}": each "/"-separated segment must be non-empty and contain only letters, digits, dots, underscores, and dashes`,
      )
    }
  }
}

// 递归创建目录的辅助函数。
async function mkdirRecursive(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true })
}

/**
 * 将主仓库中的目录符号链接至 worktree，避免复制 node_modules 等大型目录
 * 导致磁盘占用膨胀。
 *
 * @param repoRootPath 主仓库根目录路径
 * @param worktreePath worktree 目录路径
 * @param dirsToSymlink 需要创建符号链接的目录名数组，如 ['node_modules']
 */
async function symlinkDirectories(
  repoRootPath: string,
  worktreePath: string,
  dirsToSymlink: string[],
): Promise<void> {
  for (const dir of dirsToSymlink) {
    // 校验目录没有逃逸仓库边界。
    if (containsPathTraversal(dir)) {
      logForDebugging(`Skipping symlink for "${dir}": path traversal detected`, { level: 'warn' })
      continue
    }

    const sourcePath = join(repoRootPath, dir)
    const destPath = join(worktreePath, dir)

    try {
      await symlink(sourcePath, destPath, 'dir')
      logForDebugging(`Symlinked ${dir} from main repository to worktree to avoid disk bloat`)
    } catch (error) {
      const code = getErrnoCode(error)
      // ENOENT：源目录尚不存在；EEXIST：目标已存在。这两种预期情况均静默跳过。
      if (code !== 'ENOENT' && code !== 'EEXIST') {
        // 非预期错误，如权限不足或平台不支持。
        logForDebugging(`Failed to symlink ${dir} (${code ?? 'unknown'}): ${errorMessage(error)}`, {
          level: 'warn',
        })
      }
    }
  }
}

export type WorktreeSession = {
  originalCwd: string
  worktreePath: string
  worktreeName: string
  worktreeBranch?: string
  originalBranch?: string
  originalHeadCommit?: string
  sessionId: string
  tmuxSessionName?: string
  hookBased?: boolean
  /** 创建 worktree 的耗时；恢复已有 worktree 时不设置。 */
  creationDurationMs?: number
  /** 是否已通过 settings.worktree.sparsePaths 应用 git sparse-checkout。 */
  usedSparsePaths?: boolean
}

let currentWorktreeSession: WorktreeSession | null = null

export function getCurrentWorktreeSession(): WorktreeSession | null {
  return currentWorktreeSession
}

/**
 * 在 --resume 时恢复 worktree 会话。调用方必须已通过 process.chdir 验证目录存在，
 * 并设置 bootstrap 状态（cwd、originalCwd）。
 */
export function restoreWorktreeSession(session: WorktreeSession | null): void {
  currentWorktreeSession = session
}

export function generateTmuxSessionName(repoPath: string, branch: string): string {
  const repoName = basename(repoPath)
  const combined = `${repoName}_${branch}`
  return combined.replace(/[/.]/g, '_')
}

type WorktreeCreateResult =
  | {
      worktreePath: string
      worktreeBranch: string
      headCommit: string
      existed: true
    }
  | {
      worktreePath: string
      worktreeBranch: string
      headCommit: string
      baseBranch: string
      existed: false
    }

// 通过环境变量禁止 git/SSH 请求凭据，以免 CLI 挂起。
// GIT_TERMINAL_PROMPT=0 禁止 git 打开 /dev/tty 请求凭据；GIT_ASKPASS=''
// 禁用 askpass GUI；stdin: 'ignore' 关闭标准输入，避免交互提示阻塞。
const GIT_NO_PROMPT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
}

function worktreesDir(repoRoot: string): string {
  return join(repoRoot, '.zy', 'worktrees')
}

// 将分支名和目录路径中的嵌套 slug（`user/feature` → `user+feature`）扁平化。
// 在任一位置嵌套都不安全：
//   - git ref：`worktree-user`（文件）与 `worktree-user/feature`（需要目录）
//     构成 git 会拒绝的 D/F 冲突。
//   - 目录：`.zy/worktrees/user/feature/` 位于 `user` worktree 内；对父级执行
//     `git worktree remove` 会删除带未提交工作的子级。
// `+` 可用于 git 分支名和文件系统路径，但不在 slug 路径段 allowlist
//（[a-zA-Z0-9._-]）中，因此该映射是单射。
function flattenSlug(slug: string): string {
  return slug.replaceAll('/', '+')
}

export function worktreeBranchName(slug: string): string {
  return `worktree-${flattenSlug(slug)}`
}

function worktreePathFor(repoRoot: string, slug: string): string {
  return join(worktreesDir(repoRoot), flattenSlug(slug))
}

/**
 * 为指定 slug 创建 git worktree；若已存在则恢复。命名 worktree 会在多次调用间
 * 复用同一路径，因此存在性检查可避免每次恢复都无条件执行可能等待凭据而挂起的
 * `git fetch`。
 */
async function getOrCreateWorktree(
  repoRoot: string,
  slug: string,
  options?: { prNumber?: number },
): Promise<WorktreeCreateResult> {
  const worktreePath = worktreePathFor(repoRoot, slug)
  const worktreeBranch = worktreeBranchName(slug)

  // 快速恢复路径：worktree 已存在时跳过 fetch 和创建。直接读取 .git 指针文件，
  // 不启动子进程也不向上遍历。即使任务本身只需 2ms，子进程 `rev-parse HEAD`
  // 也会产生约 15ms 启动开销，await 让后台 spawnSync 堆积时曾观察到 55ms。
  const existingHead = await readWorktreeHeadSha(worktreePath)
  if (existingHead) {
    return {
      worktreePath,
      worktreeBranch,
      headCommit: existingHead,
      existed: true,
    }
  }

  // 新 worktree：先 fetch 基础分支，再添加。
  await mkdir(worktreesDir(repoRoot), { recursive: true })

  const fetchEnv = { ...process.env, ...GIT_NO_PROMPT_ENV }

  let baseBranch: string
  let baseSha: string | null = null
  if (options?.prNumber) {
    const { code: prFetchCode, stderr: prFetchStderr } = await execFileNoThrowWithCwd(
      gitExe(),
      ['fetch', 'origin', `pull/${options.prNumber}/head`],
      { cwd: repoRoot, stdin: 'ignore', env: fetchEnv },
    )
    if (prFetchCode !== 0) {
      throw new Error(
        `Failed to fetch PR #${options.prNumber}: ${prFetchStderr.trim() || 'PR may not exist or the repository may not have a remote named "origin"'}`,
      )
    }
    baseBranch = 'FETCH_HEAD'
  } else {
    // 本地已有 origin/<branch> 时跳过 fetch。大型仓库（21 万文件、1600 万对象）
    // 甚至在联网前，仅扫描本地 commit-graph 就会耗时约 6–8 秒。基础分支稍旧可以接受，
    // 用户需要最新内容时可在 worktree 中 pull。resolveRef 直接读取 loose/packed ref；
    // 成功时已取得 SHA，因此也可完全跳过后续 rev-parse。
    const [defaultBranch, gitDir] = await Promise.all([getDefaultBranch(), resolveGitDir(repoRoot)])
    const originRef = `origin/${defaultBranch}`
    const originSha = gitDir
      ? await resolveRef(gitDir, `refs/remotes/origin/${defaultBranch}`)
      : null
    if (originSha) {
      baseBranch = originRef
      baseSha = originSha
    } else {
      const { code: fetchCode } = await execFileNoThrowWithCwd(
        gitExe(),
        ['fetch', 'origin', defaultBranch],
        { cwd: repoRoot, stdin: 'ignore', env: fetchEnv },
      )
      baseBranch = fetchCode === 0 ? originRef : 'HEAD'
    }
  }

  // fetch/PR-fetch 路径仍需取得 SHA；上方仅访问文件系统的 resolveRef 只覆盖
  // “origin/<branch> 已存在于本地”的情况。
  if (!baseSha) {
    const { stdout, code: shaCode } = await execFileNoThrowWithCwd(
      gitExe(),
      ['rev-parse', baseBranch],
      { cwd: repoRoot },
    )
    if (shaCode !== 0) {
      throw new Error(`Failed to resolve base branch "${baseBranch}": git rev-parse failed`)
    }
    baseSha = stdout.trim()
  }

  const sparsePaths = getInitialSettings().worktree?.sparsePaths
  const addArgs = ['worktree', 'add']
  if (sparsePaths?.length) {
    addArgs.push('--no-checkout')
  }
  // 使用 -B 而非 -b，重置已删除 worktree 目录遗留的孤立分支，
  // 每次创建可省去一次 `git branch -D` 子进程（约 15ms 启动开销）。
  addArgs.push('-B', worktreeBranch, worktreePath, baseBranch)

  const { code: createCode, stderr: createStderr } = await execFileNoThrowWithCwd(
    gitExe(),
    addArgs,
    { cwd: repoRoot },
  )
  if (createCode !== 0) {
    throw new Error(`Failed to create worktree: ${createStderr}`)
  }

  if (sparsePaths?.length) {
    // 若 sparse-checkout 或 checkout 在 --no-checkout 后失败，worktree 已注册且 HEAD
    // 已设置，但工作树为空。下次运行的快速恢复（rev-parse HEAD）仍会成功，并将损坏的
    // worktree 视为“已恢复”。因此在继续抛出错误前先将其拆除。
    const tearDown = async (msg: string): Promise<never> => {
      await execFileNoThrowWithCwd(gitExe(), ['worktree', 'remove', '--force', worktreePath], {
        cwd: repoRoot,
      })
      throw new Error(msg)
    }
    const { code: sparseCode, stderr: sparseErr } = await execFileNoThrowWithCwd(
      gitExe(),
      ['sparse-checkout', 'set', '--cone', '--', ...sparsePaths],
      { cwd: worktreePath },
    )
    if (sparseCode !== 0) {
      await tearDown(`Failed to configure sparse-checkout: ${sparseErr}`)
    }
    const { code: coCode, stderr: coErr } = await execFileNoThrowWithCwd(
      gitExe(),
      ['checkout', 'HEAD'],
      { cwd: worktreePath },
    )
    if (coCode !== 0) {
      await tearDown(`Failed to checkout sparse worktree: ${coErr}`)
    }
  }

  return {
    worktreePath,
    worktreeBranch,
    headCommit: baseSha,
    baseBranch,
    existed: false,
  }
}

/**
 * 将 .worktreeinclude 指定且被 gitignore 的文件从基础仓库复制到 worktree。
 *
 * 仅复制同时满足以下条件的文件：
 * 1. 匹配 .worktreeinclude 中的模式（使用 .gitignore 语法）
 * 2. 被 gitignore，即不由 git 跟踪
 *
 * 使用 `git ls-files --others --ignored --exclude-standard --directory` 列出
 * gitignore 条目，并将完全忽略的目录折叠为单项，避免 node_modules/ 等大型构建
 * 输出迫使程序遍历整棵树；随后在进程内通过 `ignore` 库按 .worktreeinclude
 * 模式过滤。若模式明确指向折叠目录内部路径，则再次对该目录执行限定范围的
 * `ls-files` 以展开。
 */
export async function copyWorktreeIncludeFiles(
  repoRoot: string,
  worktreePath: string,
): Promise<string[]> {
  let includeContent: string
  try {
    includeContent = await readFile(join(repoRoot, '.worktreeinclude'), 'utf-8')
  } catch {
    return []
  }

  const patterns = includeContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  if (patterns.length === 0) {
    return []
  }

  // 单次使用 --directory，将完全忽略的目录（node_modules/、.turbo/ 等）折叠为
  // 单项，而非列出其中每个文件。大型仓库中可将约 50 万项、约 7 秒降至
  // 数百项、约 100ms。
  const gitignored = await execFileNoThrowWithCwd(
    gitExe(),
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
    { cwd: repoRoot },
  )
  if (gitignored.code !== 0 || !gitignored.stdout.trim()) {
    return []
  }

  const entries = gitignored.stdout.trim().split('\n').filter(Boolean)
  const matcher = ignore().add(includeContent)

  // --directory 输出的折叠目录带尾部斜杠，其余条目均为单个文件。
  const collapsedDirs = entries.filter((e) => e.endsWith('/'))
  const files = entries.filter((e) => !e.endsWith('/') && matcher.ignores(e))

  // 边界情况：.worktreeinclude 模式指向折叠目录内部路径，例如整个
  // `config/secrets/` 均被忽略且没有已跟踪的同级项，而模式为
  // `config/secrets/api.key`。仅在模式以该目录为显式路径前缀（去掉冗余前导 `/`）、
  // 目录位于锚定 glob 的字面前缀下（如 `config/**/*.key` 会展开
  // `config/secrets/`），或目录本身匹配模式时展开。`**/` 或无锚模式会匹配
  // 已跟踪目录中的文件（已逐项列出），不为其展开所有折叠目录，否则会抵消性能收益。
  const dirsToExpand = collapsedDirs.filter((dir) => {
    if (
      patterns.some((p) => {
        const normalized = p.startsWith('/') ? p.slice(1) : p
        // 字面前缀匹配：模式以折叠目录路径开头。
        if (normalized.startsWith(dir)) {
          return true
        }
        // 锚定 glob：目录位于模式的字面（非 glob）前缀下。
        // 例如 `config/**/*.key` 的字面前缀为 `config/`，因此展开 `config/secrets/`。
        const globIdx = normalized.search(/[*?[]/)
        if (globIdx > 0) {
          const literalPrefix = normalized.slice(0, globIdx)
          if (dir.startsWith(literalPrefix)) {
            return true
          }
        }
        return false
      })
    ) {
      return true
    }
    if (matcher.ignores(dir.slice(0, -1))) {
      return true
    }
    return false
  })
  if (dirsToExpand.length > 0) {
    const expanded = await execFileNoThrowWithCwd(
      gitExe(),
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--', ...dirsToExpand],
      { cwd: repoRoot },
    )
    if (expanded.code === 0 && expanded.stdout.trim()) {
      for (const f of expanded.stdout.trim().split('\n').filter(Boolean)) {
        if (matcher.ignores(f)) {
          files.push(f)
        }
      }
    }
  }
  const copied: string[] = []

  for (const relativePath of files) {
    const srcPath = join(repoRoot, relativePath)
    const destPath = join(worktreePath, relativePath)
    try {
      await mkdir(dirname(destPath), { recursive: true })
      await copyFile(srcPath, destPath)
      copied.push(relativePath)
    } catch (e: unknown) {
      logForDebugging(`Failed to copy ${relativePath} to worktree: ${(e as Error).message}`, {
        level: 'warn',
      })
    }
  }

  if (copied.length > 0) {
    logForDebugging(`Copied ${copied.length} files from .worktreeinclude: ${copied.join(', ')}`)
  }

  return copied
}

/**
 * 新 worktree 创建后的设置：传播 settings.local.json、配置 git hook，
 * 并为目录创建符号链接。
 */
async function performPostCreationSetup(repoRoot: string, worktreePath: string): Promise<void> {
  // 将 settings.local.json 复制到 worktree 的 .zy 目录，
  // 以传播可能包含 secret 的本地设置。
  const localSettingsRelativePath = getRelativeSettingsFilePathForSource('localSettings')
  const sourceSettingsLocal = join(repoRoot, localSettingsRelativePath)
  try {
    const destSettingsLocal = join(worktreePath, localSettingsRelativePath)
    await mkdirRecursive(dirname(destSettingsLocal))
    await copyFile(sourceSettingsLocal, destSettingsLocal)
    logForDebugging(`Copied settings.local.json to worktree: ${destSettingsLocal}`)
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code !== 'ENOENT') {
      logForDebugging(`Failed to copy settings.local.json: ${(e as Error).message}`, {
        level: 'warn',
      })
    }
  }

  // 配置 worktree 使用主仓库的 hook，解决 .husky 等 git hook 使用相对路径的问题。
  const huskyPath = join(repoRoot, '.husky')
  const gitHooksPath = join(repoRoot, '.git', 'hooks')
  let hooksPath: string | null = null
  for (const candidatePath of [huskyPath, gitHooksPath]) {
    try {
      const s = await stat(candidatePath)
      if (s.isDirectory()) {
        hooksPath = candidatePath
        break
      }
    } catch {
      // 路径不存在或无法访问。
    }
  }
  if (hooksPath) {
    // 不带 --worktree 的 `git config` 写入主仓库的 .git/config，由所有 worktree
    // 共享。设置一次后，后续创建均无需修改；值已匹配时跳过子进程，省去约 14ms 启动开销。
    const gitDir = await resolveGitDir(repoRoot)
    const configDir = gitDir ? ((await getCommonDir(gitDir)) ?? gitDir) : null
    const existing = configDir
      ? await parseGitConfigValue(configDir, 'core', null, 'hooksPath')
      : null
    if (existing !== hooksPath) {
      const { code: configCode, stderr: configError } = await execFileNoThrowWithCwd(
        gitExe(),
        ['config', 'core.hooksPath', hooksPath],
        { cwd: worktreePath },
      )
      if (configCode === 0) {
        logForDebugging(`Configured worktree to use hooks from main repository: ${hooksPath}`)
      } else {
        logForDebugging(`Failed to configure hooks path: ${configError}`, {
          level: 'error',
        })
      }
    }
  }

  // 按设置选择性为目录创建符号链接，避免磁盘膨胀。
  const settings = getInitialSettings()
  const dirsToSymlink = settings.worktree?.symlinkDirectories ?? []
  if (dirsToSymlink.length > 0) {
    await symlinkDirectories(repoRoot, worktreePath, dirsToSymlink)
  }

  // 尽力复制 .worktreeinclude 指定且被 gitignore 的文件。
  await copyWorktreeIncludeFiles(repoRoot, worktreePath)

  // 上方设置的 core.hooksPath 较脆弱：husky prepare script 会在每次 `bun install`
  // 时执行 `git config core.hooksPath .husky`，将共享的 .git/config 重置为相对路径，
  // 导致各 worktree 再次解析到自己的 .husky/。attribution hook 文件不受跟踪
  //（位于 .git/info/exclude），新 worktree 中不存在。将其直接安装到 worktree
  // 的 .husky/；husky 不会删除（其安装仅做追加），非 husky 仓库则解析到共享的
  // .git/hooks/，操作具有幂等性。
  //
  // 显式传入 worktree 本地 .husky：getHooksDir 会返回上方刚设置的绝对
  // core.hooksPath（主仓库 .husky），而非 worktree 的路径；当配置为绝对路径时，
  // `git rev-parse --git-path hooks` 会原样回显配置值。
  if (feature('COMMIT_ATTRIBUTION')) {
    const worktreeHooksDir = hooksPath === huskyPath ? join(worktreePath, '.husky') : undefined
    void import('../../services/attribution/postCommitAttribution.js')
      .then((m) =>
        (m as { installPrepareCommitMsgHook: (path: string, hooksDir?: string) => Promise<void> })
          .installPrepareCommitMsgHook(worktreePath, worktreeHooksDir)
          .catch((error: unknown) => {
            logForDebugging(`Failed to install attribution hook in worktree: ${error}`)
          }),
      )
      .catch((error: unknown) => {
        // dynamic import() 本身拒绝，表示模块加载失败。上方内层 .catch 仅处理
        // installPrepareCommitMsgHook 拒绝；缺少此外层 handler 时，import 失败会成为
        // 未处理的 Promise 拒绝。
        logForDebugging(`Failed to load postCommitAttribution module: ${error}`)
      })
  }
}

/**
 * 从字符串解析 PR 引用。
 * 接受 GitHub 风格 PR URL（如 https://github.com/owner/repo/pull/123，
 * 或 https://ghe.example.com/owner/repo/pull/123 等 GHE URL）。
 * or `#N` format (e.g., #123).
 * 返回 PR 编号；字符串不是可识别的 PR 引用时返回 null。
 */
export function parsePRReference(input: string): number | null {
  // GitHub-style PR URL: https://<host>/owner/repo/pull/123 (with optional trailing slash, query, hash)
  // /pull/N 路径形态为 GitHub 特有；GitLab 使用 /-/merge_requests/N，Bitbucket
  // 使用 /pull-requests/N，因此此处匹配任意 host 是安全的。
  const urlMatch = input.match(/^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/(\d+)\/?(?:[?#].*)?$/i)
  if (urlMatch?.[1]) {
    return parseInt(urlMatch[1], 10)
  }

  // #N format
  const hashMatch = input.match(/^#(\d+)$/)
  if (hashMatch?.[1]) {
    return parseInt(hashMatch[1], 10)
  }

  return null
}

export async function isTmuxAvailable(): Promise<boolean> {
  const { code } = await execFileNoThrow('tmux', ['-V'])
  return code === 0
}

export function getTmuxInstallInstructions(): string {
  const platform = getPlatform()
  switch (platform) {
    case 'macos':
      return 'Install tmux with: brew install tmux'
    case 'linux':
    case 'wsl':
      return 'Install tmux with: sudo apt install tmux (Debian/Ubuntu) or sudo dnf install tmux (Fedora/RHEL)'
    case 'windows':
      return 'tmux is not natively available on Windows. Consider using WSL or Cygwin.'
    default:
      return 'Install tmux using your system package manager.'
  }
}

export async function createTmuxSessionForWorktree(
  sessionName: string,
  worktreePath: string,
): Promise<{ created: boolean; error?: string }> {
  const { code, stderr } = await execFileNoThrow('tmux', [
    'new-session',
    '-d',
    '-s',
    sessionName,
    '-c',
    worktreePath,
  ])

  if (code !== 0) {
    return { created: false, error: stderr }
  }

  return { created: true }
}

export async function killTmuxSession(sessionName: string): Promise<boolean> {
  const { code } = await execFileNoThrow('tmux', ['kill-session', '-t', sessionName])
  return code === 0
}

export async function createWorktreeForSession(
  sessionId: string,
  slug: string,
  tmuxSessionName?: string,
  options?: { prNumber?: number },
): Promise<WorktreeSession> {
  // 必须在下方 hook 分支前运行；hook 接收原始 slug 参数，git 分支则通过
  // path.join 从中构造路径。
  validateWorktreeSlug(slug)

  const originalCwd = getCwd()

  // 优先尝试基于 hook 创建 worktree，以支持用户配置的 VCS。
  if (hasWorktreeCreateHook()) {
    const hookResult = await executeWorktreeCreateHook(slug)
    logForDebugging(`Created hook-based worktree at: ${hookResult.worktreePath}`)

    currentWorktreeSession = {
      originalCwd,
      worktreePath: hookResult.worktreePath,
      worktreeName: slug,
      sessionId,
      tmuxSessionName,
      hookBased: true,
    }
  } else {
    // 退回 git worktree。
    const gitRoot = findGitRoot(getCwd())
    if (!gitRoot) {
      throw new Error(
        'Cannot create a worktree: not in a git repository and no WorktreeCreate hooks are configured. ' +
          'Configure WorktreeCreate/WorktreeRemove hooks in settings.json to use worktree isolation with other VCS systems.',
      )
    }

    const originalBranch = await getBranch()

    const createStart = Date.now()
    const { worktreePath, worktreeBranch, headCommit, existed } = await getOrCreateWorktree(
      gitRoot,
      slug,
      options,
    )

    let creationDurationMs: number | undefined
    if (existed) {
      logForDebugging(`Resuming existing worktree at: ${worktreePath}`)
    } else {
      logForDebugging(`Created worktree at: ${worktreePath} on branch: ${worktreeBranch}`)
      await performPostCreationSetup(gitRoot, worktreePath)
      creationDurationMs = Date.now() - createStart
    }

    currentWorktreeSession = {
      originalCwd,
      worktreePath,
      worktreeName: slug,
      worktreeBranch,
      originalBranch,
      originalHeadCommit: headCommit,
      sessionId,
      tmuxSessionName,
      creationDurationMs,
      usedSparsePaths: (getInitialSettings().worktree?.sparsePaths?.length ?? 0) > 0,
    }
  }

  // 保存到项目配置以持久化。
  saveCurrentProjectConfig((current) => ({
    ...current,
    activeWorktreeSession: currentWorktreeSession ?? undefined,
  }))

  return currentWorktreeSession
}

export async function keepWorktree(): Promise<void> {
  if (!currentWorktreeSession) {
    return
  }

  try {
    const { worktreePath, originalCwd, worktreeBranch } = currentWorktreeSession

    // 先切回原始目录。
    process.chdir(originalCwd)

    // 清除会话，但保留 worktree。
    currentWorktreeSession = null

    // 更新配置。
    saveCurrentProjectConfig((current) => ({
      ...current,
      activeWorktreeSession: undefined,
    }))

    logForDebugging(
      `Linked worktree preserved at: ${worktreePath}${worktreeBranch ? ` on branch: ${worktreeBranch}` : ''}`,
    )
    logForDebugging(`You can continue working there by running: cd ${worktreePath}`)
  } catch (error) {
    logForDebugging(`Error keeping worktree: ${error}`, {
      level: 'error',
    })
  }
}

/**
 * 最后一个 sparse worktree 删除后清理 `extensions.worktreeConfig`（对齐 CC 2.1.207）。
 * 该扩展残留在主仓 `.git/config` 时会破坏 go-git 工具（如 tea）。
 *
 * 策略：若配置了该扩展，且 `git worktree list` 中已无任何仍启用 sparse-checkout 的
 * worktree，则 `--unset extensions.worktreeConfig`。
 */
export async function maybeUnsetWorktreeConfigExtension(repoRoot: string): Promise<void> {
  const { code: getCode, stdout: getOut } = await execFileNoThrowWithCwd(
    gitExe(),
    ['config', '--local', '--get', 'extensions.worktreeConfig'],
    { cwd: repoRoot },
  )
  if (getCode !== 0 || !getOut.trim()) {
    return
  }

  const { code: listCode, stdout: listOut } = await execFileNoThrowWithCwd(
    gitExe(),
    ['worktree', 'list', '--porcelain'],
    { cwd: repoRoot },
  )
  if (listCode !== 0) {
    logForDebugging(`maybeUnsetWorktreeConfigExtension: worktree list failed`, {
      level: 'warn',
    })
    return
  }

  // porcelain: 块以 worktree <path> 开头；main worktree 无 "detached"/特殊标记但路径不同。
  // 对每个 worktree 路径，探测该 worktree 是否仍启用 sparse-checkout。
  const paths: string[] = []
  for (const line of listOut.split('\n')) {
    if (line.startsWith('worktree ')) {
      paths.push(line.slice('worktree '.length).trim())
    }
  }

  for (const wtPath of paths) {
    // sparse-checkout list 在未启用时非 0 或空；启用时会列出路径
    const { code: sparseCode, stdout: sparseOut } = await execFileNoThrowWithCwd(
      gitExe(),
      ['sparse-checkout', 'list'],
      { cwd: wtPath },
    )
    if (sparseCode === 0 && sparseOut.trim().length > 0) {
      // 仍有 worktree 使用 sparse-checkout，保留 extensions.worktreeConfig
      return
    }
  }

  const { code: unsetCode, stderr: unsetErr } = await execFileNoThrowWithCwd(
    gitExe(),
    ['config', '--local', '--unset', 'extensions.worktreeConfig'],
    { cwd: repoRoot },
  )
  if (unsetCode !== 0) {
    // --unset 在键已不存在时也可能非 0；仅记日志
    logForDebugging(
      `maybeUnsetWorktreeConfigExtension: unset failed (code=${unsetCode}): ${unsetErr}`,
      { level: 'warn' },
    )
  } else {
    logForDebugging('Cleared extensions.worktreeConfig after last sparse worktree removed')
  }
}

export async function cleanupWorktree(): Promise<void> {
  if (!currentWorktreeSession) {
    return
  }

  try {
    const { worktreePath, originalCwd, worktreeBranch, hookBased, usedSparsePaths } =
      currentWorktreeSession

    // 先切回原始目录。
    process.chdir(originalCwd)

    if (hookBased) {
      // 基于 hook 的 worktree：委托 WorktreeRemove hook 清理。
      const hookRan = await executeWorktreeRemoveHook(worktreePath)
      if (hookRan) {
        logForDebugging(`Removed hook-based worktree at: ${worktreePath}`)
      } else {
        logForDebugging(
          `No WorktreeRemove hook configured, hook-based worktree left at: ${worktreePath}`,
          { level: 'warn' },
        )
      }
    } else {
      // 基于 Git 的 worktree：使用 git worktree remove。显式指定 cwd，因为上方
      // process.chdir 不会更新 getCwd()（execFileNoThrow 默认使用的状态 CWD）。
      // 若模型 cd 到非仓库目录，不传 cwd 的 execFileNoThrow 会在此静默失败。
      const { code: removeCode, stderr: removeError } = await execFileNoThrowWithCwd(
        gitExe(),
        ['worktree', 'remove', '--force', worktreePath],
        { cwd: originalCwd },
      )

      if (removeCode !== 0) {
        logForDebugging(`Failed to remove linked worktree: ${removeError}`, {
          level: 'error',
        })
      } else {
        logForDebugging(`Removed linked worktree at: ${worktreePath}`)
        // sparse worktree 移除后尝试清理残留 worktreeConfig 扩展
        if (usedSparsePaths) {
          await maybeUnsetWorktreeConfigExtension(originalCwd)
        }
      }
    }

    // 清除会话。
    currentWorktreeSession = null

    // 更新配置。
    saveCurrentProjectConfig((current) => ({
      ...current,
      activeWorktreeSession: undefined,
    }))

    // 删除临时 worktree 分支，仅适用于 Git。
    if (!hookBased && worktreeBranch) {
      // 稍作等待，确保 git 已释放全部锁。
      await sleep(100)

      const { code: deleteBranchCode, stderr: deleteBranchError } = await execFileNoThrowWithCwd(
        gitExe(),
        ['branch', '-D', worktreeBranch],
        { cwd: originalCwd },
      )

      if (deleteBranchCode !== 0) {
        logForDebugging(`Could not delete worktree branch: ${deleteBranchError}`, {
          level: 'error',
        })
      } else {
        logForDebugging(`Deleted worktree branch: ${worktreeBranch}`)
      }
    }

    logForDebugging('Linked worktree cleaned up completely')
  } catch (error) {
    logForDebugging(`Error cleaning up worktree: ${error}`, {
      level: 'error',
    })
  }
}

/**
 * 为子代理创建轻量 worktree。复用 getOrCreateWorktree/performPostCreationSetup，
 * 但不修改全局会话状态（currentWorktreeSession、process.chdir、项目配置）。
 * 不在 git 仓库中时退回基于 hook 的创建方式。
 */
export async function createAgentWorktree(slug: string): Promise<{
  worktreePath: string
  worktreeBranch?: string
  headCommit?: string
  gitRoot?: string
  hookBased?: boolean
}> {
  validateWorktreeSlug(slug)

  // 优先尝试基于 hook 创建 worktree，以支持用户配置的 VCS。
  if (hasWorktreeCreateHook()) {
    const hookResult = await executeWorktreeCreateHook(slug)
    logForDebugging(`Created hook-based agent worktree at: ${hookResult.worktreePath}`)

    return { worktreePath: hookResult.worktreePath, hookBased: true }
  }

  // 退回 git worktree。
  // 使用 findCanonicalGitRoot 而非 findGitRoot，使 agent worktree 即使从会话
  // worktree 内创建，也始终位于主仓库 .zy/worktrees/。否则会嵌套在
  // <worktree>/.zy/worktrees/，扫描规范根目录的周期清理永远找不到它们。
  const gitRoot = findCanonicalGitRoot(getCwd())
  if (!gitRoot) {
    throw new Error(
      'Cannot create agent worktree: not in a git repository and no WorktreeCreate hooks are configured. ' +
        'Configure WorktreeCreate/WorktreeRemove hooks in settings.json to use worktree isolation with other VCS systems.',
    )
  }

  const { worktreePath, worktreeBranch, headCommit, existed } = await getOrCreateWorktree(
    gitRoot,
    slug,
  )

  if (!existed) {
    logForDebugging(`Created agent worktree at: ${worktreePath} on branch: ${worktreeBranch}`)
    await performPostCreationSetup(gitRoot, worktreePath)
  } else {
    // 更新 mtime，防止周期性过期 worktree 清理将其视为陈旧。快速恢复路径只读，
    // 会保留最初创建时间的 mtime，该时间可能已超过 30 天阈值。
    const now = new Date()
    await utimes(worktreePath, now, now)
    logForDebugging(`Resuming existing agent worktree at: ${worktreePath}`)
  }

  return { worktreePath, worktreeBranch, headCommit, gitRoot }
}

/**
 * 移除 createAgentWorktree 创建的 worktree。Git worktree 会移除目录并删除临时分支；
 * 基于 hook 的 worktree 委托 WorktreeRemove hook。Git worktree 必须传入主仓库
 * git 根目录，而非 worktree 路径，因为操作期间会删除该目录。
 */
export async function removeAgentWorktree(
  worktreePath: string,
  worktreeBranch?: string,
  gitRoot?: string,
  hookBased?: boolean,
): Promise<boolean> {
  if (hookBased) {
    const hookRan = await executeWorktreeRemoveHook(worktreePath)
    if (hookRan) {
      logForDebugging(`Removed hook-based agent worktree at: ${worktreePath}`)
    } else {
      logForDebugging(
        `No WorktreeRemove hook configured, hook-based agent worktree left at: ${worktreePath}`,
        { level: 'warn' },
      )
    }
    return hookRan
  }

  if (!gitRoot) {
    logForDebugging('Cannot remove agent worktree: no git root provided', {
      level: 'error',
    })
    return false
  }

  // 从主仓库根目录运行，而非即将删除的 worktree。
  const { code: removeCode, stderr: removeError } = await execFileNoThrowWithCwd(
    gitExe(),
    ['worktree', 'remove', '--force', worktreePath],
    { cwd: gitRoot },
  )

  if (removeCode !== 0) {
    logForDebugging(`Failed to remove agent worktree: ${removeError}`, {
      level: 'error',
    })
    return false
  }
  logForDebugging(`Removed agent worktree at: ${worktreePath}`)
  // 代理 worktree 也可能使用 sparsePaths；统一尝试清理残留扩展
  await maybeUnsetWorktreeConfigExtension(gitRoot)

  if (!worktreeBranch) {
    return true
  }

  // 从主仓库删除临时 worktree 分支。
  const { code: deleteBranchCode, stderr: deleteBranchError } = await execFileNoThrowWithCwd(
    gitExe(),
    ['branch', '-D', worktreeBranch],
    {
      cwd: gitRoot,
    },
  )

  if (deleteBranchCode !== 0) {
    logForDebugging(`Could not delete agent worktree branch: ${deleteBranchError}`, {
      level: 'error',
    })
  }
  return true
}

/**
 * AgentTool（`agent-a<7hex>`，源自 earlyAgentId.slice(0,8)）、WorkflowTool
 *（`wf_<runId>-<idx>`，其中 runId 为 randomUUID().slice(0,12)，即 8 位十六进制
 * + `-` + 3 位十六进制）及 bridgeMain（`bridge-<safeFilenameId>`）创建的一次性
 * worktree slug 模式。父进程在进程内清理前被终止（Ctrl+C、ESC、崩溃）时会遗留。
 * 精确形态模式可避免清理 `wf-myfeature` 等用户命名的 EnterWorktree slug。
 */
const EPHEMERAL_WORKTREE_PATTERNS = [
  /^agent-a[0-9a-f]{7}$/,
  /^wf_[0-9a-f]{8}-[0-9a-f]{3}-\d+$/,
  // workflowRunId 消歧前的旧版 wf-<idx> slug；保留以便 30 天扫描仍能清理旧构建遗留项。
  /^wf-\d+$/,
  // 实际 bridge slug 为 `bridge-${safeFilenameId(sessionId)}`。
  /^bridge-[A-Za-z0-9_]+(-[A-Za-z0-9_]+)*$/,
  // 模板 job worktree：job-<templateName>-<8hex>。前缀用于区分碰巧以 8 位十六进制
  // 结尾的用户命名 EnterWorktree slug。
  /^job-[a-zA-Z0-9._-]{1,55}-[0-9a-f]{8}$/,
]

/**
 * 移除早于 cutoffDate 的陈旧 agent/workflow worktree。
 *
 * Safety:
 * - 仅处理匹配临时模式的 slug，绝不处理用户命名 worktree
 * - 跳过当前会话的 worktree
 * - 失败关闭：git status 失败或显示已跟踪变更时跳过
 *   （-uno：崩溃 30 天后的 agent worktree 中，未跟踪文件属于构建产物；
 *   跳过未跟踪扫描在大型仓库中快 5–10 倍）
 * - 失败关闭：存在无法从 remote 到达的 commit 时跳过
 *
 * `git worktree remove --force` 同时处理目录和 git 内部 worktree 跟踪。
 * git 无法将路径识别为 worktree（孤立目录）时保持原样；后续 readdir 再次发现
 * 其陈旧也无害。
 */
export async function cleanupStaleAgentWorktrees(cutoffDate: Date): Promise<number> {
  const gitRoot = findCanonicalGitRoot(getCwd())
  if (!gitRoot) {
    return 0
  }

  const dir = worktreesDir(gitRoot)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return 0
  }

  const cutoffMs = cutoffDate.getTime()
  const currentPath = currentWorktreeSession?.worktreePath
  let removed = 0

  for (const slug of entries) {
    if (!EPHEMERAL_WORKTREE_PATTERNS.some((p) => p.test(slug))) {
      continue
    }

    const worktreePath = join(dir, slug)
    if (currentPath === worktreePath) {
      continue
    }

    let mtimeMs: number
    try {
      mtimeMs = (await stat(worktreePath)).mtimeMs
    } catch {
      continue
    }
    if (mtimeMs >= cutoffMs) {
      continue
    }

    // 两项检查都必须成功且输出为空。非零退出（worktree 损坏、git 无法识别等）
    // 表示应跳过，因为无法确定状态。
    // what's in there.
    const [status, unpushed] = await Promise.all([
      execFileNoThrowWithCwd(gitExe(), ['--no-optional-locks', 'status', '--porcelain', '-uno'], {
        cwd: worktreePath,
      }),
      execFileNoThrowWithCwd(
        gitExe(),
        ['rev-list', '--max-count=1', 'HEAD', '--not', '--remotes'],
        { cwd: worktreePath },
      ),
    ])
    if (status.code !== 0 || status.stdout.trim().length > 0) {
      continue
    }
    if (unpushed.code !== 0 || unpushed.stdout.trim().length > 0) {
      continue
    }

    if (await removeAgentWorktree(worktreePath, worktreeBranchName(slug), gitRoot)) {
      removed++
    }
  }

  if (removed > 0) {
    await execFileNoThrowWithCwd(gitExe(), ['worktree', 'prune'], {
      cwd: gitRoot,
    })
    logForDebugging(`cleanupStaleAgentWorktrees: removed ${removed} stale worktree(s)`)
  }
  return removed
}

/**
 * 检查 worktree 自创建以来是否有未提交变更或新 commit。工作树脏、worktree 分支
 * 在 `headCommit` 后产生 commit，或 git 命令失败时返回 true。调用方据此决定是否
 * 移除 worktree，因此采用失败关闭。
 */
export async function hasWorktreeChanges(
  worktreePath: string,
  headCommit: string,
): Promise<boolean> {
  const { code: statusCode, stdout: statusOutput } = await execFileNoThrowWithCwd(
    gitExe(),
    ['status', '--porcelain'],
    {
      cwd: worktreePath,
    },
  )
  if (statusCode !== 0) {
    return true
  }
  if (statusOutput.trim().length > 0) {
    return true
  }

  const { code: revListCode, stdout: revListOutput } = await execFileNoThrowWithCwd(
    gitExe(),
    ['rev-list', '--count', `${headCommit}..HEAD`],
    { cwd: worktreePath },
  )
  if (revListCode !== 0) {
    return true
  }
  if (parseInt(revListOutput.trim(), 10) > 0) {
    return true
  }

  return false
}

/**
 * --worktree --tmux 的快速路径 handler。创建 worktree，并 exec 进入其中运行 Zy
 * 的 tmux。cli.tsx 会在加载完整 CLI 前提前调用。
 */
export async function execIntoTmuxWorktree(args: string[]): Promise<{
  handled: boolean
  error?: string
}> {
  // 检查平台；tmux 无法在 Windows 上运行。
  if (process.platform === 'win32') {
    return {
      handled: false,
      error: 'Error: --tmux is not supported on Windows',
    }
  }

  // 检查 tmux 是否可用。
  const tmuxCheck = spawnSync('tmux', ['-V'], { encoding: 'utf-8' })
  if (tmuxCheck.status !== 0) {
    const installHint =
      process.platform === 'darwin'
        ? 'Install tmux with: brew install tmux'
        : 'Install tmux with: sudo apt install tmux'
    return {
      handled: false,
      error: `Error: tmux is not installed. ${installHint}`,
    }
  }

  // 从参数解析 worktree 名称和 tmux 模式。
  let worktreeName: string | undefined
  let forceClassicTmux = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) {
      continue
    }
    if (arg === '-w' || arg === '--worktree') {
      // 检查下一个参数存在且不是另一 flag。
      const next = args[i + 1]
      if (next && !next.startsWith('-')) {
        worktreeName = next
      }
    } else if (arg.startsWith('--worktree=')) {
      worktreeName = arg.slice('--worktree='.length)
    } else if (arg === '--tmux=classic') {
      forceClassicTmux = true
    }
  }

  // 检查 worktree 名称是否为 PR 引用。
  let prNumber: number | null = null
  if (worktreeName) {
    prNumber = parsePRReference(worktreeName)
    if (prNumber !== null) {
      worktreeName = `pr-${prNumber}`
    }
  }

  // 未提供名称时生成 slug。
  if (!worktreeName) {
    const adjectives = ['swift', 'bright', 'calm', 'keen', 'bold']
    const nouns = ['fox', 'owl', 'elm', 'oak', 'ray']
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)]
    const noun = nouns[Math.floor(Math.random() * nouns.length)]
    const suffix = Math.random().toString(36).slice(2, 6)
    worktreeName = `${adj}-${noun}-${suffix}`
  }

  // 下方通过 path.join 将 worktreeName 拼入 worktreeDir；应用会话内 worktree tool
  // 使用的同一 allowlist，使约束不受入口差异影响。
  try {
    validateWorktreeSlug(worktreeName)
  } catch (e) {
    return {
      handled: false,
      error: `Error: ${(e as Error).message}`,
    }
  }

  // 与 createWorktreeForSession() 一致：hook 优先于 git，使 WorktreeCreate hook
  // 也能为此快速路径替换 VCS 后端（anthropics/zy-code#39281）。仅在无 hook 时
  // 执行下方 Git 路径。
  let worktreeDir: string
  let repoName: string
  if (hasWorktreeCreateHook()) {
    try {
      const hookResult = await executeWorktreeCreateHook(worktreeName)
      worktreeDir = hookResult.worktreePath
    } catch (error) {
      return {
        handled: false,
        error: `Error: ${errorMessage(error)}`,
      }
    }
    repoName = basename(findCanonicalGitRoot(getCwd()) ?? getCwd())
    // biome-ignore lint/suspicious/noConsole: intentional console output
    console.log(`Using worktree via hook: ${worktreeDir}`)
  } else {
    // 获取主 git 仓库根目录，并跨 worktree 解析。
    const repoRoot = findCanonicalGitRoot(getCwd())
    if (!repoRoot) {
      return {
        handled: false,
        error: 'Error: --worktree requires a git repository',
      }
    }

    repoName = basename(repoRoot)
    worktreeDir = worktreePathFor(repoRoot, worktreeName)

    // 创建或恢复 worktree。
    try {
      const result = await getOrCreateWorktree(
        repoRoot,
        worktreeName,
        prNumber !== null ? { prNumber } : undefined,
      )
      if (!result.existed) {
        // biome-ignore lint/suspicious/noConsole: intentional console output
        console.log(`Created worktree: ${worktreeDir} (based on ${result.baseBranch})`)
        await performPostCreationSetup(repoRoot, worktreeDir)
      }
    } catch (error) {
      return {
        handled: false,
        error: `Error: ${errorMessage(error)}`,
      }
    }
  }

  // 清理为 tmux session 名称，将 / 和 . 替换为 _。
  const tmuxSessionName = `${repoName}_${worktreeBranchName(worktreeName)}`.replace(/[/.]/g, '_')

  // 构造不含 --tmux 和 --worktree 的新参数；当前已位于 worktree 中。
  const newArgs: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) {
      continue
    }
    if (arg === '--tmux' || arg === '--tmux=classic') {
      continue
    }
    if (arg === '-w' || arg === '--worktree') {
      // 跳过 flag 及其存在的值。
      const next = args[i + 1]
      if (next && !next.startsWith('-')) {
        i++ // Skip the value too
      }
      continue
    }
    if (arg.startsWith('--worktree=')) {
      continue
    }
    newArgs.push(arg)
  }

  // 获取 tmux prefix，供用户指引使用。
  let tmuxPrefix = 'C-b' // default
  const prefixResult = spawnSync('tmux', ['show-options', '-g', 'prefix'], {
    encoding: 'utf-8',
  })
  if (prefixResult.status === 0 && prefixResult.stdout) {
    const match = prefixResult.stdout.match(/prefix\s+(\S+)/)
    if (match?.[1]) {
      tmuxPrefix = match[1]
    }
  }

  // 检查 tmux prefix 是否与 Zy keybinding 冲突。
  // Zy binds: ctrl+b (task:background), ctrl+c, ctrl+d, ctrl+t, ctrl+o, ctrl+r, ctrl+s, ctrl+g, ctrl+e
  const ZyBindings = ['C-b', 'C-c', 'C-d', 'C-t', 'C-o', 'C-r', 'C-s', 'C-g', 'C-e']
  const prefixConflicts = ZyBindings.includes(tmuxPrefix)

  // 设置内部 ZY 的环境变量，以在欢迎消息中显示 tmux 信息。
  const tmuxEnv = {
    ...process.env,
    ZY_CODE_TMUX_SESSION: tmuxSessionName,
    ZY_CODE_TMUX_PREFIX: tmuxPrefix,
    ZY_CODE_TMUX_PREFIX_CONFLICTS: prefixConflicts ? '1' : '',
  }

  // 检查 session 是否已存在。
  const hasSessionResult = spawnSync('tmux', ['has-session', '-t', tmuxSessionName], {
    encoding: 'utf-8',
  })
  const sessionExists = hasSessionResult.status === 0

  // 检查当前是否已在 tmux session 内。
  const isAlreadyInTmux = Boolean(process.env.TMUX)

  // 使用 tmux control mode（-CC）原生集成 iTerm2 tab/pane，让用户可使用 iTerm2 UI，
  // 无需学习 tmux keybinding。即使在 iTerm2 中，也可用 --tmux=classic 强制传统
  // tmux。已位于 tmux 中时 control mode 没有意义，因为需要 switch-client。
  const useControlMode = isInITerm2() && !forceClassicTmux && !isAlreadyInTmux
  const tmuxGlobalArgs = useControlMode ? ['-CC'] : []

  // 使用 control mode 时输出 iTerm2 偏好设置提示。
  if (useControlMode && !sessionExists) {
    const y = chalk.yellow
    // biome-ignore lint/suspicious/noConsole: intentional user guidance
    console.log(
      `\n${y('╭─ iTerm2 Tip ────────────────────────────────────────────────────────╮')}\n` +
        `${y('│')} To open as a tab instead of a new window:                           ${y('│')}\n` +
        `${y('│')} iTerm2 > Settings > General > tmux > "Tabs in attaching window"     ${y('│')}\n` +
        `${y('╰─────────────────────────────────────────────────────────────────────╯')}\n`,
    )
  }

  // 为 zy-cli-internal 中的 ant 设置开发 pane（watch + start）。
  const isAnt = isInternalBuild()
  const isZyCliInternal = repoName === 'zy-cli-internal'
  const shouldSetupDevPanes = isAnt && isZyCliInternal && !sessionExists

  if (shouldSetupDevPanes) {
    // 创建 detached session，并在第一个 pane 中运行 Zy。
    spawnSync(
      'tmux',
      [
        'new-session',
        '-d', // detached
        '-s',
        tmuxSessionName,
        '-c',
        worktreeDir,
        '--',
        process.execPath,
        ...newArgs,
      ],
      { cwd: worktreeDir, env: tmuxEnv },
    )

    // 水平拆分并运行 watch。
    spawnSync('tmux', ['split-window', '-h', '-t', tmuxSessionName, '-c', worktreeDir], {
      cwd: worktreeDir,
    })
    spawnSync('tmux', ['send-keys', '-t', tmuxSessionName, 'bun run watch', 'Enter'], {
      cwd: worktreeDir,
    })

    // 垂直拆分并运行 start。
    spawnSync('tmux', ['split-window', '-v', '-t', tmuxSessionName, '-c', worktreeDir], {
      cwd: worktreeDir,
    })
    spawnSync('tmux', ['send-keys', '-t', tmuxSessionName, 'bun run start'], {
      cwd: worktreeDir,
    })

    // 选择运行 Zy 的第一个 pane。
    spawnSync('tmux', ['select-pane', '-t', `${tmuxSessionName}:0.0`], {
      cwd: worktreeDir,
    })

    // attach 或切换到 session。
    if (isAlreadyInTmux) {
      // 切换到同级 session，避免嵌套。
      spawnSync('tmux', ['switch-client', '-t', tmuxSessionName], {
        stdio: 'inherit',
      })
    } else {
      // attach 到 session。
      spawnSync('tmux', [...tmuxGlobalArgs, 'attach-session', '-t', tmuxSessionName], {
        stdio: 'inherit',
        cwd: worktreeDir,
      })
    }
  } else {
    // 标准行为：创建或 attach。
    if (isAlreadyInTmux) {
      // 已在 tmux 中：创建 detached session 后切换过去，作为同级 session。
      // 先检查 session 是否已存在。
      if (sessionExists) {
        // 直接切换到已有 session。
        spawnSync('tmux', ['switch-client', '-t', tmuxSessionName], {
          stdio: 'inherit',
        })
      } else {
        // 创建新的 detached session。
        spawnSync(
          'tmux',
          [
            'new-session',
            '-d', // detached
            '-s',
            tmuxSessionName,
            '-c',
            worktreeDir,
            '--',
            process.execPath,
            ...newArgs,
          ],
          { cwd: worktreeDir, env: tmuxEnv },
        )

        // 切换到新 session。
        spawnSync('tmux', ['switch-client', '-t', tmuxSessionName], {
          stdio: 'inherit',
        })
      }
    } else {
      // 不在 tmux 中：创建并 attach，保持原有行为。
      const tmuxArgs = [
        ...tmuxGlobalArgs,
        'new-session',
        '-A', // Attach if exists, create if not
        '-s',
        tmuxSessionName,
        '-c',
        worktreeDir,
        '--', // Separator before command
        process.execPath,
        ...newArgs,
      ]

      spawnSync('tmux', tmuxArgs, {
        stdio: 'inherit',
        cwd: worktreeDir,
        env: tmuxEnv,
      })
    }
  }

  return { handled: true }
}
