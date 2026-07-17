import type { Command } from '../../commands/index.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'

// Hidden command that just plays the animation
// Called by the thinkback skill after generation is complete
const thinkbackPlay = {
  type: 'local',
  name: 'thinkback-play',
  description: 'Play the thinkback animation',
  isEnabled: () => checkStatsigFeatureGate_CACHED_MAY_BE_STALE('zy_thinkback'),
  isHidden: true,
  supportsNonInteractive: false,
  load: () => import('./thinkbackPlay.js'),
} satisfies Command

export default thinkbackPlay
