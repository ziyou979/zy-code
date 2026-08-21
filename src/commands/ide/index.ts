import type { Command } from '../../commands/index.js'

const ide = {
  type: 'local-jsx',
  name: 'ide',
  description: 'Manage IDE integrations and show status',
  argumentHint: '[open]',
  // IDE 集成尚未达到可公开支持的状态；保留命令实现，功能完整后移除此标记。
  isHidden: true,
  load: () => import('./ide.js'),
} satisfies Command

export default ide
