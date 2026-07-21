import type { Command } from '../../commands/index.js'
import { isInternalBuild } from '../../services/infra/envUtils.js'

const tag = {
  type: 'local-jsx',
  name: 'tag',
  description: 'Toggle a searchable tag on the current session',
  isEnabled: () => isInternalBuild(),
  argumentHint: '<tag-name>',
  load: () => import('./tag.js'),
} satisfies Command

export default tag
