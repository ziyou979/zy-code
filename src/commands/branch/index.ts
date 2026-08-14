import { feature } from 'bun:bundle'
import type { Command } from '../../commands/index.js'

const branch = {
  type: 'local-jsx',
  name: 'branch',
  // 仅当 /fork 不作为独立命令存在时才注册 'fork' alias
  aliases: feature('FORK_SUBAGENT') ? [] : ['fork'],
  description: 'Create a branch of the current conversation at this point',
  argumentHint: '[name]',
  load: () => import('./branch.js'),
} satisfies Command

export default branch
