import { writeSync } from 'node:fs'
import chalk from 'chalk'
import memoize from 'lodash-es/memoize.js'
import { onExit } from 'signal-exit'
import type { ExitReason } from 'src/types/index.js'
import { getIsInteractive } from 'src/bootstrap/runtime/runtimeContext.js'
import { isSessionPersistenceDisabled } from 'src/bootstrap/runtime/runtimeContext.js'
import { getIsScrollDraining } from 'src/bootstrap/runtime/runtimeContext.js'
import { getLastMainRequestId } from 'src/bootstrap/runtime/runtimeContext.js'
import { getSessionId } from 'src/bootstrap/runtime/runtimeContext.js'
import { tSync } from '../../i18n/index.js'
import instances from '../../ink/instances.js'
import { DISABLE_KITTY_KEYBOARD, DISABLE_MODIFY_OTHER_KEYS } from '../../ink/termio/csi.js'
import {
  DBP,
  DFE,
  DISABLE_MOUSE_TRACKING,
  EXIT_ALT_SCREEN,
  SHOW_CURSOR,
} from '../../ink/termio/dec.js'
import {
  CLEAR_ITERM2_PROGRESS,
  CLEAR_TAB_STATUS,
  CLEAR_TERMINAL_TITLE,
  supportsTabStatus,
  wrapForMultiplexer,
} from '../../ink/termio/osc.js'
import { shutdownDatadog } from '../../services/analytics/datadog.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { shutdownZyEventLogging } from '../../services/analytics/zyEventLogger.js'
import type { AppState } from '../../state/AppStateStore.js'
import { runCleanupFunctions } from '../../services/cleanup/cleanupRegistry.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { logForDiagnosticsNoPII } from '../../services/telemetry/diagLogs.js'
import { isEnvTruthy } from '../../services/infra/envUtils.js'
import { getCurrentSessionTitle, sessionIdExists } from '../../services/sessionStorage.js'
import { sleep } from '../../utils/sleep.js'
import { profileReport } from '../../services/telemetry/startupProfiler.js'

/**
 * 进程退出前同步清理终端模式。
 * 确保终端转义序列（Kitty 键盘、焦点报告等）被正确禁用，
 * 即使 React 的 componentWillUnmount 来不及运行。
 * 使用 writeSync 确保写入在退出前完成。
 *
 * 我们无条件发送所有禁用序列，因为：
 * 1. 终端检测并不总是正确（如在 tmux、screen 中）
 * 2. 这些序列在不支持的终端上是无操作
 * 3. 未能禁用会使终端处于损坏状态
 */
