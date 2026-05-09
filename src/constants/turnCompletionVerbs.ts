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
const TURN_COMPLETION_VERBS_ZH = [
  '搞定了',
  '弄好了',
  '完成了',
  '处理完成',
  '做好了',
  '收工了',
  '齐活了',
  '大功告成',
]

export function getTurnCompletionVerbs(): string[] {
  const language = getUiLanguage()

  switch (language) {
    case 'zh-CN':
      return TURN_COMPLETION_VERBS_ZH
    default:
      return TURN_COMPLETION_VERBS_EN
  }
}
