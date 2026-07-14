/**
 * /bg 命令 — 将当前前台任务转为后台运行。
 * 实现懒加载自 background.ts 以减少启动时间。
 */
import type { Command } from '../../commands.js'

const background = {
  type: 'local',
  name: 'background',
  // 英文兜底（面向模型 / 无翻译时）；UI 本地化经 COMMAND_DESCRIPTION_I18N_KEYS['background'] 渲染期翻译。
  description: 'Send this session to the background and free the terminal',
  aliases: ['bg'],
  supportsNonInteractive: false,
  load: () => import('./background.js'),
} satisfies Command

export default background
