import { getUiLanguage } from '../../i18n/index.js'
import { enPowerupFrames } from '../../i18n/locales/en/powerupFrames.js'
import { zhPowerupFrames } from '../../i18n/locales/zh-CN/powerupFrames.js'

export type LessonFrame = {
  prompt: string
  response: string
  /** 该帧停留时长，未指定时使用 DEFAULT_FRAME_MS */
  durationMs?: number
}

export type PowerupFramesMap = Record<string, LessonFrame[]>

export const DEFAULT_FRAME_MS = 2400

const BUNDLES: Record<string, PowerupFramesMap> = {
  en: enPowerupFrames,
  'zh-CN': zhPowerupFrames,
}

/**
 * 按当前 UI 语言读取课程的帧列表；缺帧时返回 []，调用方据此决定是否渲染动画。
 */
export function getLessonFrames(i18nKey: string): LessonFrame[] {
  const lang = getUiLanguage()
  const bundle = BUNDLES[lang] ?? BUNDLES.en!
  return bundle[i18nKey] ?? []
}
