import { useCallback, useMemo, useState } from 'react'
import useApp from '../ink/hooks/useApp.js'
import type { KeybindingContextName } from '../keybindings/types.js'
import { useDoublePress } from './useDoublePress.js'

export type ExitState = {
  pending: boolean
  keyName: 'Ctrl-C' | 'Ctrl-D' | null
}

type KeybindingOptions = {
  context?: KeybindingContextName
  isActive?: boolean
}

type UseKeybindingsHook = (
  handlers: Record<string, () => void>,
  options?: KeybindingOptions,
) => void

/**
 * 处理用于退出应用的 ctrl+c 和 ctrl+d。
 *
 * 使用基于时间的双击机制：
 * - 首次按下：显示“再次按 X 退出”消息
 * - 超时前第二次按下：退出应用
 *
 * 此处使用基于时间的双击，而非 chord 系统，因为首次 ctrl+c 还要触发由其他位置处理的 interrupt。
 * chord 系统会阻止首次按键触发任何 action。
 *
 * 这些按键为硬编码，无法通过 keybindings.json 重新绑定。
 *
 * @param useKeybindingsHook - The useKeybindings hook to use for registering handlers
 *                            (dependency injection to avoid import cycles)
 * @param onInterrupt - Optional callback for features to handle interrupt (ctrl+c).
 *                      Return true if handled, false to fall through to double-press exit.
 * @param onExit - Optional custom exit handler
 * @param isActive - Whether the keybinding is active (default true). Set false
 *                   while an embedded TextInput is focused — TextInput's own
 *                   ctrl+c/d handlers will manage cancel/exit, and Dialog's
 *                   handler would otherwise double-fire (child useInput runs
 *                   before parent useKeybindings, so both see every keypress).
 */
export function useExitOnCtrlCD(
  useKeybindingsHook: UseKeybindingsHook,
  onInterrupt?: () => boolean,
  onExit?: () => void,
  isActive = true,
): ExitState {
  const { exit } = useApp()
  const [exitState, setExitState] = useState<ExitState>({
    pending: false,
    keyName: null,
  })

  const exitFn = useMemo(() => onExit ?? exit, [onExit, exit])

  // ctrl+c 双击处理器
  const handleCtrlCDoublePress = useDoublePress(
    (pending) => setExitState({ pending, keyName: 'Ctrl-C' }),
    exitFn,
  )

  // ctrl+d 双击处理器
  const handleCtrlDDoublePress = useDoublePress(
    (pending) => setExitState({ pending, keyName: 'Ctrl-D' }),
    exitFn,
  )

  // app:interrupt 处理器（默认为 ctrl+c）
  // 先让各功能通过 callback 处理 interrupt
  const handleInterrupt = useCallback(() => {
    if (onInterrupt?.()) {
      return // Feature handled it
    }
    handleCtrlCDoublePress()
  }, [handleCtrlCDoublePress, onInterrupt])

  // app:exit 处理器（默认为 ctrl+d），同样通过双击确认退出
  const handleExit = useCallback(() => {
    handleCtrlDDoublePress()
  }, [handleCtrlDDoublePress])

  const handlers = useMemo(
    () => ({
      'app:interrupt': handleInterrupt,
      'app:exit': handleExit,
    }),
    [handleInterrupt, handleExit],
  )

  useKeybindingsHook(handlers, { context: 'Global', isActive })

  return exitState
}
