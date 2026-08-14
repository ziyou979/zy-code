import { basename } from 'node:path'
import React from 'react'
import { logError } from 'src/services/infra/log.js'
import { useDebounceCallback } from 'usehooks-ts'
import type { InputEvent, Key } from '../ink/index.js'
import {
  getImageFromClipboard,
  isImageFilePath,
  PASTE_THRESHOLD,
  tryReadImageFromPath,
} from '../services/attachments/imagePaste.js'
import type { ImageDimensions } from '../services/attachments/imageResizer.js'
import { getPlatform } from '../services/shell/platform.js'

const CLIPBOARD_CHECK_DEBOUNCE_MS = 50
const PASTE_COMPLETION_TIMEOUT_MS = 100

type PasteHandlerProps = {
  onPaste?: (text: string) => void
  onInput: (input: string, key: Key) => void
  onImagePaste?: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    sourcePath?: string,
  ) => void
}

export function usePasteHandler({ onPaste, onInput, onImagePaste }: PasteHandlerProps): {
  wrappedOnInput: (input: string, key: Key, event: InputEvent) => void
  pasteState: {
    chunks: string[]
    timeoutId: ReturnType<typeof setTimeout> | null
  }
  isPasting: boolean
} {
  const [pasteState, setPasteState] = React.useState<{
    chunks: string[]
    timeoutId: ReturnType<typeof setTimeout> | null
  }>({ chunks: [], timeoutId: null })
  const [isPasting, setIsPasting] = React.useState(false)
  const isMountedRef = React.useRef(true)
  // Mirrors pasteState.timeoutId but updated synchronously. When paste + a
  // keystroke arrive in the same stdin chunk, both wrappedOnInput calls run
  // in the same discreteUpdates batch before React commits — the second call
  // reads stale pasteState.timeoutId (null) and takes the onInput path. If
  // that key is Enter, it submits the old input and the paste is lost.
  const pastePendingRef = React.useRef(false)

  const isMacOS = React.useMemo(() => getPlatform() === 'macos', [])

  React.useEffect(() => {
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const checkClipboardForImageImpl = React.useCallback(() => {
    if (!onImagePaste || !isMountedRef.current) {
      return
    }

    void getImageFromClipboard()
      .then((imageData) => {
        if (imageData && isMountedRef.current) {
          onImagePaste(
            imageData.base64,
            imageData.mediaType,
            undefined, // no filename for clipboard images
            imageData.dimensions,
          )
        }
      })
      .catch((error) => {
        if (isMountedRef.current) {
          logError(error as Error)
        }
      })
      .finally(() => {
        if (isMountedRef.current) {
          setIsPasting(false)
        }
      })
  }, [onImagePaste])

  const checkClipboardForImage = useDebounceCallback(
    checkClipboardForImageImpl,
    CLIPBOARD_CHECK_DEBOUNCE_MS,
  )

  const resetPasteTimeout = React.useCallback(
    (currentTimeoutId: ReturnType<typeof setTimeout> | null) => {
      if (currentTimeoutId) {
        clearTimeout(currentTimeoutId)
      }
      return setTimeout(
        (
          setPasteState,
          onImagePaste,
          onPaste,
          setIsPasting,
          checkClipboardForImage,
          isMacOS,
          pastePendingRef,
        ) => {
          pastePendingRef.current = false
          setPasteState(({ chunks }) => {
            // 合并 chunk 并过滤孤立的焦点序列；粘贴期间焦点事件被拆分时可能出现这些序列
            const pastedText = chunks.join('').replace(/\[I$/, '').replace(/\[O$/, '')

            // 检查粘贴文本是否包含图片文件路径。拖入多张图片时可能收到：
            // 1. 以换行分隔的路径（部分终端常见）
            // 2. 以空格分隔的路径（从 Finder 拖入时常见）
            // 对空格分隔路径，在绝对路径前的空格处分割：
            // - Unix：空格后跟 `/`（如 `/Users/...`）
            // - Windows：空格后跟盘符和 `:\`（如 `C:\Users\...`）
            // 路径内部的空格会被转义（如 `file\ name.png`），因此此方法可行
            const lines = pastedText
              .split(/ (?=\/|[A-Za-z]:\\)/)
              .flatMap((part) => part.split('\n'))
              .filter((line) => line.trim())
            const imagePaths = lines.filter((line) => isImageFilePath(line))

            if (onImagePaste && imagePaths.length > 0) {
              const isTempScreenshot = /\/TemporaryItems\/.*screencaptureui.*\/Screenshot/i.test(
                pastedText,
              )

              // 处理所有图片路径
              void Promise.all(imagePaths.map((imagePath) => tryReadImageFromPath(imagePath))).then(
                (results) => {
                  const validImages = results.filter((r): r is NonNullable<typeof r> => r !== null)

                  if (validImages.length > 0) {
                    // 至少成功读取一张图片
                    for (const imageData of validImages) {
                      const filename = basename(imageData.path)
                      onImagePaste(
                        imageData.base64,
                        imageData.mediaType,
                        filename,
                        imageData.dimensions,
                        imageData.path,
                      )
                    }
                    // 部分路径不是图片时，将其作为文本粘贴
                    const nonImageLines = lines.filter((line) => !isImageFilePath(line))
                    if (nonImageLines.length > 0 && onPaste) {
                      onPaste(nonImageLines.join('\n'))
                    }
                    setIsPasting(false)
                  } else if (isTempScreenshot && isMacOS) {
                    // 临时截图文件已不存在时，尝试读取剪贴板
                    checkClipboardForImage()
                  } else {
                    if (onPaste) {
                      onPaste(pastedText)
                    }
                    setIsPasting(false)
                  }
                },
              )
              return { chunks: [], timeoutId: null }
            }

            // 粘贴内容为空（使用 Cmd+V 粘贴图片时常见）时，检查剪贴板中是否有图片（仅 macOS）
            if (isMacOS && onImagePaste && pastedText.length === 0) {
              checkClipboardForImage()
              return { chunks: [], timeoutId: null }
            }

            // 处理普通粘贴
            if (onPaste) {
              onPaste(pastedText)
            }
            // 粘贴完成后重置 isPasting 状态
            setIsPasting(false)
            return { chunks: [], timeoutId: null }
          })
        },
        PASTE_COMPLETION_TIMEOUT_MS,
        setPasteState,
        onImagePaste,
        onPaste,
        setIsPasting,
        checkClipboardForImage,
        isMacOS,
        pastePendingRef,
      )
    },
    [checkClipboardForImage, isMacOS, onImagePaste, onPaste],
  )

  // 现在通过 InputEvent 的 keypress.isPasted flag 检测粘贴；keypress parser
  // 检测到 bracketed paste mode 时会设置该值。这避免了 stdin 上多个 listener
  // 引发的竞态。此前这里的 stdin.on('data') listener 会与 App.tsx 中的
  // 'readable' listener 竞争，导致字符丢失。

  const wrappedOnInput = (input: string, key: Key, event: InputEvent): void => {
    // 从解析后的 keypress event 检测粘贴；bracketed paste 内的内容会被 parser
    // 标记为 isPasted=true。
    const isFromPaste = event.keypress.isPasted

    // 内容来自粘贴时设置 isPasting 状态，供 UI 反馈
    if (isFromPaste) {
      setIsPasting(true)
    }

    // 处理超过 PASTE_THRESHOLD 个字符的大段粘贴。通常每次只收到一两个输入字符，
    // 超过阈值基本可判定为粘贴。但 Node 会分批处理长粘贴，因此可能先看到 1024 个字符，
    // 下一帧又收到属于同次粘贴的少量字符；每批数量并不固定。

    // 处理可能的图片文件名，即使短于粘贴阈值。拖入多张图片时，路径可能以换行或空格分隔。
    // 在绝对路径前的空格处分割：Unix 为 ` /`，Windows 为 ` C:\` 等。
    const hasImageFilePath = input
      .split(/ (?=\/|[A-Za-z]:\\)/)
      .flatMap((part) => part.split('\n'))
      .some((line) => isImageFilePath(line.trim()))

    // 处理空粘贴（macOS 剪贴板图片）。用户用 Cmd+V 粘贴图片时，终端会发送空的
    // bracketed paste sequence；keypress parser 将其作为 isPasted=true 且 input 为空发出。
    if (isFromPaste && input.length === 0 && isMacOS && onImagePaste) {
      checkClipboardForImage()
      // 没有文本内容可处理，重置 isPasting
      setIsPasting(false)
      return
    }

    // 检查是否应按粘贴处理：bracketed paste、大段输入或前次粘贴的延续
    const shouldHandleAsPaste =
      onPaste &&
      (input.length > PASTE_THRESHOLD || pastePendingRef.current || hasImageFilePath || isFromPaste)

    if (shouldHandleAsPaste) {
      pastePendingRef.current = true
      setPasteState(({ chunks, timeoutId }) => {
        return {
          chunks: [...chunks, input],
          timeoutId: resetPasteTimeout(timeoutId),
        }
      })
      return
    }
    onInput(input, key)
    if (input.length > 10) {
      // 其他多字符输入中确保关闭 setIsPasting，因为 stdin buffer 可能在任意位置分块；
      // 输入长度超出 buffer 时，结束 escape sequence 也可能被拆开。
      setIsPasting(false)
    }
  }

  return {
    wrappedOnInput,
    pasteState,
    isPasting,
  }
}
