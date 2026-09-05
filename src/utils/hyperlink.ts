/**
 * OSC 8 超链接的纯函数封装，收敛渲染层/UI 层多处手写的转义序列。
 *
 * 注意：此处固定使用空参数形式 `\x1b]8;;url\x07`（无 id=）。
 * ansi-tokenize 只识别这个确切前缀（见 renderNodeToOutput.ts 注释）；
 * 带 id= 分组的变体（用于直接写终端 stdout 的场景）见 termio/osc.ts link()，
 * 两者场景不同，不在此混用。
 */
import { supportsHyperlinks } from '../ink/supportsHyperlinks.js'

const OSC8_START = '\x1b]8;;'
const OSC8_END = '\x07'

/**
 * 将 text 包装为 OSC 8 超链接。不做能力检测——调用方负责在
 * 确认需要输出序列时调用（渲染管线 / 已知支持的环境）。
 * 零视觉宽度：strip-ansi 可正确剥离，不影响布局计算。
 */
export function wrapWithOsc8Link(text: string, url: string): string {
  return `${OSC8_START}${url}${OSC8_END}${text}${OSC8_START}${OSC8_END}`
}

type HyperlinkOptions = {
  supportsHyperlinks?: boolean
}

/**
 * 创建 OSC 8 超链接，终端不支持时回退为纯文本。
 * 不应用颜色——链接文本继承调用处的样式（如 chalk.dim）。
 *
 * @param url 链接指向的 URL
 * @param content 显示文本；缺省时显示 url
 * @param options 测试用的能力覆盖项
 */
export function createHyperlink(url: string, content?: string, options?: HyperlinkOptions): string {
  const hasSupport = options?.supportsHyperlinks ?? supportsHyperlinks()
  const displayText = content ?? url
  return hasSupport ? wrapWithOsc8Link(displayText, url) : displayText
}
