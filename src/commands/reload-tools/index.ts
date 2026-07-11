/**
 * /reload-tools — 重扫外部工具目录并使工具变更在当前会话中立即可用。
 * 与 /reload-skills 不同：仅影响 ~/.zy/tools/ 和 .zy/tools/ 目录下的外部工具，
 * 不涉及内置工具、MCP 工具或插件工具。
 */
import type { Command } from '../../commands.js'

const reloadTools = {
  type: 'local',
  name: 'reload-tools',
  description: 'Rescan external tool directories and apply tool changes to the current session',
  supportsNonInteractive: false,
  load: () => import('./reload-tools.js'),
} satisfies Command

export default reloadTools
