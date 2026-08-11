/**
 * 防止 macOS 在 Zy 工作时进入睡眠。
 *
 * 使用内置的 `caffeinate` 命令创建电源断言，防止空闲睡眠。
 * 这能在 API 请求和工具执行期间保持 Mac 处于唤醒状态，
 * 避免长时间运行的操作被中断。
 *
 * caffeinate 进程以超时方式启动并定期重启。
 * 这提供了自愈行为：如果 Node 进程被 SIGKILL 杀死
 * （不运行清理处理器），孤儿 caffeinate 会在超时过期后自动退出。
 *
 * 仅在 macOS 上运行 —— 其他平台为空操作。
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { registerCleanup } from '../services/cleanup/cleanupRegistry.js'
import { logForDebugging } from '../services/infra/debug.js'

// Caffeinate 超时（秒）。进程在此时长后自动退出。
// 我们在过期前重启它以维持持续的睡眠防止。
const CAFFEINATE_TIMEOUT_SECONDS = 300 // 5 minutes

// 重启间隔 —— 在 caffeinate 过期前重启。
// 使用 4 分钟，在 5 分钟超时前留有充足缓冲。
const RESTART_INTERVAL_MS = 4 * 60 * 1000

let caffeinateProcess: ChildProcess | null = null
let restartInterval: ReturnType<typeof setInterval> | null = null
let refCount = 0
let cleanupRegistered = false

/**
 * 增加引用计数并在需要时开始防止睡眠。
 * 开始需要保持 Mac 唤醒的工作时调用。
 */
export function startPreventSleep(): void {
  refCount++

  if (refCount === 1) {
    spawnCaffeinate()
    startRestartInterval()
  }
}

/**
 * 减少引用计数并在没有更多待处理工作时允许睡眠。
 * 工作完成时调用。
 */
export function stopPreventSleep(): void {
  if (refCount > 0) {
    refCount--
  }

  if (refCount === 0) {
    stopRestartInterval()
    killCaffeinate()
  }
}

/**
 * 强制停止防止睡眠，无论引用计数。
 * 退出时用于清理。
 */
export function forceStopPreventSleep(): void {
  refCount = 0
  stopRestartInterval()
  killCaffeinate()
}

function startRestartInterval(): void {
  // 仅在 macOS 上运行
  if (process.platform !== 'darwin') {
    return
  }

  // Already running
  if (restartInterval !== null) {
    return
  }

  restartInterval = setInterval(() => {
    // Only restart if we still need sleep prevention
    if (refCount > 0) {
      logForDebugging('Restarting caffeinate to maintain sleep prevention')
      killCaffeinate()
      spawnCaffeinate()
    }
  }, RESTART_INTERVAL_MS)

  // Don't let the interval keep the Node process alive
  restartInterval.unref()
}

function stopRestartInterval(): void {
  if (restartInterval !== null) {
    clearInterval(restartInterval)
    restartInterval = null
  }
}

function spawnCaffeinate(): void {
  // 仅在 macOS 上运行
  if (process.platform !== 'darwin') {
    return
  }

  // Already running
  if (caffeinateProcess !== null) {
    return
  }

  // Register cleanup on first use to ensure caffeinate is killed on exit
  if (!cleanupRegistered) {
    cleanupRegistered = true
    registerCleanup(async () => {
      forceStopPreventSleep()
    })
  }

  try {
    // -i: 创建防止空闲睡眠的断言
    //     这是最不激进的选项 —— 显示器仍可睡眠
    // -t: 超时秒数 —— caffeinate 在此时间后自动退出
    //     如果 Node 被 SIGKILL 杀死，这提供自愈能力
    caffeinateProcess = spawn('caffeinate', ['-i', '-t', String(CAFFEINATE_TIMEOUT_SECONDS)], {
      stdio: 'ignore',
    })

    // Don't let caffeinate keep the Node process alive
    caffeinateProcess.unref()

    const thisProc = caffeinateProcess
    caffeinateProcess.on('error', (err) => {
      logForDebugging(`caffeinate spawn error: ${err.message}`)
      if (caffeinateProcess === thisProc) {
        caffeinateProcess = null
      }
    })

    caffeinateProcess.on('exit', () => {
      if (caffeinateProcess === thisProc) {
        caffeinateProcess = null
      }
    })

    logForDebugging('Started caffeinate to prevent sleep')
  } catch {
    // 静默失败 —— caffeinate 不可用或启动失败
    caffeinateProcess = null
  }
}

function killCaffeinate(): void {
  if (caffeinateProcess !== null) {
    const proc = caffeinateProcess
    caffeinateProcess = null
    try {
      // 使用 SIGKILL 立即终止 —— SIGTERM 可能会延迟
      proc.kill('SIGKILL')
      logForDebugging('Stopped caffeinate, allowing sleep')
    } catch {
      // 进程可能已退出
    }
  }
}