/* eslint-disable custom-rules/no-sync-fs -- 必须同步才能在 process.exit 前刷新 */
function cleanupTerminalModes(): void {
  if (!process.stdout.isTTY) {
    return
  }

  try {
    // 优先禁用鼠标追踪，在 React 卸载树遍历之前。
    // 终端需要一个往返来处理这个并停止发送
    // 事件；现在做（而不是卸载后）能在卸载忙碌时争取时间。
    // 否则事件会在 cooked 模式清理期间到达，要么回显到屏幕要么泄漏到 shell。
    writeSync(1, DISABLE_MOUSE_TRACKING)
    // 优先退出备用屏幕，这样 printResumeHint()（以及下面所有序列）
    // 会落在主缓冲区。
    //
    // 直接卸载 Ink 而不是自己写 EXIT_ALT_SCREEN。
    // Ink 用 signal-exit 注册了卸载，否则它会在 forceExit() → process.exit()
    // 中再次运行。允许发生会有两个问题：
    //   1. 如果我们在这里写 1049l 而卸载稍后又写一次，第二次会触发另一个
    //      DECRC —— 光标跳回恢复提示上方，shell 提示落在错误的行。
    //   2. unmount() 的 onRender() 必须在 altScreenActive=true（备用屏幕
    //      光标计算）且在备用缓冲区上运行。这里先退出备用屏幕会让
    //      onRender() 把 REPL 帧涂到主缓冲区。
    // 现在调用 unmount() 在备用缓冲区做最后一次渲染，取消订阅
    // signal-exit，并恰好写一次 1049l。
    const inst = instances.get(process.stdout)
    if (inst?.isAltScreenActive) {
      try {
        inst.unmount()
      } catch {
        // 协调器/渲染抛出 —— 回退到手动退出备用屏幕，
        // 以便 printResumeHint 仍能命中主缓冲区。
        writeSync(1, EXIT_ALT_SCREEN)
      }
    } else if (inst) {
      // 非备用屏幕：卸载 Ink，以便其最后一帧（状态栏、进度）
      // 在 printResumeHint() 写入 stdout 前被清除。
      try {
        inst.unmount()
      } catch {
        // 忽略 —— 进程正在退出
      }
    }
    // 捕获卸载树遍历期间到达的事件。
    // 下面的 detachForShutdown() 也会排空。
    inst?.drainStdin()
    // 将 Ink 实例标记为已卸载，这样 signal-exit 的延迟 ink.unmount()
    // 会提前返回，而不是发送冗余的 EXIT_ALT_SCREEN 序列
    //（来自其 writeSync 清理块 + AlternateScreen 的卸载清理）。
    // 那些冗余序列会在 printResumeHint() 之后到达，并通过恢复保存的
    // 光标位置破坏 tmux（及可能其他终端）上的恢复提示。
    // 安全跳过完整卸载：本函数已发送所有终端重置序列，且进程正在退出。
    inst?.detachForShutdown()
    // 禁用扩展按键报告 —— 始终发送两者，因为终端
    // 会静默忽略它们不实现的那一个
    writeSync(1, DISABLE_MODIFY_OTHER_KEYS)
    writeSync(1, DISABLE_KITTY_KEYBOARD)
    // 禁用焦点事件 (DECSET 1004)
    writeSync(1, DFE)
    // 禁用括号粘贴模式
    writeSync(1, DBP)
    // 显示光标
    writeSync(1, SHOW_CURSOR)
    // 清除 iTerm2 进度条 —— 防止返回终端标签页时残留的进度指示器导致铃声
    writeSync(1, CLEAR_ITERM2_PROGRESS)
    // 清除标签状态 (OSC 21337)，以免残留的圆点滞留
    if (supportsTabStatus()) {
      writeSync(1, wrapForMultiplexer(CLEAR_TAB_STATUS))
    }
    // 清除终端标题，这样标签页不会显示过期的会话信息。
    // 尊重 ZY_CODE_DISABLE_TERMINAL_TITLE —— 如果用户选择退出标题变更，
    // 退出时也不清除其现有标题。
    if (!isEnvTruthy(process.env.ZY_CODE_DISABLE_TERMINAL_TITLE)) {
      if (process.platform === 'win32') {
        process.title = ''
      } else {
        writeSync(1, CLEAR_TERMINAL_TITLE)
      }
    }
  } catch {
    // 终端可能已消失（如关闭终端后的 SIGHUP）。
    // 忽略写入错误，因为我们正在退出。
  }
}

let resumeHintPrinted = false

/**
 * 打印关于如何恢复会话的提示。
 * 仅在交互式会话且启用持久化时显示。
 */
function printResumeHint(): void {
  // 只打印一次（failsafe 定时器可能在正常关闭后再次调用此函数）
  if (resumeHintPrinted) {
    return
  }
  // 仅在 TTY、交互式会话且启用持久化时显示
  if (process.stdout.isTTY && getIsInteractive() && !isSessionPersistenceDisabled()) {
    try {
      const sessionId = getSessionId()
      // 如果会话文件不存在则不显示恢复提示（如 `zycode update` 等子命令）
      if (!sessionIdExists(sessionId)) {
        return
      }
      const customTitle = getCurrentSessionTitle(sessionId)

      // 有自定义标题则使用，否则回退到会话 ID
      let resumeArg: string
      if (customTitle) {
        // 用双引号包裹，先转义反斜杠再转义引号
        const escaped = customTitle.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        resumeArg = `"${escaped}"`
      } else {
        resumeArg = sessionId
      }

      // alt screen 退出后光标位置不确定，unmount diff 可能在当前行和下方
      // 残留输入框边框/状态栏内容。每行写入前先 \r\x1b[2K 清掉整行（避免
      // "zy --resume ..."后面残留 prompt 输入框底边的 ────），结尾再 \x1b[J
      // 清掉光标以下所有残留行。
      const line1 = chalk.dim(tSync('shutdown.resumeHint'))
      const line2 = chalk.dim(`zycode --resume ${resumeArg}`)
      writeSync(1, `\r\x1b[2K${line1}\n\r\x1b[2K${line2}\n\x1b[J`)
      resumeHintPrinted = true
    } catch {
      // 忽略写入错误
    }
  }
}
/* eslint-enable custom-rules/no-sync-fs */

