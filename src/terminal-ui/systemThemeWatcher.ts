import { oscColor, type TerminalQuerier } from '../ink/terminalQuerier.js'
import {
  type SystemTheme,
  setCachedSystemTheme,
  themeFromOscColor,
} from '../services/environment/systemTheme.js'

export function watchSystemTheme(
  querier: TerminalQuerier,
  onThemeChange: (theme: SystemTheme) => void,
): () => void {
  let stopped = false
  let timerId: ReturnType<typeof setInterval> | undefined

  async function poll(): Promise<void> {
    if (stopped) {
      return
    }
    try {
      const [response] = await Promise.all([querier.send(oscColor(11)), querier.flush()])
      if (stopped) {
        return
      }
      if (response) {
        const theme = themeFromOscColor(response.data)
        if (theme) {
          setCachedSystemTheme(theme)
          onThemeChange(theme)
        }
      }
    } catch {
      // 终端不支持 OSC 11 时静默忽略，保留当前缓存主题。
    }
  }

  timerId = setInterval(poll, 5000)
  void poll()

  return () => {
    stopped = true
    if (timerId) {
      clearInterval(timerId)
    }
  }
}
