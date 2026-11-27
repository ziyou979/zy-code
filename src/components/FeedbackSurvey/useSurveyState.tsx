import { randomUUID } from 'node:crypto'
import { useCallback, useRef, useState } from 'react'
import type { FeedbackSurveyResponse } from './utils.js'

// 原上游在评分后可能追加「分享会话转录」提问并上传到 Anthropic 后端；ZY Code 已删除该上传
// 服务，状态机只保留 打开 → 感谢 → 关闭。
export type SurveyState = 'closed' | 'open' | 'thanks'
type UseSurveyStateOptions = {
  hideThanksAfterMs: number
  onOpen: (appearanceId: string) => void | Promise<void>
  onSelect: (appearanceId: string, selected: FeedbackSurveyResponse) => void | Promise<void>
}
export function useSurveyState({ hideThanksAfterMs, onOpen, onSelect }: UseSurveyStateOptions): {
  state: SurveyState
  lastResponse: FeedbackSurveyResponse | null
  open: () => void
  handleSelect: (selected: FeedbackSurveyResponse) => void
} {
  const [state, setState] = useState<SurveyState>('closed')
  const [lastResponse, setLastResponse] = useState<FeedbackSurveyResponse | null>(null)
  const appearanceId = useRef(randomUUID())
  const showThanksThenClose = useCallback(() => {
    setState('thanks')
    setTimeout(
      (updateState, updateLastResponse) => {
        updateState('closed')
        updateLastResponse(null)
      },
      hideThanksAfterMs,
      setState,
      setLastResponse,
    )
  }, [hideThanksAfterMs])
  const open = useCallback(() => {
    if (state !== 'closed') {
      return
    }
    setState('open')
    appearanceId.current = randomUUID()
    void onOpen(appearanceId.current)
  }, [state, onOpen])
  const handleSelect = useCallback(
    (selected: FeedbackSurveyResponse): void => {
      setLastResponse(selected)
      // Always fire the survey response event first
      void onSelect(appearanceId.current, selected)
      if (selected === 'dismissed') {
        setState('closed')
        setLastResponse(null)
      } else {
        showThanksThenClose()
      }
    },
    [showThanksThenClose, onSelect],
  )
  return {
    state,
    lastResponse,
    open,
    handleSelect,
  }
}
