import type { Command } from '../../commands/index.js'

const mobile = {
  type: 'local-jsx',
  name: 'mobile',
  aliases: ['ios', 'android'],
  description: 'Show QR code to download the Zy mobile app',
  // 下载地址仍是占位值；保留命令实现，移动端正式发布后移除此标记。
  isHidden: true,
  load: () => import('./mobile.js'),
} satisfies Command

export default mobile
