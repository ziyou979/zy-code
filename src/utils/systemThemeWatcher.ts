import { oscColor, type TerminalQuerier } from '../ink/terminal-querier.js'
import { setCachedSystemTheme, themeFromOscColor, type SystemTheme } from './systemTheme.js'

/**
 * Poll the terminal for its background color via OSC 11 and update the
 * cached system theme whenever it changes. Returns a cleanup function
 * that stops polling.
 */
export function watchSystemTheme(
  querier: TerminalQuerier,
  onThemeChange: (theme: SystemTheme) => void,
): () => void {
  let stopped = false
  let timerId: ReturnType<typeof setInterval> | undefined

  async function poll() {
    if (stopped) return
    try {
      const [response] = await Promise.all([querier.send(oscColor(11)), querier.flush()])
      if (stopped) return
      if (response) {
        const theme = themeFromOscColor(response.data)
        if (theme) {
          setCachedSystemTheme(theme)
          onThemeChange(theme)
        }
      }
    } catch {
      // Terminal doesn't support OSC 11 — silently ignore.
    }
  }

  // First poll fires immediately.
  void poll()
  // Re-poll periodically to catch live theme switches.
  timerId = setInterval(() => void poll(), 5_000)

  return () => {
    stopped = true
    if (timerId !== undefined) clearInterval(timerId)
  }
}
