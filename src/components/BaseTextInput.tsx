import React from 'react'
import { renderPlaceholder } from '../hooks/renderPlaceholder.js'
import { usePasteHandler } from '../hooks/usePasteHandler.js'
import { useDeclaredCursor } from '../ink/hooks/useDeclaredCursor.js'
import { Ansi, Box, Text, useInput } from '../ink/index.js'
import type { BaseInputState, BaseTextInputProps } from '../types/textInputTypes.js'
import type { TextHighlight } from '../terminal-ui/textHighlighting.js'
import { HighlightedInput } from './PromptInput/ShimmeredInput.js'

type BaseTextInputComponentProps = BaseTextInputProps & {
  inputState: BaseInputState
  children?: React.ReactNode
  terminalFocus: boolean
  highlights?: TextHighlight[]
  invert?: (text: string) => string
  hidePlaceholderText?: boolean
  nativeCursorEnabled?: boolean
  cursorCellPainted?: boolean
}

/**
 * 文本输入的基础组件，负责渲染和基础输入处理
 */
export function BaseTextInput({
  inputState,
  children,
  terminalFocus,
  invert,
  hidePlaceholderText,
  nativeCursorEnabled = false,
  cursorCellPainted = false,
  ...props
}: BaseTextInputComponentProps) {
  const { onInput, renderedValue, cursorLine, cursorColumn } = inputState
  const hasActiveCursor = Boolean(props.focus && props.showCursor)
  const { wrappedOnInput, isPasting } = usePasteHandler({
    onPaste: props.onPaste,
    onInput: (input, key) => {
      if (isPasting && key.return) {
        return
      }
      onInput(input, key)
    },
    onImagePaste: props.onImagePaste,
  })
  const { onIsPastingChange } = props
  React.useEffect(() => {
    if (onIsPastingChange) {
      onIsPastingChange(isPasting)
    }
  }, [isPasting, onIsPastingChange])
  const { showPlaceholder, renderedPlaceholder } = renderPlaceholder({
    placeholder: props.placeholder,
    value: props.value,
    showCursor: props.showCursor && !nativeCursorEnabled,
    focus: props.focus,
    terminalFocus,
    invert,
    hidePlaceholderText,
  })
  useInput(wrappedOnInput, {
    isActive: props.focus,
  })
  const commandWithoutArgs =
    (props.value && props.value.trim().indexOf(' ') === -1) || props.value?.endsWith(' ')
  const showArgumentHint = Boolean(
    props.argumentHint && props.value && commandWithoutArgs && props.value.startsWith('/'),
  )
  const cursorRef = useDeclaredCursor({
    line: cursorLine,
    column: cursorColumn,
    active: hasActiveCursor,
    visible: nativeCursorEnabled && !cursorCellPainted,
    eraseToEnd:
      nativeCursorEnabled &&
      !cursorCellPainted &&
      inputState.offset >= (props.value?.length ?? 0) &&
      !props.inlineGhostText &&
      !showArgumentHint,
  })
  const cursorFiltered =
    props.showCursor && props.highlights
      ? props.highlights.filter(
          (h) => h.dimColor || props.cursorOffset < h.start || props.cursorOffset >= h.end,
        )
      : props.highlights
  const { viewportCharOffset, viewportCharEnd } = inputState
  const filteredHighlights =
    cursorFiltered && viewportCharOffset > 0
      ? cursorFiltered
          .filter(
            (highlightItem) =>
              highlightItem.end > viewportCharOffset && highlightItem.start < viewportCharEnd,
          )
          .map((mappedHighlight) => ({
            ...mappedHighlight,
            start: Math.max(0, mappedHighlight.start - viewportCharOffset),
            end: mappedHighlight.end - viewportCharOffset,
          }))
      : cursorFiltered
  const hasHighlights = filteredHighlights && filteredHighlights.length > 0
  if (hasHighlights) {
    return (
      <Box ref={cursorRef} minHeight={1}>
        <Box flexShrink={0} aria-preserve-whitespace={true}>
          <HighlightedInput text={renderedValue} highlights={filteredHighlights} />
        </Box>
        {showArgumentHint && (
          <Text dimColor={true}>
            {props.value?.endsWith(' ') ? '' : ' '}
            {props.argumentHint}
          </Text>
        )}
        {children}
      </Box>
    )
  }
  const ContainerBox = Box
  const ContentText = Text
  return (
    <ContainerBox ref={cursorRef} minHeight={1}>
      {
        <ContentText wrap={'truncate-end'} dimColor={props.dimColor}>
          {showPlaceholder && props.placeholderElement ? (
            props.placeholderElement
          ) : showPlaceholder && renderedPlaceholder ? (
            <Ansi>{renderedPlaceholder}</Ansi>
          ) : (
            <Text aria-preserve-whitespace={true}>
              <Ansi>{renderedValue}</Ansi>
            </Text>
          )}
          {showArgumentHint && (
            <Text dimColor={true}>
              {props.value?.endsWith(' ') ? '' : ' '}
              {props.argumentHint}
            </Text>
          )}
          {children}
        </ContentText>
      }
    </ContainerBox>
  )
}
