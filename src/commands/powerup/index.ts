/**
 * /powerup 命令 — Ink 交互式功能引导菜单。
 * 浏览课程列表 / 查看详情 / 标记完成；Esc 关闭并向对话流发送系统消息。
 */
import type { Command } from '../../commands.js'
import { tSync } from '../../i18n/index.js'

const powerup = {
  type: 'local-jsx',
  name: 'powerup',
  description: tSync('commands.powerup'),
  aliases: ['tips', 'learn'],
  load: () => import('./powerup.js'),
} satisfies Command

export default powerup
