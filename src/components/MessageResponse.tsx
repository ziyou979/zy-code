import * as React from 'react'
import { useContext } from 'react'
import { Box, NoSelect, Text } from '../ink.js'
import { Ratchet } from './design-system/Ratchet.js'

type Props = {
  children: React.ReactNode
  height?: number
}
export function MessageResponse({ children, height }: Props) {
  const isMessageResponse = useContext(MessageResponseContext)
  if (isMessageResponse) {
    return children
  }
  const content = (
    <MessageResponseProvider>
      <Box flexDirection="row" height={height} overflowY="hidden">
        {
          <NoSelect fromLeftEdge={true} flexShrink={0}>
            <Text dimColor={true}>{'  '}⎿  </Text>
          </NoSelect>
        }
        {
          <Box flexShrink={1} flexGrow={1}>
            {children}
          </Box>
        }
      </Box>
    </MessageResponseProvider>
  )
  if (height !== undefined) {
    return content
  }
  return <Ratchet lock="offscreen">{content}</Ratchet>
}

// 此上下文用于确定消息响应是否
// 作为另一个 MessageResponse 的后代渲染。我们用它
// 来避免渲染嵌套的 ⎿ 字符。
let MessageResponseContext
MessageResponseContext = React.createContext(false)
function MessageResponseProvider({ children }: Props) {
  return <MessageResponseContext.Provider value={true}>{children}</MessageResponseContext.Provider>
}
