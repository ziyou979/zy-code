import { feature } from 'bun:bundle'
import figures from 'figures'
import * as React from 'react'
import type { z } from 'zod/v4'
import { ProgressBar } from '../../components/design-system/ProgressBar.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { linkifyUrlsInText, OutputLine } from '../../components/shell/OutputLine.js'
import { tSync } from '../../i18n/index.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { Ansi, Box, Text } from '../../ink.js'
import type { ToolProgressData } from '../../Tool.js'
import type { ProgressMessage } from '../../types/message.js'
import type { MCPProgress } from '../../types/tools.js'
import { formatNumber } from '../../utils/format.js'
import { createHyperlink } from '../../utils/hyperlink.js'
import { getContentSizeEstimate, type MCPToolResult } from '../../utils/mcpValidation.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import type { inputSchema } from './MCPTool.js'

// 显示大型 MCP 响应警告的阈值
const MCP_OUTPUT_WARNING_THRESHOLD_TOKENS = 10_000

// 非详细模式下截断单个输入值以保持标题紧凑。与 BashTool 的理念一致：显示足以识别调用的内容，而不内联输出整个负载。
const MAX_INPUT_VALUE_CHARS = 80

// 回退到原始 JSON 显示前的顶层键最大数量。
// 超过此数量，扁平的 k:v 列表只会增加噪音。
const MAX_FLAT_JSON_KEYS = 12

// 不尝试对大型 blob 进行扁平对象解析。
const MAX_FLAT_JSON_CHARS = 5_000

// 不尝试解析超过此大小的 JSON blob（性能安全）。
const MAX_JSON_PARSE_CHARS = 200_000

// 如果字符串值包含换行符或足够长以至于内联显示不如展开，则视为“主导文本负载”。
const UNWRAP_MIN_STRING_LEN = 200
export function renderToolUseMessage(
  input: z.infer<ReturnType<typeof inputSchema>>,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (Object.keys(input).length === 0) {
    return ''
  }
  return Object.entries(input)
    .map(([key, value]) => {
      let rendered = jsonStringify(value)
      if (feature('MCP_RICH_OUTPUT') && !verbose && rendered.length > MAX_INPUT_VALUE_CHARS) {
        rendered = rendered.slice(0, MAX_INPUT_VALUE_CHARS).trimEnd() + '…'
      }
      return `${key}: ${rendered}`
    })
    .join(', ')
}
export function renderToolUseProgressMessage(
  progressMessagesForMessage: ProgressMessage<MCPProgress>[],
): React.ReactNode {
  const lastProgress = progressMessagesForMessage.at(-1)
  if (!lastProgress?.data) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>{tSync('bash.running')}</Text>
      </MessageResponse>
    )
  }
  const { progress, total, progressMessage } = lastProgress.data
  if (progress === undefined) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>{tSync('bash.running')}</Text>
      </MessageResponse>
    )
  }
  if (total !== undefined && total > 0) {
    const ratio = Math.min(1, Math.max(0, progress / total))
    const percentage = Math.round(ratio * 100)
    return (
      <MessageResponse>
        <Box flexDirection="column">
          {progressMessage && <Text dimColor>{progressMessage}</Text>}
          <Box flexDirection="row" gap={1}>
            <ProgressBar ratio={ratio} width={20} />
            <Text dimColor>{percentage}%</Text>
          </Box>
        </Box>
      </MessageResponse>
    )
  }
  return (
    <MessageResponse height={1}>
      <Text dimColor>{progressMessage ?? tSync('mcp.processing', { progress })}</Text>
    </MessageResponse>
  )
}
export function renderToolResultMessage(
  output: string | MCPToolResult,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  { verbose, input }: { verbose: boolean; input?: unknown },
): React.ReactNode {
  const mcpOutput = output as MCPToolResult
  if (!verbose) {
    const slackSend = trySlackSendCompact(mcpOutput, input)
    if (slackSend !== null) {
      return (
        <MessageResponse height={1}>
          <Text>
            {tSync('mcp.sentMessageTo')}{' '}
            <Ansi>{createHyperlink(slackSend.url, slackSend.channel)}</Ansi>
          </Text>
        </MessageResponse>
      )
    }
  }
  const estimatedTokens = getContentSizeEstimate(mcpOutput)
  const showWarning = estimatedTokens > MCP_OUTPUT_WARNING_THRESHOLD_TOKENS
  const warningMessage = showWarning
    ? tSync('mcp.largeResponseWarning', {
        warning: figures.warning,
        tokens: formatNumber(estimatedTokens),
      })
    : null
  let contentElement: React.ReactNode
  if (Array.isArray(mcpOutput)) {
    const contentBlocks = mcpOutput.map((item, i) => {
      if (item.type === 'image') {
        return (
          <Box key={i} justifyContent="space-between" overflowX="hidden" width="100%">
            <MessageResponse height={1}>
              <Text>{tSync('mcp.image')}</Text>
            </MessageResponse>
          </Box>
        )
      }
      // 对于文本块和其他块类型，如果可用则提取文本
      const textContent =
        item.type === 'text' && 'text' in item && item.text !== null && item.text !== undefined
          ? String(item.text)
          : ''
      return feature('MCP_RICH_OUTPUT') ? (
        <MCPTextOutput key={i} content={textContent} verbose={verbose} />
      ) : (
        <OutputLine key={i} content={textContent} verbose={verbose} />
      )
    })

    // 将数组内容包裹在列布局中
    contentElement = (
      <Box flexDirection="column" width="100%">
        {contentBlocks}
      </Box>
    )
  } else if (!mcpOutput) {
    contentElement = (
      <Box justifyContent="space-between" overflowX="hidden" width="100%">
        <MessageResponse height={1}>
          <Text dimColor>{tSync('mcp.noContent')}</Text>
        </MessageResponse>
      </Box>
    )
  } else {
    contentElement = feature('MCP_RICH_OUTPUT') ? (
      <MCPTextOutput content={mcpOutput} verbose={verbose} />
    ) : (
      <OutputLine content={mcpOutput} verbose={verbose} />
    )
  }
  if (warningMessage) {
    return (
      <Box flexDirection="column">
        <MessageResponse height={1}>
          <Text color="warning">{warningMessage}</Text>
        </MessageResponse>
        {contentElement}
      </Box>
    )
  }
  return contentElement
}

