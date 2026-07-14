import chalk from 'chalk'
import { marked, type Token, type Tokens } from 'marked'
import stripAnsi from 'strip-ansi'
import { color } from '../components/design-system/color.js'
import { BLOCKQUOTE_BAR } from '../constants/figures.js'
import { stringWidth } from '../ink/stringWidth.js'
import { supportsHyperlinks } from '../ink/supports-hyperlinks.js'
import type { CliHighlight } from './cliHighlight.js'
import { logForDebugging } from './debug.js'
import { createHyperlink } from './hyperlink.js'
import { stripPromptXMLTags } from '../services/messages/./predicates.js'
import type { ThemeName } from './theme.js'

// 无条件使用 \n — os.EOL 在 Windows 上是 \r\n，多出的 \r
// 会破坏 applyStylesToWrappedText 中字符到段的映射，
// 导致样式文本向右偏移。
const EOL = '\n'

let markedConfigured = false

export function configureMarked(): void {
  if (markedConfigured) {
    return
  }
  markedConfigured = true

  // 禁用删除线解析——模型常用 ~ 表示「约等于」
  // （如 ~100），鲜少真正表示删除线格式
  marked.use({
    tokenizer: {
      del() {
        return undefined
      },
    },
  })
}

/**
 * 流式 Markdown 稳定前缀推进（对齐 CC 2.1.207 长内容流式性能路径）。
 *
 * 在块级边界切分：已闭合的块进入 stable（可 memo、不随 delta 重解析），
 * 仅最后一个未完成块留在 unstable 中每帧 re-lex。
 * marked.lexer 将未闭合 fence 视为单 token，故块边界始终安全。
 *
 * @param stripped 已 stripPromptXMLTags 的全文
 * @param prevStable 上一帧的稳定前缀（须为 stripped 的前缀，否则回退为空）
 * @returns 单调前进的 stablePrefix + 当前增长中的 unstableSuffix
 */
export function advanceStreamingMarkdownBoundary(
  stripped: string,
  prevStable: string,
): { stablePrefix: string; unstableSuffix: string } {
  configureMarked()

  let stable = stripped.startsWith(prevStable) ? prevStable : ''
  const boundary = stable.length
  const tokens = marked.lexer(stripped.substring(boundary))

  // 最后一个非 space token 是正在增长的块；之前的均为已闭合块
  let lastContentIdx = tokens.length - 1
  while (lastContentIdx >= 0 && tokens[lastContentIdx]!.type === 'space') {
    lastContentIdx--
  }
  let advance = 0
  for (let i = 0; i < lastContentIdx; i++) {
    advance += tokens[i]!.raw.length
  }
  if (advance > 0) {
    stable = stripped.substring(0, boundary + advance)
  }
  return {
    stablePrefix: stable,
    unstableSuffix: stripped.substring(stable.length),
  }
}

export function applyMarkdown(
  content: string,
  theme: ThemeName,
  highlight: CliHighlight | null = null,
): string {
  configureMarked()
  return marked
    .lexer(stripPromptXMLTags(content))
    .map((_) => formatToken(_, theme, 0, null, null, highlight))
    .join('')
    .trim()
}

