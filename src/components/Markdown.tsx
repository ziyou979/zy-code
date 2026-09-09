import type { Tokens } from 'marked'
import React, { Suspense, use, useRef } from 'react'
import { useSettings } from '../hooks/useSettings.js'
import { Ansi, Box, useTheme } from '../ink/index.js'
import type { CliHighlight } from '../services/terminal/cliHighlight.js'
import { getCliHighlightPromise } from '../services/terminal/cliHighlight.js'
import { cachedLexer } from '../markdown/lexerCache.js'
import {
  advanceStreamingMarkdownBoundary,
  configureMarked,
  formatToken,
} from '../markdown/markdown.js'
import { stripPromptXMLTags } from '../services/messages/./predicates.js'
import { MarkdownTable } from './MarkdownTable.js'

type Props = {
  children: string
  /** When true, render all text content as dim */
  dimColor?: boolean
}

type MarkdownBodyProps = Props & {
  highlight: CliHighlight | null
}

/**
 * Renders markdown content using a hybrid approach:
 * - Tables are rendered as React components with proper flexbox layout
 * - Other content is rendered as ANSI strings via formatToken
 */
export function Markdown(props: Props) {
  const settings = useSettings()
  if (settings.syntaxHighlightingDisabled) {
    return <MarkdownBody {...props} highlight={null} />
  }
  return (
    <Suspense fallback={<MarkdownBody {...props} highlight={null} />}>
      <MarkdownWithHighlight {...props} />
    </Suspense>
  )
}
function MarkdownWithHighlight(props: Props) {
  const highlightPromise = getCliHighlightPromise()
  const highlight = use(highlightPromise)
  return <MarkdownBody {...props} highlight={highlight} />
}
function MarkdownBody({ children, dimColor, highlight }: MarkdownBodyProps) {
  const [theme] = useTheme()
  configureMarked()
  const tokens = cachedLexer(stripPromptXMLTags(children))
  const elements = []
  let nonTableContent = ''
  const flushNonTableContent = function flushNonTableContent() {
    if (nonTableContent) {
      const trimmed = nonTableContent.trim()
      if (trimmed) {
        elements.push(
          <Ansi key={elements.length} dimColor={dimColor}>
            {trimmed}
          </Ansi>,
        )
      }
      nonTableContent = ''
    }
  }
  for (const token of tokens) {
    if (token.type === 'table') {
      flushNonTableContent()
      elements.push(
        <MarkdownTable key={elements.length} token={token as Tokens.Table} highlight={highlight} />,
      )
    } else {
      nonTableContent = nonTableContent + formatToken(token, theme, 0, null, null, highlight)
    }
  }
  flushNonTableContent()
  return (
    <Box flexDirection="column" gap={1}>
      {elements}
    </Box>
  )
}
type StreamingProps = {
  children: string
}

/**
 * Renders markdown during streaming by splitting at the last top-level block
 * boundary: everything before is stable (memoized, never re-parsed), only the
 * final block is re-parsed per delta. marked.lexer() correctly handles
 * unclosed code fences as a single token, so block boundaries are always safe.
 *
 * The stable boundary only advances (monotonic), so ref mutation during render
 * is idempotent and safe under StrictMode double-rendering. Component unmounts
 * between turns (streamingText → null), resetting the ref.
 */
export function StreamingMarkdown({ children }: StreamingProps): React.ReactNode {
  // React Compiler：此组件按设计在渲染期间读取和写入 stablePrefixRef.current。
  // 边界只前进（单调），所以在 StrictMode 双重渲染下 ref 突变是幂等的——但
  // 编译器无法证明这一点，围绕 ref 读取的 memo 会破坏算法（过时的边界）。退出优化。
  'use no memo'

  // 在边界跟踪之前剥离，使其与 <Markdown> 的剥离匹配。
  // 当闭合标签到达时，stripped(N+1) 不是 stripped(N) 的前缀，
  // advanceStreamingMarkdownBoundary 会重置 stable 并一次性 re-lex。
  const stripped = stripPromptXMLTags(children)
  const stablePrefixRef = useRef('')
  const { stablePrefix, unstableSuffix } = advanceStreamingMarkdownBoundary(
    stripped,
    stablePrefixRef.current,
  )
  stablePrefixRef.current = stablePrefix

  // stablePrefix 在 <Markdown> 内按内容缓存 token，不稳定后缀增长时不重解析稳定部分
  return (
    <Box flexDirection="column" gap={1}>
      {stablePrefix && <Markdown>{stablePrefix}</Markdown>}
      {unstableSuffix && <Markdown>{unstableSuffix}</Markdown>}
    </Box>
  )
}