/**
 * 渲染 MCP 文本输出。按顺序尝试三种策略：1. 如果 JSON 包裹单个主导文本负载...展开并让 OutputLine 截断。2. 如果 JSON 是小型扁平对象，渲染为对齐的 key: value。3. 否则回退到 OutputLine（美化打印 + 截断）。
 */
function MCPTextOutput({
  content,
  verbose,
}: {
  content: string
  verbose: boolean
}): React.ReactNode {
  let earlyReturn: React.ReactNode | symbol = Symbol.for('react.early_return_sentinel')
  const unwrapped = tryUnwrapTextPayload(content)
  if (unwrapped !== null) {
    earlyReturn = (
      <MessageResponse>
        <Box flexDirection="column">
          {unwrapped.extras.length > 0 && (
            <Text dimColor={true}>
              {unwrapped.extras
                .map((t0) => {
                  const [k, v] = t0
                  return `${k}: ${v}`
                })
                .join(' \xB7 ')}
            </Text>
          )}
          {<OutputLine content={unwrapped.body} verbose={verbose} linkifyUrls={true} />}
        </Box>
      </MessageResponse>
    )
  }
  if (earlyReturn !== Symbol.for('react.early_return_sentinel')) {
    return earlyReturn as any
  }
  let earlyReturn2: React.ReactNode | symbol = Symbol.for('react.early_return_sentinel')
  const flat = tryFlattenJson(content)
  if (flat !== null) {
    const maxKeyWidth = Math.max(
      ...flat.map((t0) => {
        const [k_0] = t0
        return stringWidth(k_0)
      }),
    )
    earlyReturn2 = (
      <MessageResponse>
        {
          <Box flexDirection="column">
            {flat.map((t4, i) => {
              const [key, value] = t4
              return (
                <Text key={i}>
                  <Text dimColor={true}>{key.padEnd(maxKeyWidth)}: </Text>
                  <Ansi>{linkifyUrlsInText(value)}</Ansi>
                </Text>
              )
            })}
          </Box>
        }
      </MessageResponse>
    )
  }
  if (earlyReturn2 !== Symbol.for('react.early_return_sentinel')) {
    return earlyReturn2 as any
  }
  return <OutputLine content={content as any} verbose={verbose} linkifyUrls={true} />
}

