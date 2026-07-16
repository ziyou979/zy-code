/**
 * /tools — 列出当前会话中加载的所有工具。
 * 分组展示内置工具和外部工具，同名工具只显示外部版本。
 */
import type { Command } from '../../commands/index.js'

const tools = {
  type: 'local-jsx',
  name: 'tools',
  description: 'List all tools (built-in and external) in the current session',
  load: () => import('./tools.js'),
} satisfies Command

export default tools
