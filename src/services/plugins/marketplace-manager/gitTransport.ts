/**
 * ZY Code 插件的 Marketplace 管理器
 *
 * 本模块提供以下功能：
 * - 管理已知的 marketplace 源（URL、GitHub 仓库、npm 包、本地文件）
 * - 本地缓存 marketplace 清单以供离线访问
 * - 从 marketplace 条目安装插件
 * - 跟踪和更新 marketplace 配置
 *
 * 本模块管理的文件结构：
 * ~/.zy/
 *   └── plugins/
 *       ├── known_marketplaces.json    # 所有已知 marketplace 的配置
 *       └── marketplaces/              # marketplace 数据的缓存目录
 *           ├── my-marketplace.json    # 从 URL 源缓存的 marketplace
 *           └── github-marketplace/    # 从 GitHub 源克隆的仓库
 *               └── .zy-plugin/
 *                   └── marketplace.json
 */

import { basename, join } from 'node:path'
import axios from 'axios'
import { logForDebugging } from '../../utils/debug.js'
import { ConfigParseError, errorMessage, isENOENT } from '../../utils/errors.js'
import { execFileNoThrowWithCwd } from '../../shell/execFileNoThrow.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { gitExe } from '../../utils/git.js'
import {
  jsonParse,
  jsonStringify,
  writeFileSync_DEPRECATED,
} from '../../utils/slowOperations.js'
import { classifyFetchError, logPluginFetch } from '../fetchTelemetry.js'
import { type MarketplaceSource, PluginMarketplaceSchema } from '../schemas.js'
import {
  GIT_NO_PROMPT_ENV,
  extractSshHost,
  getPluginGitTimeoutMs,
  gitPull,
  isAuthenticationError,
} from './configuration.js'
/**
 * Git clone 操作（导出用于测试）
 *
 * 使用可配置的超时（默认 120 秒，通过 ZY_CODE_PLUGIN_GIT_TIMEOUT_MS 覆盖）
 * 克隆 git 仓库。为常见失败场景提供有帮助的错误消息。
 * 可选检出特定分支或标签。
 *
 * 不禁用凭据助手 — 这允许用户现有的认证设置
 * （gh auth、keychain、git-credential-store 等）为私有仓库原生工作。
 * 交互式提示仍通过 GIT_TERMINAL_PROMPT=0、GIT_ASKPASS=''、
 * stdin: 'ignore' 和 SSH 的 BatchMode=yes 防止。
 *
 * 使用 StrictHostKeyChecking=yes（而非 accept-new）：未知 SSH 主机
 * 失败关闭并给出清晰消息，而不是在首次接触时被静默信任。
 * 对于 github 源类型，预检查会自动将未知主机用户引导到 HTTPS；
 * 对于显式的 git@host:… URL，用户会看到可操作的错误。
 */