/**
 * 将内容解析为 JSON 对象并返回其条目。如果内容无法解析、不是对象、太大或键数为 0/过多，则返回 null。
 */

function parseJsonEntries(
  content: string,
  { maxChars, maxKeys }: { maxChars: number; maxKeys: number },
): [string, unknown][] | null {
  const trimmed = content.trim()
  if (trimmed.length === 0 || trimmed.length > maxChars || trimmed[0] !== '{') {
    return null
  }
  let parsed: unknown
  try {
    parsed = jsonParse(trimmed)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  const entries = Object.entries(parsed)
  if (entries.length === 0 || entries.length > maxKeys) {
    return null
  }
  return entries
}

/**
 * 如果内容可解析为每个值都是标量或小型嵌套对象的 JSON 对象，则展平为 [key, displayValue] 对。嵌套对象取单行 JSON。不符合条件则返回 null。
 */
export function tryFlattenJson(content: string): [string, string][] | null {
  const entries = parseJsonEntries(content, {
    maxChars: MAX_FLAT_JSON_CHARS,
    maxKeys: MAX_FLAT_JSON_KEYS,
  })
  if (entries === null) return null
  const result: [string, string][] = []
  for (const [key, value] of entries) {
    if (typeof value === 'string') {
      result.push([key, value])
    } else if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      result.push([key, String(value)])
    } else if (typeof value === 'object') {
      const compact = jsonStringify(value)
      if (compact.length > 120) return null
      result.push([key, compact])
    } else {
      return null
    }
  }
  return result
}

/**
 * 如果内容是 JSON 对象，其中一个键包含主导字符串负载（多行或长）且其余兄弟节点是小标量，则展开。处理常见 MCP 模式如 {"messages":"line1\nline2..."}，美化打印会转义 \n，但我们需要真正的换行符 + 截断。
 */
export function tryUnwrapTextPayload(content: string): {
  body: string
  extras: [string, string][]
} | null {
  const entries = parseJsonEntries(content, {
    maxChars: MAX_JSON_PARSE_CHARS,
    maxKeys: 4,
  })
  if (entries === null) return null
  // 找到主导字符串负载。先 trim：短兄弟节点上的尾随 \n（如分页提示）不应使其成为“主导”。
  let body: string | null = null
  const extras: [string, string][] = []
  for (const [key, value] of entries) {
    if (typeof value === 'string') {
      const t = value.trimEnd()
      const isDominant = t.length > UNWRAP_MIN_STRING_LEN || (t.includes('\n') && t.length > 50)
      if (isDominant) {
        if (body !== null) return null // 两个大字符串 — 无法判断
        body = t
        continue
      }
      if (t.length > 150) return null
      extras.push([key, t.replace(/\s+/g, ' ')])
    } else if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      extras.push([key, String(value)])
    } else {
      return null // 嵌套对象/数组 — 使用扁平或美化打印路径
    }
  }
  if (body === null) return null
  return {
    body,
    extras,
  }
}
const SLACK_ARCHIVES_RE = /^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p\d+$/

/**
 * 检测 Slack 发送消息结果并返回紧凑的 {channel, url} 对。匹配托管和社区 MCP 服务器 — 两者都在结果中返回 `message_link`。频道标签优先使用工具输入（可能是 "#foo" 或 ID），否则回退到从归档 URL 解析的 ID。
 */
export function trySlackSendCompact(
  output: string | MCPToolResult,
  input: unknown,
): {
  channel: string
  url: string
} | null {
  let text: unknown = output
  if (Array.isArray(output)) {
    const block = output.find((b) => b.type === 'text')
    text = block && 'text' in block ? block.text : undefined
  }
  if (typeof text !== 'string' || !text.includes('"message_link"')) {
    return null
  }
  const entries = parseJsonEntries(text, {
    maxChars: 2000,
    maxKeys: 6,
  })
  const url = entries?.find(([k]) => k === 'message_link')?.[1]
  if (typeof url !== 'string') return null
  const m = SLACK_ARCHIVES_RE.exec(url)
  if (!m) return null
  const inp = input as
    | {
        channel_id?: unknown
        channel?: unknown
      }
    | undefined
  const raw = inp?.channel_id ?? inp?.channel ?? m[1]
  const label = typeof raw === 'string' && raw ? raw : 'slack'
  return {
    channel: label.startsWith('#') ? label : `#${label}`,
    url,
  }
}