/**
 * 强制进程退出，处理终端已消失的情况。
 * 当终端/PTY 关闭（如 SIGHUP）时，process.exit() 可能会因为
 * Bun 尝试向已死的文件描述符刷新 stdout 而抛出 EIO 错误。
 * 这种情况下回退到 SIGKILL，它总是有效的。
 */
function forceExit(exitCode: number): never {
  // 清除 failsafe 定时器，因为我们现在要退出了
  if (failsafeTimer !== undefined) {
    clearTimeout(failsafeTimer)
    failsafeTimer = undefined
  }
  // 最后排空 stdin，就在退出前。cleanupTerminalModes() 早早发送了
  // DISABLE_MOUSE_TRACKING，但终端往返加上已在飞行中的事件意味着
  // 在此期间和现在之间的几秒异步清理期间可能有字节到达。这里排空能捕获它们。
  // 使用 Ink 类方法（而不是独立的 drainStdin()），这样我们排空的是
  // 实例的 stdin —— 当 process.stdin 是管道时，getStdinOverride() 打开
  // /dev/tty 作为真实输入流，类方法知道它；独立函数默认用
  // process.stdin，在 isTTY=false 时会提前返回。
  try {
    instances.get(process.stdout)?.drainStdin()
  } catch {
    // 终端可能已消失 (SIGHUP)。忽略 —— 我们马上就要退出。
  }
  try {
    process.exit(exitCode)
  } catch (e) {
    // process.exit() 抛出。测试中它被模拟为抛出 —— 重新抛出以便测试看到。
    // 生产环境中，可能是死终端的 EIO —— 使用 SIGKILL。
    if ((process.env.NODE_ENV as string) === 'test') {
      throw e
    }
    // 回退到 SIGKILL，它不尝试刷新任何东西。
    process.kill(process.pid, 'SIGKILL')
  }
  // 测试中 process.exit 可能被模拟为返回而不是退出。
  // 生产环境中，我们永远不该到达这里。
  if ((process.env.NODE_ENV as string) !== 'test') {
    throw new Error('unreachable')
  }
  // TypeScript 技巧：转为 never，因为我们知道这只在测试中发生
  // 此时 mock 返回而不是退出
  return undefined as never
}

/**
 * 设置全局信号处理器以实现优雅关闭
 */
