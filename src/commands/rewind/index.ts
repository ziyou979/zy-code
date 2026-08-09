import type { Command } from '../../commands/index.js'

const rewind = {
  description: `Restore the code and/or conversation to a previous point`,
  name: 'rewind',
  // tree：pi 命名对齐；完整会话树 UI 未独立实现前与 rewind 同实现
  aliases: ['checkpoint', 'tree'],
  argumentHint: '',
  type: 'local',
  supportsNonInteractive: false,
  load: () => import('./rewind.js'),
} satisfies Command

export default rewind
