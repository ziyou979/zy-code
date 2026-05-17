/**
 * /bg 命令 — 将当前前台任务转为后台运行。
 * 实现懒加载自 bg.ts 以减少启动时间。
 */
import type { Command } from '../../commands.js'

const bg = {
  type: 'local',
  name: 'bg',
  description: 'Move current foreground tasks to background',
  aliases: ['background'],
  supportsNonInteractive: false,
  load: () => import('./bg.js'),
} satisfies Command

export default bg