export const setupGracefulShutdown = memoize(() => {
  // 规避 Bun bug：process.removeListener(sig, fn) 会重置该信号的内核 sigaction，
  // 即使其他 JS 监听器仍存在 —— 信号随即回退到默认动作（终止），导致我们的
  // process.on('SIGTERM') 处理器永不运行。
  //
  // 触发条件：任何短命的 signal-exit v4 订阅者（如 execa 的子进程，
  // 或卸载的 Ink 实例）。当其取消订阅运行且是最后一个 v4 订阅者时，
  // v4.unload() 会对其列表中的每个信号（SIGTERM、SIGINT、SIGHUP……）调用
  // removeListener，触发 Bun bug 并在内核层面清除我们的处理器。
  //
  // 修复：注册一个永不取消订阅的空 onExit 回调，钉住 signal-exit v4 的加载。
  // 这保持 v4 内部 emitter 计数 > 0，使 unload() 永不运行，removeListener
  // 永不被调用。Node.js 下无害 —— 钉住也确保 signal-exit 的 process.exit
  // hook 为 Ink 清理保持活跃。
  onExit(() => {})

  process.on('SIGINT', () => {
    // 在 print 模式下，print.ts 注册了自己的 SIGINT 处理器来中止
    // 正在进行的查询并调用 gracefulShutdown(0)；这里跳过以
    // 避免与其竞争。仅检查 print 模式 —— 其他非交互式
    // 会话（--sdk-url、--init-only、非 TTY）没有注册自己的
    // SIGINT 处理器，需要运行 gracefulShutdown。
    if (process.argv.includes('-p') || process.argv.includes('--print')) {
      return
    }
    logForDiagnosticsNoPII('info', 'shutdown_signal', { signal: 'SIGINT' })
    void gracefulShutdown(0)
  })
  process.on('SIGTERM', () => {
    logForDiagnosticsNoPII('info', 'shutdown_signal', { signal: 'SIGTERM' })
    void gracefulShutdown(143) // SIGTERM 的退出码 143 (128 + 15)
  })
  if (process.platform !== 'win32') {
    process.on('SIGHUP', () => {
      logForDiagnosticsNoPII('info', 'shutdown_signal', { signal: 'SIGHUP' })
      void gracefulShutdown(129) // SIGHUP 的退出码 129 (128 + 1)
    })

    // 检测终端关闭但未发送 SIGHUP 时的孤儿进程。
    // macOS 收回 TTY 文件描述符而不是发信号，留下进程
    // 存活但无法读/写。定期检查 stdin 有效性。
    if (process.stdin.isTTY) {
      orphanCheckInterval = setInterval(() => {
        // 滚动排出期间跳过 —— 即使廉价检查也会消耗滚动帧需要的
        // 事件循环 tick。30s 间隔 → 错过一次无所谓。
        if (getIsScrollDraining()) {
          return
        }
        // 当 TTY 被收回时 process.stdout.writable 变为 false
        if (!process.stdout.writable || !process.stdin.readable) {
          clearInterval(orphanCheckInterval)
          logForDiagnosticsNoPII('info', 'shutdown_signal', {
            signal: 'orphan_detected',
          })
          void gracefulShutdown(129)
        }
      }, 30_000) // 每 30 秒检查一次
      orphanCheckInterval.unref() // 别只为这个检查把进程挂起
    }
  }

  // 记录未捕获异常，用于容器可观测性和分析
  // 错误名称（如 "TypeError"）非敏感 —— 可安全记录
  process.on('uncaughtException', (error) => {
    logForDiagnosticsNoPII('error', 'uncaught_exception', {
      error_name: error.name,
      error_message: error.message.slice(0, 2000),
    })
    logEvent('zy_uncaught_exception', {
      error_name: error.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  })

  // 记录未处理的 Promise 拒绝，用于容器可观测性和分析
  process.on('unhandledRejection', (reason) => {
    const errorName =
      reason instanceof Error ? reason.name : typeof reason === 'string' ? 'string' : 'unknown'
    const errorInfo =
      reason instanceof Error
        ? {
            error_name: reason.name,
            error_message: reason.message.slice(0, 2000),
            error_stack: reason.stack?.slice(0, 4000),
          }
        : { error_message: String(reason).slice(0, 2000) }
    logForDiagnosticsNoPII('error', 'unhandled_rejection', errorInfo)
    logEvent('zy_unhandled_rejection', {
      error_name: errorName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  })
})

export function gracefulShutdownSync(
  exitCode = 0,
  reason: ExitReason = 'other',
  options?: {
    getAppState?: () => AppState
    setAppState?: (f: (prev: AppState) => AppState) => void
  },
): void {
  // 设置进程自然退出时使用的退出码。注意在同步版本中也要做，
  // 以便通过检查 process.exitCode 判断是否调用了 gracefulShutdownSync。
  process.exitCode = exitCode

  pendingShutdown = gracefulShutdown(exitCode, reason, options)
    .catch((error) => {
      logForDebugging(`Graceful shutdown failed: ${error}`, { level: 'error' })
      cleanupTerminalModes()
      printResumeHint()
      forceExit(exitCode)
    })
    // 防止未处理的拒绝：forceExit 在测试模式下重新抛出，
    // 这会逃逸出上方的 .catch() 处理器成为新的拒绝。
    .catch(() => {})
}

let shutdownInProgress = false
let failsafeTimer: ReturnType<typeof setTimeout> | undefined
let orphanCheckInterval: ReturnType<typeof setInterval> | undefined
let pendingShutdown: Promise<void> | undefined

/** 检查优雅关闭是否进行中 */
export function isShuttingDown(): boolean {
  return shutdownInProgress
}

/** 重置关闭状态 —— 仅供测试使用 */
export function resetShutdownState(): void {
  shutdownInProgress = false
  resumeHintPrinted = false
  if (failsafeTimer !== undefined) {
    clearTimeout(failsafeTimer)
    failsafeTimer = undefined
  }
  pendingShutdown = undefined
}

/**
 * 返回正在进行的关闭 Promise（如果有）。仅供测试使用，
 * 以便在恢复 mock 之前等待完成。
 */
export function getPendingShutdownForTesting(): Promise<void> | undefined {
  return pendingShutdown
}

/**
 * 优雅关闭函数，排出事件循环
 */
export async function gracefulShutdown(
  exitCode = 0,
  reason: ExitReason = 'other',
  options?: {
    getAppState?: () => AppState
    setAppState?: (f: (prev: AppState) => AppState) => void
    /** 在备用屏幕退出后、forceExit 前打印到 stderr。 */
    finalMessage?: string
  },
): Promise<void> {
  if (shutdownInProgress) {
    return
  }
  shutdownInProgress = true

  // 在 failsafe 武装前解析 SessionEnd hook 预算，以便 failsafe 能随之缩放。
  // 否则，用户配置的 10s hook 预算会被 5s failsafe 静默截断（gh-32712 后续）。
  const { executeSessionEndHooks, getSessionEndHookTimeoutMs } = await import(
    '../../services/hooks.js'
  )
  const sessionEndTimeoutMs = getSessionEndHookTimeoutMs()

  // Failsafe：保证进程即使在清理挂起时也能退出（如 MCP 连接）。
  // 先运行 cleanupTerminalModes，这样挂起的清理不会让终端保持脏状态。
  // 预算 = max(5s, hook 预算 + 3.5s 清理和分析刷新的缓冲)。
  failsafeTimer = setTimeout(
    (code) => {
      cleanupTerminalModes()
      printResumeHint()
      forceExit(code)
    },
    Math.max(5000, sessionEndTimeoutMs + 3500),
    exitCode,
  )
  failsafeTimer.unref()

  // 设置进程自然退出时使用的退出码
  process.exitCode = exitCode

  // 优先退出备用屏幕并打印恢复提示，在任何异步操作之前。
  // 这确保即使进程在清理期间被杀死（如 macOS 重启时的 SIGKILL），
  // 提示也是可见的。否则恢复提示要等到清理函数、hooks 和
  // 分析刷新完成后才出现 —— 可能需要几秒钟。
  cleanupTerminalModes()
  printResumeHint()

  // 优先刷新会话数据 —— 这是最关键的清理。如果终端已死
  // (SIGHUP、SSH 断开)，hooks 和分析可能在死 TTY 或不可达网络上
  // 的 I/O 挂起，消耗 failsafe 预算。会话持久化必须在其他任何
  // 东西之前完成。
  let cleanupTimeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    const cleanupPromise = (async () => {
      try {
        await runCleanupFunctions()
      } catch {
        // 静默忽略清理错误
      }
    })()

    await Promise.race([
      cleanupPromise,
      new Promise((_, reject) => {
        cleanupTimeoutId = setTimeout((rej) => rej(new CleanupTimeoutError()), 2000, reject)
      }),
    ])
    clearTimeout(cleanupTimeoutId)
  } catch {
    // 静默处理超时和其他错误
    clearTimeout(cleanupTimeoutId)
  }

  // 执行 SessionEnd hooks。通过单一预算（ZY_CODE_SESSIONEND_HOOKS_TIMEOUT_MS，
  // 默认 1.5s）同时限制每个 hook 的默认超时和整体执行。设置中的
  // hook.timeout 受此上限约束。
  try {
    await executeSessionEndHooks(reason, {
      ...options,
      signal: AbortSignal.timeout(sessionEndTimeoutMs),
      timeoutMs: sessionEndTimeoutMs,
    })
  } catch {
    // 忽略 SessionEnd hook 异常（包括超时时的 AbortError）
  }

  // 记录启动性能，在分析关闭刷新/取消计时器前
  try {
    profileReport()
  } catch {
    // 忽略关闭期间的分析错误
  }

  // 向推理发出信号，表明此会话的缓存可以被驱逐。
  // 在分析刷新前触发，以便事件进入管道。
  const lastRequestId = getLastMainRequestId()
  if (lastRequestId) {
    logEvent('zy_cache_eviction_hint', {
      scope: 'session_end' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      last_request_id: lastRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  // 刷新分析 —— 上限 500ms。以前无界：直接 API 导出器等待所有待处理的
  // axios POST（每个 10s），吃掉全部 failsafe 预算。
  // 慢网络上丢失分析可接受；挂起退出不可接受。
  try {
    await Promise.race([Promise.all([shutdownZyEventLogging(), shutdownDatadog()]), sleep(500)])
  } catch {
    // 忽略分析关闭错误
  }

  if (options?.finalMessage) {
    try {
      // eslint-disable-next-line custom-rules/no-sync-fs -- 必须在 forceExit 前刷新
      writeSync(2, `${options.finalMessage}\n`)
    } catch {
      // stderr 可能已关闭（如 SSH 断开）。忽略写入错误。
    }
  }

  forceExit(exitCode)
}

class CleanupTimeoutError extends Error {
  constructor() {
    super('Cleanup timeout')
  }
}
