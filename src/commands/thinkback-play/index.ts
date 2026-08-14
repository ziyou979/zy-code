import type { Command } from '../../commands/index.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'

// 仅播放动画的隐藏命令
// 由 thinkback skill 在生成完成后调用
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
