import { openSync } from 'node:fs'
import { ReadStream } from 'node:tty'
import type { RenderOptions } from '../ink/index.js'
import { isEnvTruthy } from '../services/infra/envUtils.js'
import { logError } from '../services/infra/log.js'

// 缓存的 stdin 替代输入源，每个进程只计算一次。
let cachedStdinOverride: ReadStream | undefined | null = null

/**
 * stdin 被管道占用时获取 /dev/tty 的 ReadStream。
 * 这样即使 stdin 是管道，Ink 仍可进行交互式渲染。结果在进程生命周期内缓存。
 */
function getStdinOverride(): ReadStream | undefined {
  // 已计算时直接返回缓存结果。
  if (cachedStdinOverride !== null) {
    return cachedStdinOverride
  }

  // stdin 已经是 TTY 时无需替换。
  if (process.stdin.isTTY) {
    cachedStdinOverride = undefined
    return undefined
  }

  // CI 环境中跳过。
  if (isEnvTruthy(process.env.CI)) {
    cachedStdinOverride = undefined
    return undefined
  }

  // 运行 MCP 时跳过，劫持输入会破坏 MCP 通信。
  if (process.argv.includes('mcp')) {
    cachedStdinOverride = undefined
    return undefined
  }

  // Windows 没有 /dev/tty。
  if (process.platform === 'win32') {
    cachedStdinOverride = undefined
    return undefined
  }

  // 尝试打开 /dev/tty 作为替代输入源。
  try {
    const ttyFd = openSync('/dev/tty', 'r')
    const ttyStream = new ReadStream(ttyFd)
    // 已知 /dev/tty 是 TTY，因此显式把 isTTY 设为 true。
    // 某些运行时（如 Bun 编译后的二进制）可能无法正确识别由文件描述符创建的
    // ReadStream.isTTY，因此必须显式设置。
    ttyStream.isTTY = true
    cachedStdinOverride = ttyStream
    return cachedStdinOverride
  } catch (err) {
    logError(err as Error)
    cachedStdinOverride = undefined
    return undefined
  }
}

/**
 * 返回 Ink 的基础渲染选项，并在需要时包含 stdin 替代输入源。
 * 所有 render() 调用都应使用它，以确保管道输入下仍能正常工作。
 *
 * @param exitOnCtrlC 是否在 Ctrl+C 时退出；对话框通常为 false
 */
export function getBaseRenderOptions(exitOnCtrlC: boolean = false): RenderOptions {
  const stdin = getStdinOverride()
  const options: RenderOptions = { exitOnCtrlC }
  if (stdin) {
    options.stdin = stdin
  }
  return options
}
