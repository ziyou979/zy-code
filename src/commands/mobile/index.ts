import type { Command } from '../../commands/index.js'

const mobile = {
  type: 'local-jsx',
  name: 'mobile',
  aliases: ['ios', 'android'],
  description: 'Show QR code to download the Zy mobile app',
  load: () => import('./mobile.js'),
} satisfies Command

export default mobile