export async function gitClone(
  gitUrl: string,
  targetPath: string,
  ref?: string,
  sparsePaths?: string[],
): Promise<{ code: number; stderr: string }> {
  const useSparse = sparsePaths && sparsePaths.length > 0
  const args = [
    '-c',
    'core.sshCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes',
    'clone',
    '--depth',
    '1',
  ]

  if (useSparse) {
    // Partial clone: skip blob download until checkout, defer checkout until
    // after sparse-checkout is configured. Submodules are intentionally dropped
    // for sparse clones — sparse monorepos rarely need them, and recursing
    // submodules would defeat the partial-clone bandwidth savings.
    args.push('--filter=blob:none', '--no-checkout')
  } else {
    args.push('--recurse-submodules', '--shallow-submodules')
  }

  if (ref) {
    args.push('--branch', ref)
  }

  args.push(gitUrl, targetPath)

  const timeoutMs = getPluginGitTimeoutMs()
  logForDebugging(
    `git clone: url=${redactUrlCredentials(gitUrl)} ref=${ref ?? 'default'} timeout=${timeoutMs}ms`,
  )

  const result = await execFileNoThrowWithCwd(gitExe(), args, {
    timeout: timeoutMs,
    stdin: 'ignore',
    env: { ...process.env, ...GIT_NO_PROMPT_ENV },
  })

  // Scrub credentials from execa's error/stderr fields before any logging or
  // returning. execa's shortMessage embeds the full command line (including
  // the credentialed URL), and result.stderr may also contain it on some git
  // versions.
  const redacted = redactUrlCredentials(gitUrl)
  if (gitUrl !== redacted) {
    if (result.error) {
      result.error = result.error.replaceAll(gitUrl, redacted)
    }
    if (result.stderr) {
      result.stderr = result.stderr.replaceAll(gitUrl, redacted)
    }
  }

  if (result.code === 0) {
    if (useSparse) {
      // Configure the sparse cone, then materialize only those paths.
      // `sparse-checkout set --cone` handles both init and path selection
      // in a single step on git >= 2.25.
      const sparseResult = await execFileNoThrowWithCwd(
        gitExe(),
        ['sparse-checkout', 'set', '--cone', '--', ...sparsePaths],
        {
          cwd: targetPath,
          timeout: timeoutMs,
          stdin: 'ignore',
          env: { ...process.env, ...GIT_NO_PROMPT_ENV },
        },
      )
      if (sparseResult.code !== 0) {
        return {
          code: sparseResult.code,
          stderr: `git sparse-checkout set failed: ${sparseResult.stderr}`,
        }
      }

      const checkoutResult = await execFileNoThrowWithCwd(
        gitExe(),
        // ref was already passed to clone via --branch, so HEAD points to it;
        // if no ref, HEAD points to the remote's default branch.
        ['checkout', 'HEAD'],
        {
          cwd: targetPath,
          timeout: timeoutMs,
          stdin: 'ignore',
          env: { ...process.env, ...GIT_NO_PROMPT_ENV },
        },
      )
      if (checkoutResult.code !== 0) {
        return {
          code: checkoutResult.code,
          stderr: `git checkout after sparse-checkout failed: ${checkoutResult.stderr}`,
        }
      }
    }
    logForDebugging(`git clone succeeded: ${redactUrlCredentials(gitUrl)}`)
    return result
  }

  logForDebugging(
    `git clone failed: url=${redactUrlCredentials(gitUrl)} code=${result.code} error=${result.error ?? 'none'} stderr=${result.stderr}`,
    { level: 'warn' },
  )

  // Detect timeout kills — when execFileNoThrowWithCwd kills the process via SIGTERM,
  // stderr may only contain partial output (e.g. "Cloning into '...'") with no
  // "timed out" string. Check the error field from execa which contains the
  // timeout message.
  if (result.error?.includes('timed out')) {
    return {
      ...result,
      stderr: `Git clone timed out after ${Math.round(timeoutMs / 1000)}s. The repository may be too large for the current timeout. Set ZY_CODE_PLUGIN_GIT_TIMEOUT_MS to increase it (e.g., 300000 for 5 minutes).\n\nOriginal error: ${result.stderr}`,
    }
  }

  // Enhance error messages for common scenarios
  if (result.stderr) {
    // Host key verification failure — check FIRST, before the generic
    // 'Could not read from remote repository' catch (that string appears
    // in both stderr outputs, so order matters). OpenSSH emits
    // "Host key verification failed" for BOTH host-not-in-known_hosts and
    // host-key-has-changed; distinguish them by the key-change banner.
    if (result.stderr.includes('REMOTE HOST IDENTIFICATION HAS CHANGED')) {
      const host = extractSshHost(gitUrl)
      const removeHint = host ? `ssh-keygen -R ${host}` : 'ssh-keygen -R <host>'
      return {
        ...result,
        stderr: `SSH host key has changed (server key rotation or possible MITM). Remove the stale known_hosts entry:\n  ${removeHint}\nThen connect once manually to verify and accept the new key.\n\nOriginal error: ${result.stderr}`,
      }
    }
    if (result.stderr.includes('Host key verification failed')) {
      const host = extractSshHost(gitUrl)
      const connectHint = host ? `ssh -T git@${host}` : 'ssh -T git@<host>'
      return {
        ...result,
        stderr: `SSH host key is not in your known_hosts file. To add it, connect once manually (this will show the fingerprint for you to verify):\n  ${connectHint}\n\nOr use an HTTPS URL instead (recommended for public repos).\n\nOriginal error: ${result.stderr}`,
      }
    }

    if (
      result.stderr.includes('Permission denied (publickey)') ||
      result.stderr.includes('Could not read from remote repository')
    ) {
      return {
        ...result,
        stderr: `SSH authentication failed. Please ensure your SSH keys are configured for GitHub, or use an HTTPS URL instead.\n\nOriginal error: ${result.stderr}`,
      }
    }

    if (isAuthenticationError(result.stderr)) {
      return {
        ...result,
        stderr: `HTTPS authentication failed. Please ensure your credential helper is configured (e.g., gh auth login).\n\nOriginal error: ${result.stderr}`,
      }
    }

    if (
      result.stderr.includes('timed out') ||
      result.stderr.includes('timeout') ||
      result.stderr.includes('Could not resolve host')
    ) {
      return {
        ...result,
        stderr: `Network error or timeout while cloning repository. Please check your internet connection and try again.\n\nOriginal error: ${result.stderr}`,
      }
    }
  }

  // Fallback for empty stderr — gh-28373: user saw "Failed to clone
  // marketplace repository:" with nothing after the colon. Git CAN fail
  // without writing to stderr (stdout instead, or output swallowed by
  // credential helper / signal). execa's error field has the execa-level
  // message (command, exit code, signal); exit code is the minimum.
  if (!result.stderr) {
    return {
      code: result.code,
      stderr:
        result.error ||
        `git clone exited with code ${result.code} (no stderr output). Run with --debug to see the full command.`,
    }
  }

  return result
}

