import { resolve } from 'path'
import React from 'react'
import { pathToFileURL } from 'url'
import { Ansi } from '../ink.js'
import Link from '../ink/components/Link.js'
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

/** 将含文件路径引用的文本拆分为 Ansi/FilePathLink 混合节点 */
export function renderContentWithFileLinks(content: string, dimColor = false): React.ReactNode[] {
  // 快速路径：无 ANSI 序列时走原始逻辑避免额外开销
  const hasAnsi = content.indexOf('\x1b') !== -1

  if (!hasAnsi) {
    return matchFileLinksSimple(content, dimColor)
  }

  // 含 ANSI 序列：在纯文本上匹配，然后映射回原始位置
  const { plain, map } = buildPlainToOriginalMap(content)
  const parts: React.ReactNode[] = []
  let lastOriginalIndex = 0
  let match: RegExpExecArray | null

  FILE_PATH_RE.lastIndex = 0
  while ((match = FILE_PATH_RE.exec(plain)) !== null) {
    const plainStart = match.index
    const plainEnd = match.index + match[0].length
    // 映射回原始文本中的位置
    const originalStart = map[plainStart]!
    const originalEnd = map[plainEnd]!

    // 渲染匹配前的带 ANSI 的文本
    if (originalStart > lastOriginalIndex) {
      const before = content.slice(lastOriginalIndex, originalStart)
      parts.push(
        <Ansi key={parts.length} dimColor={dimColor}>
          {before}
        </Ansi>,
      )
    }

    // 将文件路径用 OSC 8 超链接包裹后拼入文本，整体用 <Ansi> 渲染避免换行
    const filePath = match[1]!
    const display = match[0]
    const linked = wrapWithFileLink(filePath, display)
    parts.push(
      <Ansi key={parts.length} dimColor={dimColor}>
        {linked}
      </Ansi>,
    )
    lastOriginalIndex = originalEnd
  }

  // 渲染剩余部分
  if (lastOriginalIndex < content.length) {
    parts.push(
      <Ansi key={parts.length} dimColor={dimColor}>
        {content.slice(lastOriginalIndex)}
      </Ansi>,
    )
  }

  return parts
}

/** 无 ANSI 序列时的简单匹配路径（零额外开销） */
function matchFileLinksSimple(content: string, dimColor: boolean): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  FILE_PATH_RE.lastIndex = 0
  while ((match = FILE_PATH_RE.exec(content)) !== null) {
    // 渲染匹配前的纯文本
    if (match.index > lastIndex) {
      const before = content.slice(lastIndex, match.index)
      parts.push(
        <Ansi key={parts.length} dimColor={dimColor}>
          {before}
        </Ansi>,
      )
    }
    // 将文件路径用 OSC 8 超链接包裹后拼入文本，整体用 <Ansi> 渲染避免换行
    const filePath = match[1]!
    const display = match[0]
    const linked = wrapWithFileLink(filePath, display)
    parts.push(
      <Ansi key={parts.length} dimColor={dimColor}>
        {linked}
      </Ansi>,
    )
    lastIndex = match.index + display.length
  }

  // 渲染剩余部分
  if (lastIndex < content.length) {
    parts.push(
      <Ansi key={parts.length} dimColor={dimColor}>
        {content.slice(lastIndex)}
      </Ansi>,
    )
  }

  return parts
}
