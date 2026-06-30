import type { Command } from '../../commands.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'

/**
 * /effort 的交互变体（默认导出）。
 */
const effort = {
  type: 'local-jsx',
  name: 'effort',
  description: 'Set effort level for model usage',
  argumentHint: '[off|on|quick|light|balanced|thorough|extreme|ultra|orchestrate|auto]',
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./effort.js'),
} satisfies Command

/**
 * /effort 的非交互变体（命名导出）。用于 SDK / 脚本中直改 effort 等级。
 */
export const effortLocal = {
  type: 'local',
  name: 'effort',
  supportsNonInteractive: true,
  // 仅需在非交互过滤后生效，交互模式下隐藏避免重复呈现
  isHidden: true,
  description: 'Set effort level for model usage',
  argumentHint: '[off|on|quick|light|balanced|thorough|extreme|ultra|orchestrate|auto]',
  load: () => import('./effortLocal.js'),
} satisfies Command

export default effort
