import type { TextBlock } from '../../types/llm.js'
import * as React from 'react'
import { CHANNEL_ARROW } from '../../constants/figures.js'
import { CHANNEL_TAG } from '../../constants/xml.js'
import { Box, Text } from '../../ink.js'
import { truncateToWidth } from '../../utils/format.js'
type Props = {
  addMargin: boolean
  param: TextBlock
}

// <channel source="..." user="..." chat_id="...">content</channel>
// source is always first (wrapChannelMessage writes it), user is optional.
const CHANNEL_RE = new RegExp(
  `<${CHANNEL_TAG}\\s+source="([^"]+)"([^>]*)>\\n?([\\s\\S]*?)\\n?</${CHANNEL_TAG}>`,
)
const USER_ATTR_RE = /\buser="([^"]+)"/

// 插件提供的服务器通过 addPluginScopeToServers 获得类似 plugin:slack-channel:slack 的名称
// ——仅显示叶子节点。与 isServerInChannels 中的后缀匹配逻辑一致。
function displayServerName(name: string): string {
  const i = name.lastIndexOf(':')
  return i === -1 ? name : name.slice(i + 1)
}
const TRUNCATE_AT = 60
export function UserChannelMessage({ addMargin, param }: Props) {
  const { text } = param
  const channelMatched = CHANNEL_RE.exec(text)

  if (!channelMatched) {
    return null
  }

  const [, source, attrs, content] = channelMatched
  const user = USER_ATTR_RE.exec(attrs ?? '')?.[1]
  const body = (content ?? '').trim().replace(/\s+/g, ' ')
  const truncated = truncateToWidth(body, TRUNCATE_AT)
  const conditionalValue = addMargin ? 1 : 0
  const textElement = <Text color="suggestion">{CHANNEL_ARROW}</Text>
  const displayServerNameResult = displayServerName(source ?? '')

  return (
    <Box marginTop={conditionalValue}>
      {
        <Text>
          {textElement}{' '}
          {
            <Text dimColor={true}>
              {displayServerNameResult}
              {user ? ` \u00b7 ${user}` : ''}:
            </Text>
          }{' '}
          {truncated}
        </Text>
      }
    </Box>
  )
}
