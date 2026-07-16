import React, { useLayoutEffect, useRef, useState } from 'react'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import type { DOMElement } from '../../ink/dom.js'
import { useTerminalViewport } from '../../ink/hooks/use-terminal-viewport.js'
import { Box, measureElement } from '../../ink/index.js'

type Props = {
  children: React.ReactNode
  lock?: 'always' | 'offscreen'
}
export function Ratchet({ children, lock = 'always' }: Props) {
  const [viewportRef, viewportState] = useTerminalViewport()
  const { isVisible } = viewportState
  const { rows, columns } = useTerminalSize()
  const innerRef = useRef(null)
  const maxHeight = useRef(0)
  const [minHeight, setMinHeight] = useState(0)
  // 宽度变化时重置 maxHeight：旧宽度下内容更高（换行更多），
  // 新宽度下内容变矮，但 maxHeight 保留旧值会导致 minHeight
  // 强制 Box 占用过多空间 → 空行。宽度变化后重新从当前高度开始跟踪。
  const prevColumns = useRef(columns)
  if (prevColumns.current !== columns) {
    prevColumns.current = columns
    maxHeight.current = 0
    setMinHeight(0)
  }
  const outerRef = (el: DOMElement | null) => {
    viewportRef(el)
  }
  const engaged = lock === 'always' || !isVisible
  useLayoutEffect(() => {
    if (!innerRef.current) {
      return
    }
    const { height } = measureElement(innerRef.current)
    if (height > maxHeight.current) {
      maxHeight.current = Math.min(height, rows)
      setMinHeight(maxHeight.current)
    }
  })
  return (
    <Box minHeight={engaged ? minHeight : undefined} ref={outerRef}>
      {
        <Box ref={innerRef} flexDirection="column">
          {children}
        </Box>
      }
    </Box>
  )
}
