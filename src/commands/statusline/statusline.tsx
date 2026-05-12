import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { getInitialSettings, updateSettingsForSource } from '../../utils/settings/settings.js'

export async function call(onDone: LocalJSXCommandOnDone): Promise<null> {
  const settings = getInitialSettings()
  const currentlyEnabled = settings.builtInStatusBar?.enabled !== false
  const newEnabled = !currentlyEnabled

  updateSettingsForSource('userSettings', {
    builtInStatusBar: { enabled: newEnabled },
  })

  onDone(newEnabled ? 'statusLine.enabled' : 'statusLine.disabled', { display: 'system' })
  return null
}
