/**
 * useReplInput -- input value / mode / vim / history-search state extracted from REPL.tsx.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTerminalFocus } from '../../ink.js'
import { consumeEarlyInput } from '../../utils/earlyInput.js'
import type { PromptInputMode, VimMode } from '../../types/textInputTypes.js'
import type { PastedContent } from '../../utils/config.js'

const RECENT_SCROLL_REPIN_WINDOW_MS = 3000
const PROMPT_SUPPRESSION_MS = 1500

export type UseReplInputParams = {
  repinScroll: () => void
  lastUserScrollTsRef: React.RefObject<number>
  trySuggestBgPRIntercept: (prev: string, next: string) => boolean
}

export function useReplInput(params: UseReplInputParams) {
  const { repinScroll, lastUserScrollTsRef, trySuggestBgPRIntercept } = params

  const [inputValue, setInputValueRaw] = useState(() => consumeEarlyInput())
  const inputValueRef = useRef(inputValue)
  inputValueRef.current = inputValue

  const insertTextRef = useRef<{
    insert: (text: string) => void
    setInputWithCursor: (value: string, cursor: number) => void
    cursorOffset: number
  } | null>(null)

  const [isPromptInputActive, setIsPromptInputActive] = useState(false)

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
      inputValueRef.current = value
      setInputValueRaw(value)
      setIsPromptInputActive(value.trim().length > 0)
    },
    [repinScroll],
  )

  // Clear suppression after user stops typing
  useEffect(() => {
    if (inputValue.trim().length === 0) {
      return
    }
    const timer = setTimeout(setIsPromptInputActive, PROMPT_SUPPRESSION_MS, false)
    return () => clearTimeout(timer)
  }, [inputValue])

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
    inputValue,
    setInputValueRaw,
    setInputValue,
    inputValueRef,
    insertTextRef,
    isPromptInputActive,
    setIsPromptInputActive,
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