/**
 * marketplace 操作的进度回调。
 *
 * 此回调在 marketplace 操作的各个阶段（下载、git 操作、
 * 验证等）被调用，以提供用户反馈。
 *
 * 重要：实现应在内部处理错误且不抛出异常。
 * 如果回调抛出异常，它会被捕获并记录但不会中止操作。
 *
 * @param message - 要显示给用户的人类可读进度消息
 */
export type MarketplaceProgressCallback = (message: string) => void

/**
 * 安全地调用进度回调，捕获并记录任何错误。
 * 防止回调错误中止 marketplace 操作。
 *
 * @param onProgress - 要调用的进度回调
 * @param message - 传递给回调的进度消息
 */
export function safeCallProgress(
  onProgress: MarketplaceProgressCallback | undefined,
  message: string,
): void {
  if (!onProgress) {
    return
  }
  try {
    onProgress(message)
  } catch (callbackError) {
    logForDebugging(`Progress callback error: ${errorMessage(callbackError)}`, {
      level: 'warn',
    })
  }
}

/**
 * 将磁盘上的 sparse-checkout 状态与期望配置协调一致。
 *
 * 在 gitPull 之前运行以处理转换：
 * - Full→Sparse 或 SparseA→SparseB：运行 `sparse-checkout set --cone`（幂等）
 * - Sparse→Full：返回非零以便调用者回退到 rm+重新克隆。避免
 *   在 --filter=blob:none 部分克隆上执行 `sparse-checkout disable`，
 *   这会触发 monorepo 中每个 blob 的延迟获取。
 * - Full→Full（常见情况）：单个本地 `git config --get` 检查，空操作。
 *
 * 此处的失败（ENOENT、非仓库）是无害的 — gitPull 也会失败并
 * 触发克隆路径，从头建立正确状态。
 */
