/**
 * /goal 命令 — 目标驱动模式。
 * 设定目标后模型跨轮次自主推进，实时显示统计。
 */
import type { Command } from '../../commands.js'
import { tSync } from '../../i18n/index.js'

const goal = {
  type: 'local',
  name: 'goal',
  description: tSync('commands.goal'),
  aliases: [],
  supportsNonInteractive: false,
  load: () => import('./goal.js'),
} satisfies Command

export default goal
