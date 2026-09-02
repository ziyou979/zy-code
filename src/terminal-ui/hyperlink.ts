import chalk from 'chalk'
import { supportsHyperlinks } from '../ink/supportsHyperlinks.js'
import { wrapWithOsc8Link } from '../utils/hyperlink.js'

type HyperlinkOptions = {
  supportsHyperlinks?: boolean
}

/**
 * 使用 OSC 8 转义序列创建可点击超链接。
 * 终端不支持超链接时回退为纯文本。
 * 与 utils/hyperlink.ts 的 createHyperlink 区别：本实现应用蓝色样式
 * （markdown 链接等 UI 场景），序列构造复用共享 wrapWithOsc8Link。
 *
 * @param url 链接指向的 URL
 * @param content 可选的链接显示文本，仅在支持超链接时使用。支持时显示为可点击链接；
 *                不支持时忽略 content，只显示 URL
 * @param options 测试使用的可选覆盖项（supportsHyperlinks）
 */
export function createHyperlink(url: string, content?: string, options?: HyperlinkOptions): string {
  const hasSupport = options?.supportsHyperlinks ?? supportsHyperlinks()
  if (!hasSupport) {
    return url
  }

  // 使用基础 ANSI 蓝色，wrap-ansi 能在换行时保留它。
  // wrap-ansi 与 OSC 8 配合时无法保留 RGB 颜色（如主题色）。
  const displayText = content ?? url
  const coloredText = chalk.blue(displayText)
  return wrapWithOsc8Link(coloredText, url)
}