export async function reconcileSparseCheckout(
  cwd: string,
  sparsePaths: string[] | undefined,
): Promise<{ code: number; stderr: string }> {
  const env = { ...process.env, ...GIT_NO_PROMPT_ENV }

  if (sparsePaths && sparsePaths.length > 0) {
    return execFileNoThrowWithCwd(
      gitExe(),
      ['sparse-checkout', 'set', '--cone', '--', ...sparsePaths],
      { cwd, timeout: getPluginGitTimeoutMs(), stdin: 'ignore', env },
    )
  }

  const check = await execFileNoThrowWithCwd(gitExe(), ['config', '--get', 'core.sparseCheckout'], {
    cwd,
    stdin: 'ignore',
    env,
  })
  if (check.code === 0 && check.stdout.trim() === 'true') {
    return {
      code: 1,
      stderr:
        'sparsePaths removed from config but repository is sparse; re-cloning for full checkout',
    }
  }
  return { code: 0, stderr: '' }
}

/**
 * 从 git 仓库缓存 marketplace
 *
 * 克隆或更新包含 marketplace 数据的 git 仓库。
 * 如果仓库已存在于 cachePath，则拉取最新更改。
 * 如果拉取失败，删除目录并重新克隆。
 *
 * 仓库结构示例：
 * ```
 * my-marketplace/
 *   ├── .zy-plugin/
 *   │   └── marketplace.json    # marketplace 清单的默认位置
 *   ├── plugins/                # 插件实现
 *   └── README.md
 * ```
 *
 * @param gitUrl - 要克隆的 git URL（https 或 ssh）
 * @param cachePath - 克隆/更新仓库的本地目录路径
 * @param ref - 可选的要检出的 git 分支或标签
 * @param onProgress - 可选的报告进度的回调
 */
export async function cacheMarketplaceFromGit(
  gitUrl: string,
  cachePath: string,
  ref?: string,
  sparsePaths?: string[],
  onProgress?: MarketplaceProgressCallback,
  options?: { disableCredentialHelper?: boolean },
): Promise<void> {
  const fs = getFsImplementation()

  // Attempt incremental update; fall back to re-clone if the repo is absent,
  // stale, or otherwise not updatable. Using pull-first avoids a stat-before-operate
  // TOCTOU check: gitPull returns non-zero when cachePath is missing or has no .git.
  const timeoutSec = Math.round(getPluginGitTimeoutMs() / 1000)
  safeCallProgress(onProgress, `Refreshing marketplace cache (timeout: ${timeoutSec}s)…`)

  // Reconcile sparse-checkout config before pulling. If this requires a re-clone
  // (Sparse→Full transition) or fails (missing dir, not a repo), skip straight
  // to the rm+clone fallback.
  const reconcileResult = await reconcileSparseCheckout(cachePath, sparsePaths)
  if (reconcileResult.code === 0) {
    const pullStarted = performance.now()
    const pullResult = await gitPull(cachePath, ref, {
      disableCredentialHelper: options?.disableCredentialHelper,
      sparsePaths,
    })
    logPluginFetch(
      'marketplace_pull',
      gitUrl,
      pullResult.code === 0 ? 'success' : 'failure',
      performance.now() - pullStarted,
      pullResult.code === 0 ? undefined : classifyFetchError(pullResult.stderr),
    )
    if (pullResult.code === 0) {
      return
    }
    logForDebugging(`git pull failed, will re-clone: ${pullResult.stderr}`, {
      level: 'warn',
    })
  } else {
    logForDebugging(`sparse-checkout reconcile requires re-clone: ${reconcileResult.stderr}`)
  }

  try {
    await fs.rm(cachePath, { recursive: true })
    // rm succeeded — a stale or partially-cloned directory existed; log for diagnostics
    logForDebugging(
      `Found stale marketplace directory at ${cachePath}, cleaning up to allow re-clone`,
      { level: 'warn' },
    )
    safeCallProgress(onProgress, 'Found stale directory, cleaning up and re-cloning…')
  } catch (rmError) {
    if (!isENOENT(rmError)) {
      const rmErrorMsg = errorMessage(rmError)
      throw new Error(
        `Failed to clean up existing marketplace directory. Please manually delete the directory at ${cachePath} and try again.\n\nTechnical details: ${rmErrorMsg}`,
      )
    }
    // ENOENT — cachePath didn't exist, this is a fresh install, nothing to clean up
  }

  // Clone the repository (one attempt — no internal retry loop)
  const refMessage = ref ? ` (ref: ${ref})` : ''
  safeCallProgress(
    onProgress,
    `Cloning repository (timeout: ${timeoutSec}s): ${redactUrlCredentials(gitUrl)}${refMessage}`,
  )
  const cloneStarted = performance.now()
  const result = await gitClone(gitUrl, cachePath, ref, sparsePaths)
  logPluginFetch(
    'marketplace_clone',
    gitUrl,
    result.code === 0 ? 'success' : 'failure',
    performance.now() - cloneStarted,
    result.code === 0 ? undefined : classifyFetchError(result.stderr),
  )
  if (result.code !== 0) {
    // Clean up any partial directory created by the failed clone so the next
    // attempt starts fresh. Best-effort: if this fails, the stale dir will be
    // auto-detected and removed at the top of the next call.
    try {
      await fs.rm(cachePath, { recursive: true, force: true })
    } catch {
      // ignore
    }
    throw new Error(`Failed to clone marketplace repository: ${result.stderr}`)
  }
  safeCallProgress(onProgress, 'Clone complete, validating marketplace…')
}

