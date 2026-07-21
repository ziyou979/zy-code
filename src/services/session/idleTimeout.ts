import { logForDebugging } from '../../services/infra/debug.js'
import { gracefulShutdownSync } from '../../bootstrap/lifecycle/gracefulShutdown.js'

export function createIdleTimeoutManager(isIdle: () => boolean): {
  start: () => void
  stop: () => void
} {
  const exitAfterStopDelay = process.env.ZY_CODE_EXIT_AFTER_STOP_DELAY
  const delayMs = exitAfterStopDelay ? parseInt(exitAfterStopDelay, 10) : null
  const isValidDelay = delayMs && !Number.isNaN(delayMs) && delayMs > 0

  let timer: NodeJS.Timeout | null = null
  let lastIdleTime = 0

  return {
    start() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }

      if (isValidDelay) {
        lastIdleTime = Date.now()

        timer = setTimeout(() => {
          const idleDuration = Date.now() - lastIdleTime
          if (isIdle() && idleDuration >= delayMs) {
            logForDebugging(`Exiting after ${delayMs}ms of idle time`)
            gracefulShutdownSync()
          }
        }, delayMs)
      }
    },

    stop() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}
