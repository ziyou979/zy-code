// Spinner tip：每回合从 bash 工具历史 + 文件读历史中挑一条贴士显示。
// 抽自 screens/REPL.tsx 1294-1357 与多个 clearBashTools 调用点。
//
// 内部状态：
// - bashToolsRef: 累计本会话观察过的所有 bash 命令（提示选择算法用）
// - bashToolsProcessedIdxRef: 已处理 messages 的尾部位置（增量提取）
// - tipPickedThisTurnRef: 守卫，避免 resetLoadingState 同回合双触发
//   （onQueryImpl 尾部 + onQuery finally 都会调）— 没有它会两次
//   recordShownTip → 两次 saveGlobalConfig 背靠背写入
//
// 暴露 4 个 API：
// - pickNewSpinnerTip：增量提取 + getTipToShowOnSpinner + 写 spinnerTip
// - ingestBashToolsFromMessages：restore 路径补充 bash 历史
// - clearBashToolsTracking：clearConversation 时清空累计
// - resetTipPickedThisTurn：onSubmit 进入新回合时复位守卫

import { useCallback, useRef } from 'react'
import type { FileStateCache } from '../../utils/fileStateCache.js'
import { recordShownTip, getTipToShowOnSpinner } from '../../services/tips/tipScheduler.js'
import { useSetAppState } from '../../state/AppState.js'
import type { Message as MessageType } from '../../types/message.js'
import type { ThemeName } from '../../utils/theme.js'
import { extractBashToolsFromMessages } from '../../utils/queryHelpers.js'

export type ReplSpinnerTip = {
  pickNewSpinnerTip: () => void
  /** restore 路径：从 messages 累加 bash 工具到内部 set，不触发 tip 选择 */
  ingestBashToolsFromMessages: (messages: MessageType[]) => void
  /** clearConversation 路径：清空 bash 累计 + 处理位 */
  clearBashToolsTracking: () => void
  /** onSubmit 进入新回合：复位 same-turn 守卫使下次 pick 生效 */
  resetTipPickedThisTurn: () => void
}

export type UseReplSpinnerTipParams = {
  theme: ThemeName
  messagesRef: React.RefObject<MessageType[]>
  readFileStateRef: React.RefObject<FileStateCache>
}

export function useReplSpinnerTip({
  theme,
  messagesRef,
  readFileStateRef,
}: UseReplSpinnerTipParams): ReplSpinnerTip {
  const setAppState = useSetAppState()
  const bashToolsRef = useRef(new Set<string>())
  const bashToolsProcessedIdxRef = useRef(0)
  const tipPickedThisTurnRef = useRef(false)

  const pickNewSpinnerTip = useCallback(() => {
    if (tipPickedThisTurnRef.current) {
      return
    }
    tipPickedThisTurnRef.current = true
    const newMessages = messagesRef.current.slice(bashToolsProcessedIdxRef.current)
    for (const tool of extractBashToolsFromMessages(newMessages)) {
      bashToolsRef.current.add(tool)
    }
    bashToolsProcessedIdxRef.current = messagesRef.current.length
    void getTipToShowOnSpinner({
      theme,
      readFileState: readFileStateRef.current,
      bashTools: bashToolsRef.current,
    }).then(async (tip) => {
      if (tip) {
        const content = await tip.content({ theme })
        setAppState((prev) => ({ ...prev, spinnerTip: content }))
        recordShownTip(tip)
      } else {
        setAppState((prev) => {
          if (prev.spinnerTip === undefined) {
            return prev
          }
          return { ...prev, spinnerTip: undefined }
        })
      }
    })
  }, [setAppState, theme, messagesRef, readFileStateRef])

  const ingestBashToolsFromMessages = useCallback((messages: MessageType[]) => {
    for (const tool of extractBashToolsFromMessages(messages)) {
      bashToolsRef.current.add(tool)
    }
  }, [])

  const clearBashToolsTracking = useCallback(() => {
    bashToolsRef.current.clear()
    bashToolsProcessedIdxRef.current = 0
  }, [])

  const resetTipPickedThisTurn = useCallback(() => {
    tipPickedThisTurnRef.current = false
  }, [])

  return {
    pickNewSpinnerTip,
    ingestBashToolsFromMessages,
    clearBashToolsTracking,
    resetTipPickedThisTurn,
  }
}
