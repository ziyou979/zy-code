import * as React from 'react'
import { Box } from '../ink/index.js'

type QueuedMessageContextValue = {
  isQueued: boolean
  isFirst: boolean
  /** 容器 padding 占用的宽度，例如 paddingX={2} 时为 4。 */
  paddingWidth: number
}
const QueuedMessageContext = React.createContext<QueuedMessageContextValue | undefined>(undefined)
export function useQueuedMessage() {
  return React.useContext(QueuedMessageContext)
}
const PADDING_X = 2
type Props = {
  isFirst: boolean
  useBriefLayout?: boolean
  children: React.ReactNode
}
export function QueuedMessageProvider({ isFirst, useBriefLayout, children }: Props) {
  const padding = useBriefLayout ? 0 : PADDING_X
  const value = {
    isQueued: true,
    isFirst,
    paddingWidth: padding * 2,
  }
  return (
    <QueuedMessageContext.Provider value={value}>
      {<Box paddingX={padding}>{children}</Box>}
    </QueuedMessageContext.Provider>
  )
}
