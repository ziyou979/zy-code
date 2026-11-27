import chalk from 'chalk'
import React, { useMemo } from 'react'
import { useClipboardImageHint } from '../hooks/useClipboardImageHint.js'
import { useTextInput } from '../hooks/useTextInput.js'
import { Box, color, useTerminalFocus, useTheme } from '../ink/index.js'
import { shouldUseNativeCursor } from '../ink/nativeCursor.js'
import type { BaseTextInputProps } from '../types/textInputTypes.js'
import { isEnvTruthy } from '../services/infra/envUtils.js'
import type { TextHighlight } from '../terminal-ui/textHighlighting.js'
import { BaseTextInput } from './BaseTextInput.js'

export type Props = BaseTextInputProps & {
  highlights?: TextHighlight[]
}
export default function TextInput(props: Props): React.ReactNode {
  const [theme] = useTheme()
  const isTerminalFocused = useTerminalFocus()
  // 提升到挂载时——此组件在每次按键时都重新渲染。
  const accessibilityEnabled = useMemo(() => isEnvTruthy(process.env.ZY_CODE_ACCESSIBILITY), [])
  const nativeCursorEnabled = useMemo(shouldUseNativeCursor, [])
  // 终端重新获得焦点且剪贴板有图片时显示提示
  useClipboardImageHint(isTerminalFocused, !!props.onImagePaste)

  const canShowCursor = isTerminalFocused && !accessibilityEnabled
  let invert: (text: string) => string
  if (!canShowCursor) {
    invert = (text: string) => text
  } else if (nativeCursorEnabled) {
    invert = (text: string) => text
  } else {
    invert = chalk.inverse
  }
  const textInputState = useTextInput({
    value: props.value,
    onChange: props.onChange,
    onSubmit: props.onSubmit,
    onExit: props.onExit,
    onExitMessage: props.onExitMessage,
    onHistoryReset: props.onHistoryReset,
    onHistoryUp: props.onHistoryUp,
    onHistoryDown: props.onHistoryDown,
    onClearInput: props.onClearInput,
    focus: props.focus,
    mask: props.mask,
    multiline: props.multiline,
    // JediTerm 会把 IME 预编辑串作为 inline inlay 插入物理光标所在行。
    // 原生光标模式下若仍绘制软件光标空格，该空格会参与行宽计算；
    // 较长拼音可能触发软换行并把输入框顶高。高度由 BaseTextInput 的
    // minHeight 保持，这里不再向终端缓冲区写入尾随空格。
    cursorChar: props.showCursor && !nativeCursorEnabled ? ' ' : '',
    highlightPastedText: props.highlightPastedText,
    invert,
    themeText: color('text', theme),
    columns: props.columns,
    maxVisibleLines: props.maxVisibleLines,
    onImagePaste: props.onImagePaste,
    disableCursorMovementForUpDownKeys: props.disableCursorMovementForUpDownKeys,
    disableEscapeDoublePress: props.disableEscapeDoublePress,
    externalOffset: props.cursorOffset,
    onOffsetChange: props.onChangeCursorOffset,
    inputFilter: props.inputFilter,
    inlineGhostText: props.inlineGhostText,
    dim: chalk.dim,
  })
  return (
    <Box>
      <BaseTextInput
        inputState={textInputState}
        terminalFocus={isTerminalFocused}
        highlights={props.highlights}
        invert={invert}
        nativeCursorEnabled={nativeCursorEnabled}
        {...props}
      />
    </Box>
  )
}
