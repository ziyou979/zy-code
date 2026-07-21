import type { Command, LocalCommandCall } from './types.js'
import { isInternalBuild } from '../services/infra/envUtils.js'

const call: LocalCommandCall = async () => {
  return {
    type: 'text',
    value: MACRO.BUILD_TIME ? `${MACRO.VERSION} (built ${MACRO.BUILD_TIME})` : MACRO.VERSION,
  }
}

const version = {
  type: 'local',
  name: 'version',
  description: 'Print the version this session is running (not what autoupdate downloaded)',
  isEnabled: () => isInternalBuild(),
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default version
