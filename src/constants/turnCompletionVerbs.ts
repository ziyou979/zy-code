// Past tense verbs for turn completion messages
// These verbs work naturally with "for [duration]" (e.g., "Worked for 5s")
import { getUiLanguage } from '../i18n/index.js'

// English versions
const TURN_COMPLETION_VERBS_EN = [
  'Baked',
  'Brewed',
  'Churned',
  'Cogitated',
  'Cooked',
  'Crunched',
  'Sautéed',
  'Worked',
]

// Chinese versions
const TURN_COMPLETION_VERBS_ZH = ['搞定', '完成', '处理完成', '收工', '齐活', '大功告成']

export function getTurnCompletionVerbs(): string[] {
  const language = getUiLanguage()

  switch (language) {
    case 'zh-CN':
      return TURN_COMPLETION_VERBS_ZH
    default:
      return TURN_COMPLETION_VERBS_EN
  }
}
