import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import React from 'react'
import { colorize } from '../ink/colorize.js'
import Link from '../ink/components/Link.js'
import { RawAnsi } from '../ink/components/RawAnsi.js'
import { wrapAnsi } from '../ink/wrapAnsi.js'
import { getTheme, type ThemeName } from '../utils/theme.js'

type Props = {
  /** The absolute file path */
  filePath: string
  /** Optional display text (defaults to filePath) */
  children?: React.ReactNode
}

/**
 * Renders a file path as an OSC 8 hyperlink.
 * This helps terminals like iTerm correctly identify file paths
 * even when they appear inside parentheses or other text.
 */
export function FilePathLink({ filePath, children }: Props) {
  const fileUrl = pathToFileURL(filePath)
  return <Link url={fileUrl.href}>{children ?? filePath}</Link>
}

// 匹配文件路径 + 行号模式，如 src/foo.ts:123 或 /abs/path.go:10-20
const FILE_PATH_RE = /((?:\.\.\/|\.\/|\/)?(?:[\w.-]+\/)*[\w.-]+\.\w{1,10}):(\d+)(?:-(\d+))?/g

/**
 * 用 OSC 8 超链接序列包裹文件路径显示文本。
 * 生成内联 ANSI 字符串，避免使用 Ink 组件导致块级换行。
 * 终端支持 OSC 8 时可点击跳转，不支持时仅显示纯文本。
 */
function wrapWithFileLink(filePath: string, display: string): string {
  const fileUrl = pathToFileURL(resolve(filePath)).href
  // OSC 8 格式：\x1b]8;;URL\x07 显示文本 \x1b]8;;\x07
  return `\x1b]8;;${fileUrl}\x07${display}\x1b]8;;\x07`
}

/**
 * 构建纯文本索引到原始文本索引的映射。
 * 遍历原始文本，跳过 ANSI 转义序列，对每个可见字符
 * 记录它在原始文本中的起始位置。
 */
function buildPlainToOriginalMap(content: string): { plain: string; map: number[] } {
  const map: number[] = []
  let plain = ''
  let i = 0
  while (i < content.length) {
    // 检查是否是 ESC 开头的 ANSI 序列
    if (content.charCodeAt(i) === 0x1b) {
      // CSI 序列：ESC [ ... final-byte
      if (content.charCodeAt(i + 1) === 0x5b) {
        let j = i + 2
        while (j < content.length) {
          const code = content.charCodeAt(j)
          // Final byte 在 0x40-0x7E 范围内终止序列
          if (code >= 0x40 && code <= 0x7e) {
            j++
            break
          }
          j++
        }
        i = j
        continue
      }
      // OSC 序列：ESC ] ... (BEL 或 ST 终止)
      if (content.charCodeAt(i + 1) === 0x5d) {
        let j = i + 2
        while (j < content.length) {
          if (content.charCodeAt(j) === 0x07) {
            j++
            break
          }
          // ST = ESC backslash
          if (content.charCodeAt(j) === 0x1b && content.charCodeAt(j + 1) === 0x5c) {
            j += 2
            break
          }
          j++
        }
        i = j
        continue
      }
      // 其他 ESC 序列（如 ESC ( B）：跳过 ESC + 1-2 字节
      i += 2
      continue
    }
    map.push(i)
    plain += content[i]
    i++
  }
  // 末尾哨兵：纯文本长度对应原始文本末尾
  map.push(content.length)
  return { plain, map }
}

/**
 * 将含文件路径引用的文本中的路径替换为 OSC 8 超链接序列，
 * 返回单个 <RawAnsi> 节点。使用 RawAnsi 绕过 <Ansi> 组件的
 * OSC 8 → <Link> → 重新序列化循环，让 OSC 8 直接穿透到
 * output.write() 的 tokenizer 处理，确保多个链接都能正确跳转。
 */
export function renderContentWithFileLinks(
  content: string,
  width: number,
  dimColor = false,
  theme?: ThemeName,
): React.ReactNode[] {
  // 快速路径：无 ANSI 序列时直接在原始字符串上替换
  const hasAnsi = content.indexOf('\x1b') !== -1
  // 解析主题色用于给纯文本路径着色
  const zyColor = theme ? getTheme(theme).zy : undefined

  let result: string
  if (!hasAnsi) {
    result = content.replace(
      FILE_PATH_RE,
      (_match, filePath: string, startLine: string, endLine: string | undefined) => {
        // file:startLine 整体包进 OSC 8（终端识别为可跳转路径），
        // 范围后缀 -endLine 留在外面作为纯文本，避免干扰终端识别。
        const linkDisplay = `${filePath}:${startLine}`
        const coloredLink = zyColor ? colorize(linkDisplay, zyColor, 'foreground') : linkDisplay
        const tail = endLine ? `-${endLine}` : ''
        const coloredTail = tail && zyColor ? colorize(tail, zyColor, 'foreground') : tail
        return wrapWithFileLink(filePath, coloredLink) + coloredTail
      },
    )
  } else {
    // 含 ANSI 序列：在纯文本上定位匹配，然后在原始字符串中插入 OSC 8
    const { plain, map } = buildPlainToOriginalMap(content)
    const segments: string[] = []
    let lastOriginalIndex = 0
    let match: RegExpExecArray | null

    FILE_PATH_RE.lastIndex = 0
    while ((match = FILE_PATH_RE.exec(plain)) !== null) {
      const plainStart = match.index
      const plainEnd = match.index + match[0].length
      const originalStart = map[plainStart]!
      const originalEnd = map[plainEnd]!

      // 保留匹配前的原始文本（含 ANSI）
      if (originalStart > lastOriginalIndex) {
        segments.push(content.slice(lastOriginalIndex, originalStart))
      }

      // file:startLine 整体包进 OSC 8，-endLine 留在外面作为纯文本
      const filePath = match[1]!
      const startLine = match[2]!
      const endLine: string | undefined = match[3]
      // file:startLine 的纯文本结束位置
      const linkPlainEnd = match.index + filePath.length + 1 + startLine.length
      const originalLinkEnd = map[linkPlainEnd]!
      const linkDisplay = content.slice(originalStart, originalLinkEnd)
      // -endLine 部分（如有）保留为纯文本
      const tailDisplay = endLine ? content.slice(originalLinkEnd, originalEnd) : ''
      segments.push(wrapWithFileLink(filePath, linkDisplay) + tailDisplay)
      lastOriginalIndex = originalEnd
    }

    // 剩余部分
    if (lastOriginalIndex < content.length) {
      segments.push(content.slice(lastOriginalIndex))
    }

    result = segments.join('')
  }

  // dimColor 通过 ANSI dim 序列实现（SGR 2）
  if (dimColor) {
    result = `\x1b[2m${result}\x1b[22m`
  }

  // 按终端宽度预换行，然后交给 RawAnsi 直接输出。
  // 减去安全边距（消息图标、Box padding 等父容器缩进），
  // 避免实际渲染行超出终端可见宽度触发终端换行，
  // 导致 OSC 8 超链接和终端自带路径检测失效。
  const safeWidth = Math.max(40, width - 4)
  const wrapped = wrapAnsi(result, safeWidth, { hard: true, trim: false })
  const lines = wrapped.split('\n')

  return [<RawAnsi key={0} lines={lines} width={safeWidth} />]
}
