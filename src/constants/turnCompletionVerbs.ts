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
  '处理了',
  '做好了',
  '算完了',
  '琢磨完了',
  '干完了',
]

export function getTurnCompletionVerbs(): string[] {
  return getUiLanguage() === 'zh-CN'
    ? TURN_COMPLETION_VERBS_ZH
    : TURN_COMPLETION_VERBS_EN
}
