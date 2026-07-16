/**
 * Protocol Handler（协议处理器）
 *
 * `zy --handle-uri <url>` 的入口点。当操作系统通过 `zy-cli://` URL 调用 zy 时，
 * 本模块执行以下操作：
 *   1. 将 URI 解析为结构化的 action
 *   2. 检测用户的终端模拟器
 *   3. 在新的终端窗口中以相应参数启动 zy
 *
 * 由于操作系统直接启动二进制文件（没有关联的终端），
 * 因此本模块运行在无头环境中（无 TTY）。
 */

import { homedir } from 'node:os'
import { logForDebugging } from '../../utils/debug.js'
import { filterExistingPaths, getKnownPathsForRepo } from '../../utils/githubRepoPathMapping.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { readLastFetchTime } from './banner.js'
import { parseDeepLink } from './parseDeepLink.js'
import { MACOS_BUNDLE_ID } from './registerProtocol.js'
import { launchInTerminal } from './terminalLauncher.js'

/**
 * 处理传入的 deep link URI。
 *
 * 当 CLI 入口接收到 `--handle-uri` 参数时调用。
 * 本函数解析 URI，定位 zy 可执行文件，并在用户的终端中启动它。
 *
 * @param uri - 原始 URI 字符串（例如 "zy-cli://prompt?q=hello+world"）
 * @returns 退出码（0 = 成功）
 */
export async function handleDeepLinkUri(uri: string): Promise<number> {
  logForDebugging(`Handling deep link URI: ${uri}`)

  let action
  try {
    action = parseDeepLink(uri)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // biome-ignore lint/suspicious/noConsole: 有意的错误输出
    console.error(`Deep link error: ${message}`)
    return 1
  }

  logForDebugging(`Parsed deep link action: ${jsonStringify(action)}`)

  // 始终使用当前运行的可执行文件——不通过 PATH 查找。操作系统通过注册时
  // 固定的绝对路径（bundle 符号链接 / .desktop Exec= / 注册表命令）启动我们，
  // 我们希望在终端中启动的 Zy 使用同一个二进制文件。process.execPath 即该二进制。
  const { cwd, resolvedRepo } = await resolveCwd(action)
  // 在此跳板进程中解析 FETCH_HEAD 的时间戳，以便 main.tsx 保持无 await——
  // 启动的实例将收到一个预计算的标志，而非在自己的启动路径中执行文件系统 stat。
  const lastFetch = resolvedRepo ? await readLastFetchTime(cwd) : undefined
  const launched = await launchInTerminal(process.execPath, {
    query: action.query,
    cwd,
    repo: resolvedRepo,
    lastFetchMs: lastFetch?.getTime(),
  })
  if (!launched) {
    // biome-ignore lint/suspicious/noConsole: 有意的错误输出
    console.error(
      'Failed to open a terminal. Make sure a supported terminal emulator is installed.',
    )
    return 1
  }

  return 0
}

/**
 * 处理 zy 作为 macOS app bundle 可执行文件通过 URL scheme 启动的情况。
 * 使用 NAPI 模块从 Apple Event 中接收 URL，然后按常规流程处理。
 *
 * @returns 退出码（0 = 成功，1 = 错误，null = 非 URL 启动）
 */
export async function handleUrlSchemeLaunch(): Promise<number | null> {
  // LaunchServices 会用启动 bundle 的 ID 覆盖 __CFBundleIdentifier。
  // 这是一个精确的正向信号——当且仅当 macOS 通过 URL handler .app bundle
  // 启动我们时，该变量才会被设为我们的 bundle ID。
  // （从终端使用 `open` 命令会透传调用者的环境变量，因此 !TERM 等
  // 反向启发式方法不可靠——终端的 TERM 变量会泄露进来。）
  if (process.env.__CFBundleIdentifier !== MACOS_BUNDLE_ID) {
    return null
  }

  try {
    // @ts-expect-error 动态模块 — 无类型声明
    const { waitForUrlEvent } = (await import('url-handler-napi')) as unknown as {
      waitForUrlEvent(timeoutMs: number): string | null
    }
    const url = waitForUrlEvent(5000)
    if (!url) {
      return null
    }
    return await handleDeepLinkUri(url)
  } catch {
    // NAPI 模块不可用，或 handleDeepLinkUri 抛出异常——非 URL 启动
    return null
  }
}

/**
 * 解析启动的 Zy 实例的工作目录。
 * 优先级：显式指定的 cwd > 仓库查找（最近使用的 clone）> 用户主目录。
 * 本地未克隆的仓库不视为错误——回退到主目录，
 * 以确保引用了用户未持有仓库的 web 链接仍能打开 Zy。
 *
 * 返回解析后的 cwd，以及仓库 slug（仅当 MRU 查找命中时返回）——
 * 这样启动的实例可以显示选中了哪个 clone 及其 git 新鲜度。
 */
async function resolveCwd(action: {
  cwd?: string
  repo?: string
}): Promise<{ cwd: string; resolvedRepo?: string }> {
  if (action.cwd) {
    return { cwd: action.cwd }
  }
  if (action.repo) {
    const known = getKnownPathsForRepo(action.repo)
    const existing = await filterExistingPaths(known)
    if (existing[0]) {
      logForDebugging(`Resolved repo ${action.repo} → ${existing[0]}`)
      return { cwd: existing[0], resolvedRepo: action.repo }
    }
    logForDebugging(`No local clone found for repo ${action.repo}, falling back to home`)
  }
  return { cwd: homedir() }
}
