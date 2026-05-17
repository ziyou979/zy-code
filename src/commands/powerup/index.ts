/**
 * /powerup 命令 — 交互式功能引导菜单。
 * 展示常用功能的用法和示例，降低新手上手门槛。
 */
import type { Command } from '../../commands.js'

const powerup = {
  type: 'local',
  name: 'powerup',
  description: 'Interactive feature guide — learn tips & tricks',
  aliases: ['tips', 'learn'],
  supportsNonInteractive: false,
  load: () => import('./powerup.js'),
} satisfies Command

export default powerup
