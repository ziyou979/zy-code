/**
 * 终端内联图像渲染 — iTerm2 OSC 1337 协议
 *
 * 在支持的终端中直接以内联方式渲染图像，而非显示为 [Image #N] 超链接。
 * 当前支持 iTerm2 的 OSC 1337 File inline 协议。
 */

import { readFileSync } from 'node:fs'

/**
 * 检查终端是否支持内联图像。
 * iTerm2 支持 OSC 1337 内联图像协议。
 */
export function supportsInlineImages(): boolean {
  const termProgram = process.env.TERM_PROGRAM
  if (termProgram === 'iTerm.app' || termProgram === 'iTerm2') {
    return true
  }
  const lcTerminal = process.env.LC_TERMINAL
  if (lcTerminal === 'iTerm.app' || lcTerminal === 'iTerm2') {
    return true
  }
  return false
}

/**
 * 将图像文件渲染为 iTerm2 OSC 1337 内联图像转义序列。
 *
 * 格式: ESC ] 1337 ; File = inline=1; size=N: <base64> BEL
 *
 * @param imagePath 图像文件的磁盘路径
 * @param maxWidth 最大宽度（终端列数），默认 40
 * @returns OSC 1337 转义序列字符串，若不支持内联图像则返回 null
 */
export function renderInlineImageFromFile(imagePath: string, maxWidth: number = 40): string | null {
  if (!supportsInlineImages()) {
    return null
  }

  try {
    const data = readFileSync(imagePath)
    const base64 = data.toString('base64')
    return renderInlineImage(base64, data.length, maxWidth)
  } catch {
    return null
  }
}

/**
 * 将 base64 编码的图像数据渲染为 iTerm2 OSC 1337 内联图像转义序列。
 *
 * @param base64Data base64 编码的图像数据
 * @param byteLength 解码后的字节大小
 * @param maxWidth 最大宽度（终端列数），默认 40
 * @returns OSC 1337 转义序列字符串
 */
export function renderInlineImage(
  base64Data: string,
  byteLength: number,
  maxWidth: number = 40,
): string {
  // 移除可能的前导空白/换行
  const cleaned = base64Data.replace(/\s/g, '')
  // OSC 1337 内联图像: width 以列（cells）为单位
  const params = `inline=1;size=${byteLength};width=${maxWidth}`
  return `\x1b]1337;File=${params}:${cleaned}\x07`
}
