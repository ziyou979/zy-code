/**
 * 为 command binding 注册 keybinding 处理器的组件。
 *
 * 必须在 KeybindingSetup 内渲染，才能访问 keybinding context。
 * 从当前 keybinding 配置读取 "command:*" action，并注册通过 onSubmit
 * 调用相应 slash command 的处理器。
 *
 * 通过 keybinding 触发的命令视为 "immediate"：立即执行并保留用户现有输入文本，
 * 不会清空 prompt。
 */

import { useIsModalOverlayActive } from '../context/OverlayContext.js'
import { useOptionalKeybindingContext } from '../keybindings/KeybindingContext.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import type { PromptInputHelpers } from '../services/input/handlePromptSubmit.js'

type Props = {
  // onSubmit 除此处传入的参数外还接受其他参数，因此用 rest parameter 容纳额外参数
  onSubmit: (
    input: string,
    helpers: PromptInputHelpers,
    ...rest: [
      speculationAccept?: undefined,
      options?: {
        fromKeybinding?: boolean
      },
    ]
  ) => void
  /** 设为 false 可禁用 command keybinding，例如打开 dialog 时。 */
  isActive?: boolean
}
const NOOP_HELPERS: PromptInputHelpers = {
  setCursorOffset: () => {},
  clearBuffer: () => {},
  resetHistory: () => {},
}

/**
 * 为用户 keybinding 配置中的所有 "command:*" action 注册处理器。
 * 触发时，各处理器提交相应 slash command，例如 "command:commit" 提交 "/commit"。
 */
export function CommandKeybindingHandlers({ onSubmit, isActive = true }: Props) {
  const keybindingContext = useOptionalKeybindingContext()
  const isModalOverlayActive = useIsModalOverlayActive()
  let commandActions
  if (!keybindingContext) {
    commandActions = new Set()
  } else {
    const actions = new Set()
    for (const binding of keybindingContext.bindings) {
      if (binding.action?.startsWith('command:')) {
        actions.add(binding.action)
      }
    }
    commandActions = actions
  }
  const map: Record<string, () => void> = {}
  for (const action of commandActions) {
    const commandName = (action as string).slice(8)
    map[action as string] = () => {
      onSubmit(`/${commandName}`, NOOP_HELPERS, undefined, {
        fromKeybinding: true,
      })
    }
  }
  const handlers = map
  useKeybindings(handlers, {
    context: 'Chat',
    isActive: isActive && !isModalOverlayActive,
  })
  return null
}
