import { Suspense, use } from 'react'
import { useSettings } from '../../../hooks/useSettings.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { stringWidth } from '../../../ink/stringWidth.js'
import { Ansi, Box, Text, useTheme } from '../../../ink.js'
import { getCliHighlightPromise } from '../../../utils/cliHighlight.js'
import { applyMarkdown } from '../../../utils/markdown.js'
import sliceAnsi from '../../../utils/sliceAnsi.js'

type PreviewBoxProps = {
  /** The preview content to display. Markdown is rendered with syntax highlighting
   * for code blocks (```ts, ```py, etc.). Also supports plain multi-line text. */
  content: string
  /** Maximum number of lines to display before truncating. @default 20 */
  maxLines?: number
  /** Minimum height (in lines) for the preview box. Content will be padded if shorter. */
  minHeight?: number
  /** Minimum width for the preview box. @default 40 */
  minWidth?: number
  /** Maximum width available for this box (e.g., the container width). */
  maxWidth?: number
}
const BOX_CHARS = {
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  horizontal: '─',
  vertical: '│',
  teeLeft: '├',
  teeRight: '┤',
}

/**
 * A bordered monospace box for displaying preview content.
 * Truncates content that exceeds maxLines with an indicator.
 * The parent component should pass maxLines based on its available height budget.
 */
export function PreviewBox(props) {
  const settings = useSettings()
  if (settings.syntaxHighlightingDisabled) {
    return <PreviewBoxBody {...props} highlight={null} />
  }
  return (
    <Suspense fallback={<PreviewBoxBody {...props} highlight={null} />}>
      <PreviewBoxWithHighlight {...props} />
    </Suspense>
  )
}
function PreviewBoxWithHighlight(props) {
  const highlightPromise = getCliHighlightPromise()
  const highlight = use(highlightPromise)
  return <PreviewBoxBody {...props} highlight={highlight} />
}
function PreviewBoxBody({ content, maxLines, minHeight, minWidth = 40, maxWidth, highlight }) {
  const { columns: terminalWidth } = useTerminalSize()
  const [theme] = useTheme()
  const effectiveMaxWidth = maxWidth ?? terminalWidth - 4
  const effectiveMaxLines = maxLines ?? 20
  const rendered = applyMarkdown(content, theme, highlight)
  const contentLines = rendered.split('\n')
  const isTruncated = contentLines.length > effectiveMaxLines
  const truncatedLines = isTruncated ? contentLines.slice(0, effectiveMaxLines) : contentLines
  const effectiveMinHeight = Math.min(minHeight ?? 0, effectiveMaxLines)
  const paddingNeeded = Math.max(
    0,
    effectiveMinHeight - truncatedLines.length - (isTruncated ? 1 : 0),
  )
  const lines =
    paddingNeeded > 0 ? [...truncatedLines, ...Array(paddingNeeded).fill('')] : truncatedLines
  const contentWidth = Math.max(minWidth, ...lines.map((line) => stringWidth(line)))
  const boxWidth = Math.min(contentWidth + 4, effectiveMaxWidth)
  const innerWidth = boxWidth - 4
  const horizontalLineChars = BOX_CHARS.horizontal.repeat(boxWidth - 2)
  const topBorder = `${BOX_CHARS.topLeft}${horizontalLineChars}${BOX_CHARS.topRight}`
  const bottomHorizontalLineChars = BOX_CHARS.horizontal.repeat(boxWidth - 2)
  const bottomBorder = `${BOX_CHARS.bottomLeft}${bottomHorizontalLineChars}${BOX_CHARS.bottomRight}`
  const truncationBar = isTruncated
    ? (() => {
        const hiddenCount = contentLines.length - effectiveMaxLines
        const label = `${BOX_CHARS.horizontal.repeat(3)} \u2702 ${BOX_CHARS.horizontal.repeat(3)} ${hiddenCount} lines hidden `
        const labelWidth = stringWidth(label)
        const fillWidth = Math.max(0, boxWidth - 2 - labelWidth)
        return `${BOX_CHARS.teeLeft}${label}${BOX_CHARS.horizontal.repeat(fillWidth)}${BOX_CHARS.teeRight}`
      })()
    : null
  const BoxComponent = Box
  const lineElements = lines.map((line, index) => {
    const lineWidth = stringWidth(line)
    const displayLine = lineWidth > innerWidth ? sliceAnsi(line, 0, innerWidth) : line
    const padding = ' '.repeat(Math.max(0, innerWidth - stringWidth(displayLine)))
    return (
      <Box key={index} flexDirection="row">
        <Text dimColor={true}>{BOX_CHARS.vertical} </Text>
        <Ansi>{displayLine}</Ansi>
        <Text dimColor={true}>
          {padding} {BOX_CHARS.vertical}
        </Text>
      </Box>
    )
  })
  return (
    <BoxComponent flexDirection={'column'}>
      {<Text dimColor={true}>{topBorder}</Text>}
      {lineElements}
      {truncationBar && <Text color="warning">{truncationBar}</Text>}
      {<Text dimColor={true}>{bottomBorder}</Text>}
    </BoxComponent>
  )
}
