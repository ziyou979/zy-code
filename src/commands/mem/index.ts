import type { Command } from '../../commands/index.js'

const mem: Command = {
  type: 'local',
  name: 'mem',
  description: '显示运行时内存使用分析和诊断信息',
  isHidden: false,
  supportsNonInteractive: true,
  load: () => import('./mem.js'),
}

export default mem