export function formatToken(
  token: Token,
  theme: ThemeName,
  listDepth = 0,
  orderedListNumber: number | null = null,
  parent: Token | null = null,
  highlight: CliHighlight | null = null,
): string {
  switch (token.type) {
    case 'blockquote': {
      const inner = (token.tokens ?? [])
        .map((_) => formatToken(_, theme, 0, null, null, highlight))
        .join('')
      // 每行前缀一个暗色竖线。保持文字斜体但维持正常亮度——chalk.dim 在深色主题下几乎不可见。
      const bar = chalk.dim(BLOCKQUOTE_BAR)
      return inner
        .split(EOL)
        .map((line) => (stripAnsi(line).trim() ? `${bar} ${chalk.italic(line)}` : line))
        .join(EOL)
    }
    case 'code': {
      if (!highlight) {
        return token.text + EOL
      }
      let language = 'plaintext'
      if (token.lang) {
        if (highlight.supportsLanguage(token.lang)) {
          language = token.lang
        } else {
          logForDebugging(
            `Language not supported while highlighting code, falling back to plaintext: ${token.lang}`,
          )
        }
      }
      return highlight.highlight(token.text, { language }) + EOL
    }
    case 'codespan': {
      // 行内代码
      return color('permission', theme)(token.text)
    }
    case 'em':
      return chalk.italic(
        (token.tokens ?? []).map((_) => formatToken(_, theme, 0, null, parent, highlight)).join(''),
      )
    case 'strong':
      return chalk.bold(
        (token.tokens ?? []).map((_) => formatToken(_, theme, 0, null, parent, highlight)).join(''),
      )
    case 'heading':
      switch (token.depth) {
        case 1: // h1
          return (
            chalk.bold.italic.underline(
              (token.tokens ?? [])
                .map((_) => formatToken(_, theme, 0, null, null, highlight))
                .join(''),
            ) +
            EOL +
            EOL
          )
        case 2: // h2
          return (
            chalk.bold(
              (token.tokens ?? [])
                .map((_) => formatToken(_, theme, 0, null, null, highlight))
                .join(''),
            ) +
            EOL +
            EOL
          )
        default: // h3+
          return (
            chalk.bold(
              (token.tokens ?? [])
                .map((_) => formatToken(_, theme, 0, null, null, highlight))
                .join(''),
            ) +
            EOL +
            EOL
          )
      }
    case 'hr':
      return '---'
    case 'image':
      return token.href
    case 'link': {
      // 阻止 mailto 链接被显示为可点击链接
      if (token.href.startsWith('mailto:')) {
        // 从 mailto: 链接中提取邮箱地址并以纯文本展示
        const email = token.href.replace(/^mailto:/, '')
        return email
      }
      // 从链接的子 token 中提取显示文本
      const linkText = (token.tokens ?? [])
        .map((_) => formatToken(_, theme, 0, null, token, highlight))
        .join('')
      const plainLinkText = stripAnsi(linkText)
      // 若链接有有意义的显示文本（与 URL 不同），
      // 则渲染为可点击超链接。在支持 OSC 8 的终端中，
      // 用户看到文本并可悬停/点击查看 URL。
      if (plainLinkText && plainLinkText !== token.href) {
        return createHyperlink(token.href, linkText)
      }
      // 当显示文本与 URL 相同（或为空）时，直接展示 URL
      return createHyperlink(token.href)
    }
    case 'list': {
      return token.items
        .map((_: Token, index: number) =>
          formatToken(
            _,
            theme,
            listDepth,
            token.ordered ? token.start + index : null,
            token,
            highlight,
          ),
        )
        .join('')
    }
    case 'list_item':
      return (token.tokens ?? [])
        .map(
          (_) =>
            `${'  '.repeat(listDepth)}${formatToken(_, theme, listDepth + 1, orderedListNumber, token, highlight)}`,
        )
        .join('')
    case 'paragraph':
      return (
        (token.tokens ?? []).map((_) => formatToken(_, theme, 0, null, null, highlight)).join('') +
        EOL
      )
    case 'space':
      return EOL
    case 'br':
      return EOL
    case 'text':
      if (parent?.type === 'link') {
        // Already inside a markdown link — the link handler will wrap this
        // in an OSC 8 hyperlink. Linkifying here would nest a second OSC 8
        // sequence, and terminals honor the innermost one, overriding the
        // link's actual href.
        return token.text
      }
      if (parent?.type === 'list_item') {
        return `${orderedListNumber === null ? '-' : `${getListNumber(listDepth, orderedListNumber)}.`} ${token.tokens ? token.tokens.map((_) => formatToken(_, theme, listDepth, orderedListNumber, token, highlight)).join('') : linkifyIssueReferences(token.text)}${EOL}`
      }
      return linkifyIssueReferences(token.text)
    case 'table': {
      const tableToken = token as Tokens.Table

      // 辅助函数：获取最终显示的文本内容（经 stripAnsi 处理后）
      function getDisplayText(tokens: Token[] | undefined): string {
        return stripAnsi(
          tokens?.map((_) => formatToken(_, theme, 0, null, null, highlight)).join('') ?? '',
        )
      }

      // 根据显示内容（不含格式化字符）计算各列宽度
      const columnWidths = tableToken.header.map((header, index) => {
        let maxWidth = stringWidth(getDisplayText(header.tokens))
        for (const row of tableToken.rows) {
          const cellLength = stringWidth(getDisplayText(row[index]?.tokens))
          maxWidth = Math.max(maxWidth, cellLength)
        }
        return Math.max(maxWidth, 3) // 最小宽度为 3
      })

      // 格式化表头行
      let tableOutput = '| '
      tableToken.header.forEach((header, index) => {
        const content =
          header.tokens?.map((_) => formatToken(_, theme, 0, null, null, highlight)).join('') ?? ''
        const displayText = getDisplayText(header.tokens)
        const width = columnWidths[index]!
        const align = tableToken.align?.[index]
        tableOutput += `${padAligned(content, stringWidth(displayText), width, align)} | `
      })
      tableOutput = tableOutput.trimEnd() + EOL

      // 添加分隔行
      tableOutput += '|'
      columnWidths.forEach((width) => {
        // 始终使用短横线，输出中不显示对齐冒号
        const separator = '-'.repeat(width + 2) // +2 为两侧空格
        tableOutput += `${separator}|`
      })
      tableOutput += EOL

      // 格式化数据行
      tableToken.rows.forEach((row) => {
        tableOutput += '| '
        row.forEach((cell, index) => {
          const content =
            cell.tokens?.map((_) => formatToken(_, theme, 0, null, null, highlight)).join('') ?? ''
          const displayText = getDisplayText(cell.tokens)
          const width = columnWidths[index]!
          const align = tableToken.align?.[index]
          tableOutput += `${padAligned(content, stringWidth(displayText), width, align)} | `
        })
        tableOutput = tableOutput.trimEnd() + EOL
      })

      return tableOutput + EOL
    }
    case 'escape':
      // Markdown 转义：\) → )，\\ → \ 等
      return token.text
    case 'def':
    case 'del':
    case 'html':
      // 这些 token 类型不进行渲染
      return ''
  }
  return ''
}

