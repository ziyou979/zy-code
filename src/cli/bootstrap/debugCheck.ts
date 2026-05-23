import { isRunningWithBun } from '../../utils/bundledMode.js'

/**
 * 检测当前进程是否被 node/bun inspector 附加或通过 --inspect/--debug 标志启动。
 * 顶层调用方在内部构建之外检测到调试时直接 process.exit(1)，避免被外部
 * profiler/inspector 抓取。
 */
export function isBeingDebugged(): boolean {
  const isBun = isRunningWithBun()

  // 检查进程参数中的 inspect 标志（包括所有变体）
  const hasInspectArg = process.execArgv.some((arg) => {
    if (isBun) {
      // 注意：Bun 在单文件可执行模式下存在问题，process.argv 中的
      // 应用参数会泄漏到 process.execArgv 中（类似
      // https://github.com/oven-sh/bun/issues/11673）。如果省略此分支，
      // 会导致 --debug 模式不可用。跳过该检查没问题，因为 Bun
      // 不支持 Node.js 旧版 --debug 或 --debug-brk 标志
      return /--inspect(-brk)?/.test(arg)
    } else {
      // 在 Node.js 中，同时检查 --inspect 和旧版 --debug 标志
      return /--inspect(-brk)?|--debug(-brk)?/.test(arg)
    }
  })

  // 检查 NODE_OPTIONS 是否包含 inspect 标志
  const hasInspectEnv =
    process.env.NODE_OPTIONS && /--inspect(-brk)?|--debug(-brk)?/.test(process.env.NODE_OPTIONS)

  // 检查 inspector 是否可用且活跃（表示正在调试）
  try {
    // 动态导入更好但是异步的 —— 改用全局对象
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inspector = (global as any).require('inspector')
    const hasInspectorUrl = !!inspector.url()
    return hasInspectorUrl || hasInspectArg || hasInspectEnv
  } catch {
    // 忽略错误，回退到参数检测
    return hasInspectArg || hasInspectEnv
  }
}