/**
 * 编辑头部值以便安全记录
 *
 * @param headers - 要编辑的头部
 * @returns 值被替换为 '***REDACTED***' 的头部
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key]) => [key, '***REDACTED***']))
}

/**
 * 编辑 URL 中的用户信息（用户名:密码）以避免记录凭据。
 *
 * Marketplace URL 可能嵌入凭据（例如 GitHub PAT 在
 * `https://user:token@github.com/org/repo` 中）。调试日志和进度输出
 * 写入磁盘并可能包含在错误报告中，因此凭据必须在记录前编辑。
 *
 * 编辑 http(s) URL 中的所有凭据：
 *   https://user:token@github.com/repo → https://***:***@github.com/repo
 *   https://:token@github.com/repo     → https://:***@github.com/repo
 *   https://token@github.com/repo      → https://***@github.com/repo
 *
 * 在 http(s) 上无条件地编辑用户名和密码，因为仅通过解析无法
 * 区分 `placeholder:secret`（例如 x-access-token:ghp_...）
 * 和 `secret:placeholder`（例如 ghp_...:x-oauth-basic）。
 * 非 http(s) 协议（ssh://git@...）和非 URL 输入（`owner/repo` 简写）
 * 保持不变。
 */
export function redactUrlCredentials(urlString: string): string {
  try {
    const parsed = new URL(urlString)
    const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:'
    if (isHttp && (parsed.username || parsed.password)) {
      if (parsed.username) {
        parsed.username = '***'
      }
      if (parsed.password) {
        parsed.password = '***'
      }
      return parsed.toString()
    }
  } catch {
    // 不是有效的 URL — 原样安全
  }
  return urlString
}

/**
 * 从 URL 缓存 marketplace
 *
 * 从 URL 下载 marketplace.json 文件并本地保存。
 * 如果缓存目录结构不存在则创建它。
 *
 * marketplace.json 结构示例：
 * ```json
 * {
 *   "name": "my-marketplace",
 *   "owner": { "name": "John Doe", "email": "john@example.com" },
 *   "plugins": [
 *     {
 *       "id": "my-plugin",
 *       "name": "My Plugin",
 *       "source": "./plugins/my-plugin.json",
 *       "category": "productivity",
 *       "description": "A helpful plugin"
 *     }
 *   ]
 * }
 * ```
 *
 * @param url - 要从中下载 marketplace.json 的 URL
 * @param cachePath - 保存下载的 marketplace 的本地文件路径
 * @param customHeaders - 可选的用于认证的自定义 HTTP 头部
 * @param onProgress - 可选的报告进度的回调
 */
