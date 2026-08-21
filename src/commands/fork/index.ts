import type { Command } from '../../commands/index.js'
import type { LocalCommandModule } from '../types.js'

const cmd = {
  type: 'local' as const,
  name: 'fork',
  description: 'Fork conversation',
  supportsNonInteractive: false,
  // 命令模块仍是占位实现；保留注册结构，完成会话分叉后再公开展示。
  isHidden: true,
  load: async (): Promise<LocalCommandModule> => {
    // TODO: Implement fork command module
    throw new Error('Fork command not implemented')
  },
} satisfies Command
export default cmd
