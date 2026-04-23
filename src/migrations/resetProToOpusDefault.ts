import { logEvent } from 'src/services/analytics/index.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'

export function resetProToOpusDefault(): void {
  const config = getGlobalConfig()

  if (config.opusProMigrationComplete) {
    return
  }

  // No Pro subscriber context — mark migration complete
  saveGlobalConfig(current => ({
    ...current,
    opusProMigrationComplete: true,
  }))
  logEvent('zy_reset_pro_to_opus_default', { skipped: true })
}
