/**
 * /goal 命令 — 设定目标，注入 session-scoped Stop hook 持续驱动模型直到条件满足。
 * 类型为 local-jsx，通过 onDone 回调的 shouldQuery + metaMessages 触发模型。
 */
import type { Command } from '../../commands.js'

const goal = {
  type: 'local-jsx',
  name: 'goal',
  // 英文兜底；UI 本地化经 COMMAND_DESCRIPTION_I18N_KEYS['goal'] 渲染期翻译。
  description: 'Set a goal — keep working until the condition is met',
  aliases: [],
  argumentHint: '[<condition> | clear]',
  immediate: true,
  load: () => import('./goal.js'),
} satisfies Command

export default goal