export async function cacheMarketplaceFromUrl(
  url: string,
  cachePath: string,
  customHeaders?: Record<string, string>,
  onProgress?: MarketplaceProgressCallback,
): Promise<void> {
  const fs = getFsImplementation()

  const redactedUrl = redactUrlCredentials(url)
  safeCallProgress(onProgress, `Downloading marketplace from ${redactedUrl}`)
  logForDebugging(`Downloading marketplace from URL: ${redactedUrl}`)
  if (customHeaders && Object.keys(customHeaders).length > 0) {
    logForDebugging(`Using custom headers: ${jsonStringify(redactHeaders(customHeaders))}`)
  }

  const headers = {
    ...customHeaders,
    // User-Agent 必须在最后以防止被覆盖（与 WebFetch 保持一致）
    'User-Agent': 'Zy-Code-Plugin-Manager',
  }

  let response
  const fetchStarted = performance.now()
  try {
    response = await axios.get(url, {
      timeout: 10000,
      headers,
    })
  } catch (error) {
    logPluginFetch(
      'marketplace_url',
      url,
      'failure',
      performance.now() - fetchStarted,
      classifyFetchError(error),
    )
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        throw new Error(
          `Could not connect to ${redactedUrl}. Please check your internet connection and verify the URL is correct.\n\nTechnical details: ${error.message}`,
        )
      }
      if (error.code === 'ETIMEDOUT') {
        throw new Error(
          `Request timed out while downloading marketplace from ${redactedUrl}. The server may be slow or unreachable.\n\nTechnical details: ${error.message}`,
        )
      }
      if (error.response) {
        throw new Error(
          `HTTP ${error.response.status} error while downloading marketplace from ${redactedUrl}. The marketplace file may not exist at this URL.\n\nTechnical details: ${error.message}`,
        )
      }
    }
    throw new Error(`Failed to download marketplace from ${redactedUrl}: ${errorMessage(error)}`)
  }

  safeCallProgress(onProgress, 'Validating marketplace data')
  // 验证响应是否为有效的 marketplace
  const result = PluginMarketplaceSchema().safeParse(response.data)
  if (!result.success) {
    logPluginFetch(
      'marketplace_url',
      url,
      'failure',
      performance.now() - fetchStarted,
      'invalid_schema',
    )
    throw new ConfigParseError(
      `Invalid marketplace schema from URL: ${result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
      redactedUrl,
      response.data,
    )
  }
  logPluginFetch('marketplace_url', url, 'success', performance.now() - fetchStarted)

  safeCallProgress(onProgress, 'Saving marketplace to cache')
  // 确保缓存目录存在
  const cacheDir = join(cachePath, '..')
  await fs.mkdir(cacheDir)

  // 写入已验证的 marketplace 文件
  writeFileSync_DEPRECATED(cachePath, jsonStringify(result.data, null, 2), {
    encoding: 'utf-8',
    flush: true,
  })
}

/**
 * 为 marketplace 源生成缓存路径
 */
export function getCachePathForSource(source: MarketplaceSource): string {
  const tempName =
    source.source === 'github'
      ? source.repo.replace('/', '-')
      : source.source === 'npm'
        ? source.package.replace('@', '').replace('/', '-')
        : source.source === 'file'
          ? basename(source.path).replace('.json', '')
          : source.source === 'directory'
            ? basename(source.path)
            : `temp_${Date.now()}`
  return tempName
}

/**
 * 使用 Zod schema 解析和验证 JSON 文件
 */
export async function parseFileWithSchema<T>(
  filePath: string,
  schema: {
    safeParse: (data: unknown) => {
      success: boolean
      data?: T
      error?: {
        issues: Array<{ path: PropertyKey[]; message: string }>
      }
    }
  },
): Promise<T> {
  const fs = getFsImplementation()
  const content = await fs.readFile(filePath, { encoding: 'utf-8' })
  let data: unknown
  try {
    data = jsonParse(content)
  } catch (error) {
    throw new ConfigParseError(
      `Invalid JSON in ${filePath}: ${errorMessage(error)}`,
      filePath,
      content,
    )
  }
  const result = schema.safeParse(data)
  if (!result.success) {
    throw new ConfigParseError(
      `Invalid schema: ${filePath} ${result.error?.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
      filePath,
      data,
    )
  }
  return result.data!
}