// 匹配 owner/repo#NNN 格式的 GitHub issue/PR 引用。完整格式无歧义——
// 裸 #NNN 已移除，因为它猜测当前仓库，助手讨论其他仓库时会出错。
// owner 段不允许点号（GitHub 用户名仅含字母数字和连字符），
// 以防 docs.github.io/guide#42 等域名误匹配。repo 段允许点号（如 cc.kurs.web）。
// 避免使用 lookbehind——会导致 JSC 中 YARR JIT 失效。
const ISSUE_REF_PATTERN = /(^|[^\w./-])([A-Za-z0-9][\w-]*\/[A-Za-z0-9][\w.-]*)#(\d+)\b/g

/**
 * 将 owner/repo#123 格式的引用替换为指向 GitHub 的可点击超链接。
 */
function linkifyIssueReferences(text: string): string {
  if (!supportsHyperlinks()) {
    return text
  }
  return text.replace(
    ISSUE_REF_PATTERN,
    (_match, prefix, repo, num) =>
      prefix + createHyperlink(`https://github.com/${repo}/issues/${num}`, `${repo}#${num}`),
  )
}

function numberToLetter(n: number): string {
  let result = ''
  while (n > 0) {
    n--
    result = String.fromCharCode(97 + (n % 26)) + result
    n = Math.floor(n / 26)
  }
  return result
}

const ROMAN_VALUES: ReadonlyArray<[number, string]> = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
]

function numberToRoman(n: number): string {
  let result = ''
  for (const [value, numeral] of ROMAN_VALUES) {
    while (n >= value) {
      result += numeral
      n -= value
    }
  }
  return result
}

function getListNumber(listDepth: number, orderedListNumber: number): string {
  switch (listDepth) {
    case 0:
    case 1:
      return orderedListNumber.toString()
    case 2:
      return numberToLetter(orderedListNumber)
    case 3:
      return numberToRoman(orderedListNumber)
    default:
      return orderedListNumber.toString()
  }
}

/**
 * 根据对齐方式将 `content` 填充至 `targetWidth`。`displayWidth` 为 `content`
 * 的可见宽度（由调用方计算，例如对 stripAnsi 后的文本调用 stringWidth，
 * 使得 `content` 中的 ANSI 转义码不影响填充计算）。
 */
export function padAligned(
  content: string,
  displayWidth: number,
  targetWidth: number,
  align: 'left' | 'center' | 'right' | null | undefined,
): string {
  const padding = Math.max(0, targetWidth - displayWidth)
  if (align === 'center') {
    const leftPad = Math.floor(padding / 2)
    return ' '.repeat(leftPad) + content + ' '.repeat(padding - leftPad)
  }
  if (align === 'right') {
    return ' '.repeat(padding) + content
  }
  return content + ' '.repeat(padding)
}
