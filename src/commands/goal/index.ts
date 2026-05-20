/**
 * /goal 命令 — 设定目标，注入 session-scoped Stop hook 持续驱动模型直到条件满足。
 * 类型为 local-jsx，通过 onDone 回调的 shouldQuery + metaMessages 触发模型。
 */
import type { Command } from '../../commands.js'
import { tSync } from '../../i18n/index.js'

const goal = {
  type: 'local-jsx',
  name: 'goal',
  description: tSync('commands.goal'),
  aliases: [],
  argumentHint: '[<condition> | clear]',
  immediate: true,
  load: () => import('./goal.js'),
} satisfies Command

export default goal
