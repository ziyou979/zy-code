/**
 * Color 命令，仅包含最少 metadata。
 * 实现从 color.ts 延迟加载，以缩短启动时间。
 */
import type { Command } from '../../commands/index.js'

const color = {
  type: 'local-jsx',
  name: 'color',
  description: 'Set the prompt bar color for this session',
  immediate: true,
  argumentHint: '<color|default>',
  load: () => import('./color.js'),
} satisfies Command

export default color
