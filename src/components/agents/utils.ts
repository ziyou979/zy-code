import capitalize from 'lodash-es/capitalize.js'
import type { SettingSource } from 'src/utils/settings/constants.js'
import { getSettingSourceName } from 'src/utils/settings/constants.js'
import { tSync } from '../../i18n/index.js'

export function getAgentSourceDisplayName(
  source: SettingSource | 'all' | 'built-in' | 'plugin',
): string {
  if (source === 'all') {
    return tSync('agents.source.all')
  }
  if (source === 'built-in') {
    return tSync('agents.source.builtIn')
  }
  if (source === 'plugin') {
    return tSync('agents.source.plugin')
  }
  return capitalize(getSettingSourceName(source))
}
