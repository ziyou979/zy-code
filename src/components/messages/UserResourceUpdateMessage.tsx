import type React from 'react'
import { REFRESH_ARROW } from '../../constants/figures.js'
import { Box, Text } from '../../ink/index.js'
import type { TextBlock } from '../../types/llm.js'

type Props = {
  addMargin: boolean
  param: TextBlock
}
type ParsedUpdate = {
  kind: 'resource' | 'polling'
  server: string
  /** URI for resource updates, tool name for polling updates */
  target: string
  reason?: string
}

// 从 XML 格式解析 resource 和 polling 更新
function parseUpdates(text: string): ParsedUpdate[] {
  const updates: ParsedUpdate[] = []

  // 匹配 <mcp-resource-update server="..." uri="...">
  const resourceRegex =
    /<mcp-resource-update\s+server="([^"]+)"\s+uri="([^"]+)"[^>]*>(?:[\s\S]*?<reason>([^<]+)<\/reason>)?/g
  let match
  while ((match = resourceRegex.exec(text)) !== null) {
    updates.push({
      kind: 'resource',
      server: match[1] ?? '',
      target: match[2] ?? '',
      reason: match[3],
    })
  }

  // 匹配 <mcp-polling-update type="tool" server="..." tool="...">
  const pollingRegex =
    /<mcp-polling-update\s+type="([^"]+)"\s+server="([^"]+)"\s+tool="([^"]+)"[^>]*>(?:[\s\S]*?<reason>([^<]+)<\/reason>)?/g
  while ((match = pollingRegex.exec(text)) !== null) {
    updates.push({
      kind: 'polling',
      server: match[2] ?? '',
      target: match[3] ?? '',
      reason: match[4],
    })
  }
  return updates
}

// 格式化 URI 用于显示——仅展示有意义的部分
function formatUri(uri: string): string {
  // 对于 file:// URI，仅显示文件名
  if (uri.startsWith('file://')) {
    const path = uri.slice(7)
    const parts = path.split('/')
    return parts[parts.length - 1] || path
  }
  // 对于其他 URI，显示完整内容但进行截断
  if (uri.length > 40) {
    return `${uri.slice(0, 39)}\u2026`
  }
  return uri
}
export function UserResourceUpdateMessage({ addMargin, param }: Props) {
  const { text } = param
  let BoxComponent!: typeof Box

  let conditionalValue
  let mappedItems
  let earlyReturn: React.ReactNode | symbol
  earlyReturn = Symbol.for('react.early_return_sentinel')
  const updates = parseUpdates(text)
  if (updates.length === 0) {
    earlyReturn = null
  } else {
    BoxComponent = Box

    conditionalValue = addMargin ? 1 : 0
    mappedItems = updates.map((update, i) => (
      <Box key={i}>
        <Text>
          <Text color="success">{REFRESH_ARROW}</Text> <Text dimColor={true}>{update.server}:</Text>{' '}
          <Text color="suggestion">
            {update.kind === 'resource' ? formatUri(update.target) : update.target}
          </Text>
          {update.reason && <Text dimColor={true}> · {update.reason}</Text>}
        </Text>
      </Box>
    ))
  }
  if (earlyReturn !== Symbol.for('react.early_return_sentinel')) {
    return earlyReturn as React.ReactNode
  }
  return (
    <BoxComponent flexDirection={'column'} marginTop={conditionalValue}>
      {mappedItems}
    </BoxComponent>
  )
}
