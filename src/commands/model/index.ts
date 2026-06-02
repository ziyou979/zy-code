import type { Command } from '../../commands.js'
import { getMainLoopModel, renderModelName } from '../../services/model/model.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'

/**
 * /model 的交互变体（默认导出）。
 * 由 Ink REPL 直接派发：无参弹 ModelPicker，带参走 SetModelAndClose。
 */
const model = {
  type: 'local-jsx',
  name: 'model',
  get description() {
    return `Set the AI model for ZY Code (currently ${renderModelName(getMainLoopModel())})`
  },
  argumentHint: '[model]',
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./model.js'),
} satisfies Command

/**
 * /model 的非交互变体（命名导出）。
 * 同名注册：交互模式下 commands.ts 把它放在 model 之后，findCommand 命中前者；
 * `zy -p` / headless 模式过滤后只剩本变体。用于 SDK / 脚本中以名字直改模型。
 */
export const modelLocal = {
  type: 'local',
  name: 'model',
  supportsNonInteractive: true,
  // 仅需在非交互过滤后生效，交互模式下隐藏避免重复呈现
  isHidden: true,
  description: 'Set the AI model for ZY Code',
  argumentHint: '[model|default]',
  load: () => import('./modelLocal.js'),
} satisfies Command

export default model
