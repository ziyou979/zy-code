import { marked, type Token, type Tokens } from 'marked'
import React, { Suspense, use, useRef } from 'react'
import { useSettings } from '../hooks/useSettings.js'
import { Box, useTheme } from '../ink.js'
import type { CliHighlight } from '../utils/cliHighlight.js'
import { getCliHighlightPromise } from '../utils/cliHighlight.js'
import { hashContent } from '../utils/hash.js'
import { configureMarked, formatToken } from '../utils/markdown.js'
import { stripPromptXMLTags } from '../utils/messages.js'
import { renderContentWithFileLinks } from './FilePathLink.js'
import { MarkdownTable } from './MarkdownTable.js'

type Props = {
  children: string
  /** When true, render all text content as dim */
  dimColor?: boolean
}

type MarkdownBodyProps = Props & {
  highlight: CliHighlight | null
}

// 模块级 token 缓存——marked.lexer 是虚拟滚动重新挂载时的热点成本
//（每条消息约 3ms）。useMemo 在 unmount→remount 时不存活，所以
// 滚动回之前可见的消息会重新解析。消息在历史中是不可变的；
// 相同内容 → 相同 token。按 hash 键控以避免保留完整内容字符串
//（turn50→turn99 RSS 回归，#24180）。
const TOKEN_CACHE_MAX = 500
const tokenCache = new Map<string, Token[]>()

// 表示 markdown 语法的字符。如果不存在，完全跳过
// 约 3ms 的 marked.lexer 调用——渲染为单个段落。涵盖
// 大多数短助手回复和用户提示，它们都是普通句子。
// 通过 indexOf 检查（非正则）以提高速度。
// 单个正则：匹配任何 MD 标记或有序列表开始（行首的 N.）。
// 一次扫描代替 10 次 includes 扫描。
const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /
function hasMarkdownSyntax(s: string): boolean {
  // 采样前 500 个字符——如果存在 markdown，通常在早期（标题、代码围栏、列表）。
  // 长工具输出大多是纯文本尾部。
  return MD_SYNTAX_RE.test(s.length > 500 ? s.slice(0, 500) : s)
}

function cachedLexer(content: string): Token[] {
  // 快速路径：没有 markdown 语法的纯文本 → 单个段落 token。
  // 跳过 marked.lexer 的完整 GFM 解析（长内容约 3ms）。不缓存——
  // 重建是单次对象分配，缓存会保留 4 倍内容的 raw/text 字段
  // 加上 hash 键，零收益。
  if (!hasMarkdownSyntax(content)) {
    return [
      {
        type: 'paragraph',
        raw: content,
        text: content,
        tokens: [
          {
            type: 'text',
            raw: content,
            text: content,
          },
        ],
      } as Token,
    ]
  }
  const key = hashContent(content)
  const hit = tokenCache.get(key)
  if (hit) {
    // 提升为 MRU——没有这个的话驱逐是 FIFO（滚动回早期消息会驱逐你正在看的项目）。
    tokenCache.delete(key)
    tokenCache.set(key, hit)
    return hit
  }
  const tokens = marked.lexer(content)
  if (tokenCache.size >= TOKEN_CACHE_MAX) {
    // 类 LRU：丢弃最老的。Map 保留插入顺序。
    const first = tokenCache.keys().next().value
    if (first !== undefined) tokenCache.delete(first)
  }
  tokenCache.set(key, tokens)
  return tokens
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
        const nodes = renderContentWithFileLinks(trimmed, dimColor as boolean)
        elements.push(...nodes)
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

  configureMarked()

  // 在边界跟踪之前剥离，使其与 <Markdown> 的剥离匹配（第 29 行）。
  // 当闭合标签到达时，stripped(N+1) 不是 stripped(N) 的前缀，
  // 但下方的 startsWith 重置通过一次性重新词法分析较小的 stripped 字符串处理这个问题。
  const stripped = stripPromptXMLTags(children)
  const stablePrefixRef = useRef('')

  // 如果文本被替换则重置（防御性；通常 unmount 处理这个）
  if (!stripped.startsWith(stablePrefixRef.current)) {
    stablePrefixRef.current = ''
  }

  // 仅从当前边界开始词法分析——O(不稳定长度)，而非 O(全文)
  const boundary = stablePrefixRef.current.length
  const tokens = marked.lexer(stripped.substring(boundary))

  // 最后一个非空格 token 是正在增长的块；之前的都是最终内容
  let lastContentIdx = tokens.length - 1
  while (lastContentIdx >= 0 && tokens[lastContentIdx]!.type === 'space') {
    lastContentIdx--
  }
  let advance = 0
  for (let i = 0; i < lastContentIdx; i++) {
    advance += tokens[i]!.raw.length
  }
  if (advance > 0) {
    stablePrefixRef.current = stripped.substring(0, boundary + advance)
  }
  const stablePrefix = stablePrefixRef.current
  const unstableSuffix = stripped.substring(stablePrefix.length)

  // stablePrefix 在 <Markdown> 内通过 useMemo([children, ...]) memo 化
  // 所以当不稳定后缀增长时它不会重新解析
  return (
    <Box flexDirection="column" gap={1}>
      {stablePrefix && <Markdown>{stablePrefix}</Markdown>}
      {unstableSuffix && <Markdown>{unstableSuffix}</Markdown>}
    </Box>
  )
}
