import { useEffect, useState } from 'react'
import { useTerminalFocus, useTerminalTitle } from '../ink.js'
import {TITLE_FRAME_A, TITLE_FRAME_B, TEARDROP_ASTERISK} from 'src/constants/figures.js'

const TITLE_ANIMATION_FRAMES = [TITLE_FRAME_A, TITLE_FRAME_B]
const TITLE_STATIC_PREFIX = TEARDROP_ASTERISK
const TITLE_ANIMATION_INTERVAL_MS = 1000

/**
 * Sets the terminal tab title, with an animated prefix glyph while a query
 * is running. Isolated from REPL so the 960ms animation tick re-renders only
 * this leaf component (which returns null — pure side-effect) instead of the
 * entire REPL tree. Before extraction, the tick was ~1 REPL render/sec for
 * the duration of every turn, dragging PromptInput and friends along.
 */
type Props = {
  isAnimating: boolean
  title: string
  disabled?: boolean
  noPrefix?: boolean
}
export function AnimatedTerminalTitle({ isAnimating, title, disabled, noPrefix }: Props) {
  const terminalFocused = useTerminalFocus()
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (disabled || noPrefix || !isAnimating || !terminalFocused) {
      return
    }
    const interval = setInterval(
      (frameSetter) => frameSetter((f) => (f + 1) % TITLE_ANIMATION_FRAMES.length),
      TITLE_ANIMATION_INTERVAL_MS,
      setFrame,
    )
    return () => clearInterval(interval)
  }, [disabled, noPrefix, isAnimating, terminalFocused])
  const prefix = isAnimating
    ? (TITLE_ANIMATION_FRAMES[frame] ?? TITLE_STATIC_PREFIX)
    : TITLE_STATIC_PREFIX
  useTerminalTitle(disabled ? null : noPrefix ? title : `${prefix} ${title}`)
  return null
}
