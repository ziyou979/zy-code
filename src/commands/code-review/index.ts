/**
 * /code-review — PR 审查命令族。
 *
 * 支持 effort 等级（low/medium/high）、--fix 直接应用修改、--comment 行级评论。
 * 与 /review（快速单 pass）不同，/code-review 支持多级审查深度。
 */
import type { Command } from '../../commands/index.js'

const codeReview: Command = {
  type: 'local-jsx',
  name: 'code-review',
  description: 'Review code changes with configurable depth',
  argumentHint: '[low|medium|high] [--fix] [--comment] [PR#]',
  load: () => import('./code-review.js'),
}

export default codeReview
