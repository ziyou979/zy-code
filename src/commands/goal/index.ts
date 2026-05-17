/**
 * /goal 命令 — 目标驱动模式。
 * 设定目标后模型跨轮次自主推进，实时显示统计。
 */
import type { Command } from '../../commands.js'

const goal = {
  type: 'local',
  name: 'goal',
  description: 'Set a goal for autonomous multi-turn execution',
  aliases: [],
  supportsNonInteractive: false,
  load: () => import('./goal.js'),
} satisfies Command

export default goal
