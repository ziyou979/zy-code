/**
 * useReplInput：从 REPL.tsx 提取的输入值、模式、vim 和历史搜索状态。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTerminalFocus } from '../../ink/index.js'
import type { PromptInputMode, VimMode } from '../../types/textInputTypes.js'
import type { PastedContent } from '../../services/config/config.js'
import type { ReplStoreInstance } from '../../state/ReplStore.js'
import { consumeEarlyInput } from '../../services/input/earlyInput.js'

const RECENT_SCROLL_REPIN_WINDOW_MS = 3000
const PROMPT_SUPPRESSION_MS = 1500

export type UseReplInputParams = {
  replStore: ReplStoreInstance
  repinScroll: () => void
  lastUserScrollTsRef: React.RefObject<number>
  trySuggestBgPRIntercept: (prev: string, next: string) => boolean
}

export function useReplInput(params: UseReplInputParams) {
  const { replStore, repinScroll, lastUserScrollTsRef, trySuggestBgPRIntercept } = params

  const [initialInputValue] = useState(() => consumeEarlyInput())
  const inputValueRef = useRef(initialInputValue)
  const inputStoreInitializedRef = useRef(false)
  if (!inputStoreInitializedRef.current) {
    replStore.input.setValue(initialInputValue)
    inputStoreInitializedRef.current = true
  }
  const setInputValueRaw = useCallback<React.Dispatch<React.SetStateAction<string>>>(
    (action) => {
      const previous = inputValueRef.current
      const value = typeof action === 'function' ? action(previous) : action
      if (value === previous) {
        return
      }
      inputValueRef.current = value
      replStore.input.setValue(value)
    },
    [replStore],
  )

  const insertTextRef = useRef<{
    insert: (text: string) => void
    setInputWithCursor: (value: string, cursor: number) => void
    cursorOffset: number
  } | null>(null)

  const [isPromptInputActive, setIsPromptInputActive] = useState(false)
  const promptSuppressionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const updatePromptSuppression = useCallback((value: string) => {
    if (promptSuppressionTimerRef.current !== null) {
      clearTimeout(promptSuppressionTimerRef.current)
      promptSuppressionTimerRef.current = null
    }
    const active = value.trim().length > 0
    setIsPromptInputActive(active)
    if (active) {
      promptSuppressionTimerRef.current = setTimeout(() => {
        promptSuppressionTimerRef.current = null
        setIsPromptInputActive(false)
      }, PROMPT_SUPPRESSION_MS)
    }
  }, [])

  useEffect(
    () => () => {
      if (promptSuppressionTimerRef.current !== null) {
        clearTimeout(promptSuppressionTimerRef.current)
      }
    },
    [],
  )

  const setInputValue = useCallback(
    (value: string) => {
      if (trySuggestBgPRIntercept(inputValueRef.current, value)) {
        return
      }
      if (
        inputValueRef.current === '' &&
        value !== '' &&
        Date.now() - lastUserScrollTsRef.current >= RECENT_SCROLL_REPIN_WINDOW_MS
      ) {
        repinScroll()
      }
      setInputValueRaw(value)
      updatePromptSuppression(value)
    },
    [
      repinScroll,
      trySuggestBgPRIntercept,
      lastUserScrollTsRef,
      setInputValueRaw,
      updatePromptSuppression,
    ],
  )

  const [inputMode, setInputMode] = useState<PromptInputMode>('prompt')
  const [stashedPrompt, setStashedPrompt] = useState<
    | { text: string; cursorOffset: number; pastedContents: Record<number, PastedContent> }
    | undefined
  >()
  const [pastedContents, setPastedContents] = useState<Record<number, PastedContent>>({})
  const [vimMode, setVimMode] = useState<VimMode>('INSERT')
  const [showBashesDialog, setShowBashesDialog] = useState<string | boolean>(false)
  const [isSearchingHistory, setIsSearchingHistory] = useState(false)
  const [isHelpOpen, setIsHelpOpen] = useState(false)

  const isTerminalFocused = useTerminalFocus()
  const terminalFocusRef = useRef(isTerminalFocused)
  terminalFocusRef.current = isTerminalFocused

  return {
    setInputValueRaw,
    setInputValue,
    inputValueRef,
    insertTextRef,
    isPromptInputActive,
    inputMode,
    setInputMode,
    stashedPrompt,
    setStashedPrompt,
    pastedContents,
    setPastedContents,
    vimMode,
    setVimMode,
    showBashesDialog,
    setShowBashesDialog,
    isSearchingHistory,
    setIsSearchingHistory,
    isHelpOpen,
    setIsHelpOpen,
    isTerminalFocused,
    terminalFocusRef,
  }
}
