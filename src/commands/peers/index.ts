import type { Command } from '../../commands/index.js'
import type { LocalCommandModule } from '../types.js'

const cmd = {
  type: 'local' as const,
  name: 'peers',
  description: 'Manage peers',
  supportsNonInteractive: false,
  // 命令模块仍是占位实现；保留注册结构，完成 peer 管理后再公开展示。
  isHidden: true,
  load: async (): Promise<LocalCommandModule> => {
    // TODO: Implement peers command module
    throw new Error('Peers command not implemented')
  },
} satisfies Command
export default cmd
