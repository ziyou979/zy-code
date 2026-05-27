// 取消权限请求时把已排队命令恢复到输入框。
// 抽自 screens/REPL.tsx 2106-2127：
// - popAllEditable 从消息队列拿出最近一段可编辑命令（文本 + 图片）
// - 命中后回填 inputValue + 强制 inputMode='prompt'
// - 队列里夹带的 image 复原到 pastedContents（按 id 合并，不覆盖已有）
//
// 用作 cancelRequestProps.popCommandFromQueue：CancelRequestHandler 在用户
// 按 Esc 取消权限请求 / 中断时调用，让用户能直接编辑刚被排队的内容。

import { useCallback } from 'react'
import type React from 'react'
import type { PromptInputMode } from '../../types/textInputTypes.js'
import type { PastedContent } from '../../utils/config.js'
import { popAllEditable } from '../../utils/messageQueueManager.js'

export type UseReplQueuedCommandRestoreParams = {
  inputValue: string
  setInputValue: (value: string) => void
  setInputMode: React.Dispatch<React.SetStateAction<PromptInputMode>>
  setPastedContents: React.Dispatch<React.SetStateAction<Record<number, PastedContent>>>
}

export function useReplQueuedCommandRestore({
  inputValue,
  setInputValue,
  setInputMode,
  setPastedContents,
}: UseReplQueuedCommandRestoreParams): () => void {
  return useCallback(() => {
    const result = popAllEditable(inputValue, 0)
    if (!result) {
      return
    }
    setInputValue(result.text)
    setInputMode('prompt')

    if (result.images.length > 0) {
      setPastedContents((prev) => {
        const newContents = { ...prev }
        for (const image of result.images) {
          newContents[image.id] = image
        }
        return newContents
      })
    }
  }, [inputValue, setInputValue, setInputMode, setPastedContents])
}
