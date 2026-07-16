/**
 * /powerup 命令 — Ink 交互式功能引导菜单。
 * 浏览课程列表 / 查看详情 / 标记完成；Esc 关闭并向对话流发送系统消息。
 */
import type { Command } from '../../commands/index.js'

const powerup = {
  type: 'local-jsx',
  name: 'powerup',
  // 英文兜底；UI 本地化经 COMMAND_DESCRIPTION_I18N_KEYS['powerup'] 渲染期翻译。
  description: 'Interactive feature guide — learn tips & tricks',
  aliases: ['tips', 'learn'],
  load: () => import('./powerup.js'),
} satisfies Command

export default powerup
