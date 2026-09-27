import type { ShellCommand } from '../../services/shell/shellCommand.js'

/**
 * shell 转后台会移除前台超时，因此监控单独持有截止计时器。
 * 进程结束（包括手动停止和启动失败）后立即释放，避免迟到通知。
 */
export function armMonitorDeadline(
  command: Pick<ShellCommand, 'status' | 'result' | 'kill'>,
  timeoutMs: number | null,
  onTimeout: () => void,
): void {
  if (timeoutMs === null) {
    return
  }
  const timer = setTimeout(() => {
    if (command.status !== 'running' && command.status !== 'backgrounded') {
      return
    }
    try {
      onTimeout()
    } finally {
      command.kill()
    }
  }, timeoutMs)
  timer.unref()
  void command.result.then(
    () => clearTimeout(timer),
    () => clearTimeout(timer),
  )
}
