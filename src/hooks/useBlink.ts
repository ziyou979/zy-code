import { type DOMElement, useAnimationFrame, useTerminalFocus } from '../ink/index.js'

const BLINK_INTERVAL_MS = 600

/**
 * 用于同步闪烁动画的 hook，元素离开屏幕时暂停动画。
 *
 * 返回要绑定到动画元素的 ref 以及当前闪烁状态。
 * 所有实例共用同一个动画时钟，因此会同步闪烁。至少有一个订阅者可见时，
 * 时钟才会运行；终端失焦时也会暂停。
 *
 * @param enabled - Whether blinking is active
 * @returns [ref, isVisible] - Ref to attach to element, true when visible in blink cycle
 *
 * @example
 * function BlinkingDot({ shouldAnimate }) {
 *   const [ref, isVisible] = useBlink(shouldAnimate)
 *   return <Box ref={ref}>{isVisible ? '●' : ' '}</Box>
 * }
 */
export function useBlink(
  enabled: boolean,
  intervalMs: number = BLINK_INTERVAL_MS,
): [ref: (element: DOMElement | null) => void, isVisible: boolean] {
  const focused = useTerminalFocus()
  const [ref, time] = useAnimationFrame(enabled && focused ? intervalMs : null)

  if (!enabled || !focused) {
    return [ref, true]
  }

  // 根据时间计算闪烁状态；所有实例看到同一时间，因此能够同步
  const isVisible = Math.floor(time / intervalMs) % 2 === 0
  return [ref, isVisible]
}
