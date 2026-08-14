import { useCallback, useRef, useState } from 'react'
import type { PastedContent } from '../services/config/config.js'

export type BufferEntry = {
  text: string
  cursorOffset: number
  pastedContents: Record<number, PastedContent>
  timestamp: number
}

export type UseInputBufferProps = {
  maxBufferSize: number
  debounceMs: number
}

export type UseInputBufferResult = {
  pushToBuffer: (
    text: string,
    cursorOffset: number,
    pastedContents?: Record<number, PastedContent>,
  ) => void
  undo: () => BufferEntry | undefined
  canUndo: boolean
  clearBuffer: () => void
}

export function useInputBuffer({
  maxBufferSize,
  debounceMs,
}: UseInputBufferProps): UseInputBufferResult {
  const [buffer, setBuffer] = useState<BufferEntry[]>([])
  const [currentIndex, setCurrentIndex] = useState(-1)
  const lastPushTime = useRef<number>(0)
  const pendingPush = useRef<ReturnType<typeof setTimeout> | null>(null)

  const pushToBuffer = useCallback(
    (text: string, cursorOffset: number, pastedContents: Record<number, PastedContent> = {}) => {
      const now = Date.now()

      // 清除尚未执行的写入
      if (pendingPush.current) {
        clearTimeout(pendingPush.current)
        pendingPush.current = null
      }

      // 对连续变化做 debounce
      if (now - lastPushTime.current < debounceMs) {
        pendingPush.current = setTimeout(
          pushToBuffer,
          debounceMs,
          text,
          cursorOffset,
          pastedContents,
        )
        return
      }

      lastPushTime.current = now

      // 若当前位置不在缓冲区末尾，则截掉其后的所有内容。
      const newBuffer = currentIndex >= 0 ? buffer.slice(0, currentIndex + 1) : buffer

      // 与最后一项相同时不重复添加，也不能推进当前索引。
      const lastEntry = newBuffer[newBuffer.length - 1]
      if (lastEntry?.text === text) {
        if (newBuffer.length !== buffer.length) {
          setBuffer(newBuffer)
        }
        return
      }

      const updatedBuffer = [...newBuffer, { text, cursorOffset, pastedContents, timestamp: now }]
      const boundedBuffer =
        updatedBuffer.length > maxBufferSize ? updatedBuffer.slice(-maxBufferSize) : updatedBuffer
      setBuffer(boundedBuffer)
      setCurrentIndex(boundedBuffer.length - 1)
    },
    [debounceMs, maxBufferSize, currentIndex, buffer],
  )

  const undo = useCallback((): BufferEntry | undefined => {
    if (currentIndex < 0 || buffer.length === 0) {
      return undefined
    }

    const targetIndex = Math.max(0, currentIndex - 1)
    const entry = buffer[targetIndex]

    if (entry) {
      setCurrentIndex(targetIndex)
      return entry
    }

    return undefined
  }, [buffer, currentIndex])

  const clearBuffer = useCallback(() => {
    setBuffer([])
    setCurrentIndex(-1)
    lastPushTime.current = 0
    if (pendingPush.current) {
      clearTimeout(pendingPush.current)
      pendingPush.current = null
    }
  }, [])

  const canUndo = currentIndex > 0 && buffer.length > 1

  return {
    pushToBuffer,
    undo,
    canUndo,
    clearBuffer,
  }
}
