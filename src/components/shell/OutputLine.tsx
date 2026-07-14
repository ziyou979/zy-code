import * as React from 'react'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Ansi, Text, useTheme } from '../../ink.js'
import { createHyperlink } from '../../utils/hyperlink.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import { renderTruncatedContent } from '../../terminal-ui/terminal.js'
import { MessageResponse } from '../MessageResponse.js'
import { InVirtualListContext } from '../MessageActions.js'
import { useExpandShellOutput } from './ExpandShellOutputContext.js'
export function tryFormatJson(line: string): string {
  try {
    const parsed = jsonParse(line)
    const stringified = jsonStringify(parsed)

    // 检查 JSON 往返过程中是否丢失精度
    // 当大整数超过 Number.MAX_SAFE_INTEGER 时会发生这种情况
    // 我们通过移除空白和不必要的转义（\/ 在 JSON 中有效但可选）来归一化两个字符串进行比较
    const normalizedOriginal = line.replace(/\\\//g, '/').replace(/\s+/g, '')
    const normalizedStringified = stringified.replace(/\s+/g, '')
    if (normalizedOriginal !== normalizedStringified) {
      // 检测到精度损失——返回未格式化的原始行
      return line
    }
    return jsonStringify(parsed, null, 2)
  } catch {
    return line
  }
}
const MAX_JSON_FORMAT_LENGTH = 10_000
export function tryJsonFormatContent(content: string): string {
  if (content.length > MAX_JSON_FORMAT_LENGTH) {
    return content
  }
  const allLines = content.split('\n')
  return allLines.map(tryFormatJson).join('\n')
}

// 匹配 JSON 字符串值中的 http(s) URL。保守：无引号、
// 无空白、无尾随逗号/大括号等 JSON 结构。
const URL_IN_JSON = /https?:\/\/[^\s"'<>\\]+/g
export function linkifyUrlsInText(content: string): string {
  return content.replace(URL_IN_JSON, (url) => createHyperlink(url))
}
type OutputLineProps = {
  content: string
  verbose: boolean
  isError?: boolean
  isWarning?: boolean
  linkifyUrls?: boolean
}
export function OutputLine({ content, verbose, isError, isWarning, linkifyUrls }: OutputLineProps) {
  const { columns } = useTerminalSize()
  const [_theme] = useTheme()
  const expandShellOutput = useExpandShellOutput()
  const inVirtualList = React.useContext(InVirtualListContext)
  const shouldShowFull = verbose || expandShellOutput

  let formatted = tryJsonFormatContent(content)
  if (linkifyUrls) {
    formatted = linkifyUrlsInText(formatted)
  }
  const formattedContent = shouldShowFull
    ? stripUnderlineAnsi(formatted)
    : stripUnderlineAnsi(renderTruncatedContent(formatted, columns, inVirtualList))
  const color = isError ? 'error' : isWarning ? 'warning' : undefined
  return (
    <MessageResponse>
      <Text color={color}>{<Ansi>{formattedContent}</Ansi>}</Text>
    </MessageResponse>
  )
}

/**
 * Underline ANSI codes in particular tend to leak out for some reason. I wasn't
 * able to figure out why, or why emitting a reset ANSI code wasn't enough to
 * prevent them from leaking. I also didn't want to strip all ANSI codes with
 * stripAnsi(), because we used to do that and people complained about losing
 * all formatting. So we just strip the underline ANSI codes specifically.
 */
export function stripUnderlineAnsi(content: string): string {
  return content.replace(
    // eslint-disable-next-line no-control-regex
    /\u001b\[([0-9]+;)*4(;[0-9]+)*m|\u001b\[4(;[0-9]+)*m|\u001b\[([0-9]+;)*4m/g,
    '',
  )
}
