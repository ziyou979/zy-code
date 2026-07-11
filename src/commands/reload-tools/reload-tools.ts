import { tSync } from '../../i18n/index.js'
import {
  reloadExternalTools,
} from '../../tools/externalToolLoader.js'
import type { LocalCommandCall } from '../../types/command.js'

export const call: LocalCommandCall = async (_args, _context) => {
  const result = await reloadExternalTools(process.cwd())

  if (result.added.length === 0 && result.removed.length === 0) {
    return {
      type: 'text' as const,
      value: tSync('commands.reloadTools.noChanges', {
        count: String(result.total),
      }),
    }
  }

  const parts: string[] = []
  if (result.added.length > 0) {
    parts.push(
      tSync('commands.reloadTools.added', {
        count: String(result.added.length),
        names: result.added.join(', '),
      }),
    )
  }
  if (result.removed.length > 0) {
    parts.push(
      tSync('commands.reloadTools.removed', {
        count: String(result.removed.length),
        names: result.removed.join(', '),
      }),
    )
  }

  return {
    type: 'text' as const,
    value: tSync('commands.reloadTools.changed', {
      count: String(result.total),
      changes: parts.join('; '),
    }),
  }
}
