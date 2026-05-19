/**
 * /bg 命令 — 将当前前台任务转为后台运行。
 * 实现懒加载自 background.ts 以减少启动时间。
 */
import type { Command } from '../../commands.js'
import { tSync } from '../../i18n/index.js'

const background = {
  type: 'local',
  name: 'background',
  description: tSync('commands.bg'),
  aliases: ['bg'],
  supportsNonInteractive: false,
  load: () => import('./background.ts'),
} satisfies Command

export default background
