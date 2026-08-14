import { isInputModeCharacter } from 'src/components/PromptInput/inputModes.js'
import { useNotifications } from 'src/context/notifications.js'
import stripAnsi from 'strip-ansi'
import { markBackslashReturnUsed } from '../commands/terminal-setup/TerminalSetup.js'
import { addToHistory } from '../services/session-storage/history.js'
import instances from '../ink/instances.js'
import type { Key } from '../ink/index.js'
import type { InlineGhostText, TextInputState } from '../types/textInputTypes.js'
import {
  Cursor,
  getLastKill,
  pushToKillRing,
  recordYank,
  resetKillAccumulation,
  resetYankState,
  updateYankLength,
  yankPop,
} from '../terminal-ui/cursor.js'
import { env } from '../services/environment/env.js'
import { isFullscreenEnvEnabled } from '../services/terminal/fullscreen.js'
import type { ImageDimensions } from '../services/attachments/imageResizer.js'
import { isModifierPressed, prewarmModifiers } from '../services/input/modifiers.js'
import { useDoublePress } from './useDoublePress.js'

type MaybeCursor = undefined | Cursor
type InputHandler = (input: string) => MaybeCursor
type InputMapper = (input: string) => MaybeCursor
const NOOP_HANDLER: InputHandler = () => undefined
function mapInput(input_map: Array<[string, InputHandler]>): InputMapper {
  const map = new Map(input_map)
  return (input: string): MaybeCursor => (map.get(input) ?? NOOP_HANDLER)(input)
}

export type UseTextInputProps = {
  value: string
  onChange: (value: string) => void
  onSubmit?: (value: string) => void
  onExit?: () => void
  onExitMessage?: (show: boolean, key?: string) => void
  onHistoryUp?: () => void
  onHistoryDown?: () => void
  onHistoryReset?: () => void
  onClearInput?: () => void
  focus?: boolean
  mask?: string
  multiline?: boolean
  cursorChar: string
  highlightPastedText?: boolean
  invert: (text: string) => string
  themeText: (text: string) => string
  columns: number
  onImagePaste?: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    sourcePath?: string,
  ) => void
  disableCursorMovementForUpDownKeys?: boolean
  disableEscapeDoublePress?: boolean
  maxVisibleLines?: number
  externalOffset: number
  onOffsetChange: (offset: number) => void
  inputFilter?: (input: string, key: Key) => string
  inlineGhostText?: InlineGhostText
  dim?: (text: string) => string
}

export function useTextInput({
  value: originalValue,
  onChange,
  onSubmit,
  onExit,
  onExitMessage,
  onHistoryUp,
  onHistoryDown,
  onHistoryReset,
  onClearInput,
  mask = '',
  multiline = false,
  cursorChar,
  invert,
  columns,
  onImagePaste: _onImagePaste,
  disableCursorMovementForUpDownKeys = false,
  disableEscapeDoublePress = false,
  maxVisibleLines,
  externalOffset,
  onOffsetChange,
  inputFilter,
  inlineGhostText,
  dim,
}: UseTextInputProps): TextInputState {
  // 预热 Apple Terminal 的 modifiers 模块；内部有 guard，可安全多次调用
  if (env.terminal === 'Apple_Terminal') {
    prewarmModifiers()
  }

  const offset = externalOffset
  const setOffset = onOffsetChange
  const cursor = Cursor.fromText(originalValue, columns, offset)
  const { addNotification, removeNotification } = useNotifications()

  const handleCtrlC = useDoublePress(
    (show) => {
      onExitMessage?.(show, 'Ctrl-C')
    },
    () => onExit?.(),
    () => {
      if (originalValue) {
        onChange('')
        setOffset(0)
        onHistoryReset?.()
      }
    },
  )

  // NOTE(keybindings)：此 escape 处理器有意不迁移到 keybinding 系统。
  // 它是在文本层双击 escape 以清除输入，而非 action 层 keybinding。
  // 双击 Esc 会清除输入并存入历史，属于文本编辑而非关闭 dialog，
  // 因此需要双击安全机制。
  const handleEscape = useDoublePress(
    (show: boolean) => {
      if (!originalValue || !show) {
        return
      }
      addNotification({
        key: 'escape-again-to-clear',
        text: 'Esc again to clear',
        priority: 'immediate',
        timeoutMs: 1000,
      })
    },
    () => {
      // 立即移除“再次按 Esc 清除”的通知
      removeNotification('escape-again-to-clear')
      onClearInput?.()
      if (originalValue) {
        // 跟踪 double-escape 使用情况，用于功能发现
        // 清除前保存到历史
        if (originalValue.trim() !== '') {
          addToHistory(originalValue)
        }
        onChange('')
        setOffset(0)
        onHistoryReset?.()
      }
    },
  )

  const handleEmptyCtrlD = useDoublePress(
    (show) => {
      if (originalValue !== '') {
        return
      }
      onExitMessage?.(show, 'Ctrl-D')
    },
    () => {
      if (originalValue !== '') {
        return
      }
      onExit?.()
    },
  )

  function handleCtrlD(): MaybeCursor {
    if (cursor.text === '') {
      // 输入为空时处理双击
      handleEmptyCtrlD()
      return cursor
    }
    // 输入非空时像 iPython 一样向前删除
    return cursor.del()
  }

  function killToLineEnd(): Cursor {
    const { cursor: newCursor, killed } = cursor.deleteToLineEnd()
    pushToKillRing(killed, 'append')
    return newCursor
  }

  function killToLineStart(): Cursor {
    const { cursor: newCursor, killed } = cursor.deleteToLineStart()
    pushToKillRing(killed, 'prepend')
    return newCursor
  }

  function killWordBefore(): Cursor {
    const { cursor: newCursor, killed } = cursor.deleteWordBefore()
    pushToKillRing(killed, 'prepend')
    return newCursor
  }

  function yank(): Cursor {
    const text = getLastKill()
    if (text.length > 0) {
      const startOffset = cursor.offset
      const newCursor = cursor.insert(text)
      recordYank(startOffset, text.length)
      return newCursor
    }
    return cursor
  }

  function handleYankPop(): Cursor {
    const popResult = yankPop()
    if (!popResult) {
      return cursor
    }
    const { text, start, length } = popResult
    // 用新文本替换之前 yank 的文本
    const before = cursor.text.slice(0, start)
    const after = cursor.text.slice(start + length)
    const newText = before + text + after
    const newOffset = start + text.length
    updateYankLength(text.length)
    return Cursor.fromText(newText, columns, newOffset)
  }

  const handleCtrl = mapInput([
    ['a', () => cursor.startOfLine()],
    ['b', () => cursor.left()],
    [
      'c',
      () => {
        handleCtrlC()
        return undefined
      },
    ],
    ['d', handleCtrlD],
    ['e', () => cursor.endOfLine()],
    ['f', () => cursor.right()],
    ['h', () => cursor.deleteTokenBefore() ?? cursor.backspace()],
    ['k', killToLineEnd],
    ['n', () => downOrHistoryDown()],
    ['p', () => upOrHistoryUp()],
    ['u', killToLineStart],
    ['w', killWordBefore],
    ['y', yank],
  ])

  const handleMeta = mapInput([
    ['b', () => cursor.prevWord()],
    ['f', () => cursor.nextWord()],
    ['d', () => cursor.deleteWordAfter()],
    ['y', handleYankPop],
  ])

  function handleEnter(key: Key) {
    if (multiline && cursor.offset > 0 && cursor.text[cursor.offset - 1] === '\\') {
      // 记录用户使用过 backslash+return
      markBackslashReturnUsed()
      return cursor.backspace().insert('\n')
    }
    // Meta+Enter 或 Shift+Enter 插入换行符
    if (key.meta || key.shift) {
      return cursor.insert('\n')
    }
    // Apple Terminal 不支持自定义 Shift+Enter keybinding，
    // 因此用 macOS 原生 modifier 检测判断 Shift 是否按下
    if (env.terminal === 'Apple_Terminal' && isModifierPressed('shift')) {
      return cursor.insert('\n')
    }
    onSubmit?.(originalValue)
  }

  function upOrHistoryUp() {
    if (disableCursorMovementForUpDownKeys) {
      onHistoryUp?.()
      return cursor
    }
    // 先尝试按视觉换行移动
    const cursorUp = cursor.up()
    if (!cursorUp.equals(cursor)) {
      return cursorUp
    }

    // 无法按视觉换行移动且为多行输入时，尝试按逻辑行移动，以处理段落边界
    if (multiline) {
      const cursorUpLogical = cursor.upLogicalLine()
      if (!cursorUpLogical.equals(cursor)) {
        return cursorUpLogical
      }
    }

    // 完全无法上移时触发历史导航
    onHistoryUp?.()
    return cursor
  }
  function downOrHistoryDown() {
    if (disableCursorMovementForUpDownKeys) {
      onHistoryDown?.()
      return cursor
    }
    // 先尝试按视觉换行移动
    const cursorDown = cursor.down()
    if (!cursorDown.equals(cursor)) {
      return cursorDown
    }

    // 无法按视觉换行移动且为多行输入时，尝试按逻辑行移动，以处理段落边界
    if (multiline) {
      const cursorDownLogical = cursor.downLogicalLine()
      if (!cursorDownLogical.equals(cursor)) {
        return cursorDownLogical
      }
    }

    // 完全无法下移时触发历史导航
    onHistoryDown?.()
    return cursor
  }

  function mapKey(key: Key): InputMapper {
    switch (true) {
      case key.escape:
        return () => {
          // Skip when a keybinding context (e.g. Autocomplete) owns escape.
          // useKeybindings can't shield us via stopImmediatePropagation —
          // BaseTextInput's useInput registers first (child effects fire
          // before parent effects), so this handler has already run by the
          // time the keybinding's handler stops propagation.
          if (disableEscapeDoublePress) {
            return cursor
          }
          handleEscape()
          // 原样返回当前光标；handleEscape 会在内部管理状态
          return cursor
        }
      case key.leftArrow && (key.ctrl || key.meta || key.fn):
        return () => cursor.prevWord()
      case key.rightArrow && (key.ctrl || key.meta || key.fn):
        return () => cursor.nextWord()
      case key.backspace:
        return key.meta || key.ctrl
          ? killWordBefore
          : () => cursor.deleteTokenBefore() ?? cursor.backspace()
      case key.delete:
        return key.meta ? killToLineEnd : () => cursor.del()
      case key.ctrl:
        return handleCtrl
      case key.home:
        return () => cursor.startOfLine()
      case key.end:
        return () => cursor.endOfLine()
      case key.pageDown:
        // fullscreen 模式下 PgUp/PgDn 滚动消息 viewport，而不是移动光标；
        // 此处无需处理，交给 ScrollKeybindingHandler。
        if (isFullscreenEnvEnabled()) {
          return NOOP_HANDLER
        }
        return () => cursor.endOfLine()
      case key.pageUp:
        if (isFullscreenEnvEnabled()) {
          return NOOP_HANDLER
        }
        return () => cursor.startOfLine()
      case key.wheelUp:
      case key.wheelDown:
        // 鼠标滚轮事件只在 fullscreen 鼠标跟踪启用时存在。
        // 交给 ScrollKeybindingHandler，此处不处理，避免将原始 SGR sequence 插入文本。
        return NOOP_HANDLER
      case key.return:
        // 必须位于 key.meta 之前，使 Option+Return 能插入换行符
        return () => handleEnter(key)
      case key.meta:
        return handleMeta
      case key.tab:
        return () => cursor
      case key.upArrow && !key.shift:
        return upOrHistoryUp
      case key.downArrow && !key.shift:
        return downOrHistoryDown
      case key.leftArrow:
        return () => cursor.left()
      case key.rightArrow:
        return () => cursor.right()
      default: {
        return (input: string) => {
          switch (true) {
            // Home 键
            case input === '\x1b[H' || input === '\x1b[1~':
              return cursor.startOfLine()
            // End 键
            case input === '\x1b[F' || input === '\x1b[4~':
              return cursor.endOfLine()
            default: {
              // Trailing \r after text is SSH-coalesced Enter ("o\r") —
              // strip it so the Enter isn't inserted as content. Lone \r
              // here is Alt+Enter leaking through (META_KEY_CODE_RE doesn't
              // match \x1b\r) — leave it for the \r→\n below. Embedded \r
              // is multi-line paste from a terminal without bracketed
              // paste — convert to \n. Backslash+\r is a stale VS Code
              // Shift+Enter binding (pre-#8991 /terminal-setup wrote
              // args.text "\\\r\n" to keybindings.json); keep the \r so
              // it becomes \n below (anthropics/zy-code#31316).
              const text = stripAnsi(input)
                // eslint-disable-next-line custom-rules/no-lookbehind-regex -- .replace(re, str) on 1-2 char keystrokes: no-match returns same string (Object.is), regex never runs
                .replace(/(?<=[^\\\r\n])\r$/, '')
                .replace(/\r/g, '\n')
              if (cursor.isAtStart() && isInputModeCharacter(input)) {
                return cursor.insert(text).left()
              }
              return cursor.insert(text)
            }
          }
        }
      }
    }
  }

  // 检查是否为 kill 命令（Ctrl+K、Ctrl+U、Ctrl+W 或 Meta+Backspace/Delete）
  function isKillKey(key: Key, input: string): boolean {
    if (key.ctrl && (input === 'k' || input === 'u' || input === 'w')) {
      return true
    }
    if (key.meta && (key.backspace || key.delete)) {
      return true
    }
    return false
  }

  // 检查是否为 yank 命令（Ctrl+Y 或 Alt+Y）
  function isYankKey(key: Key, input: string): boolean {
    return (key.ctrl || key.meta) && input === 'y'
  }

  function onInput(input: string, key: Key): void {
    // 注意：图片粘贴快捷键（chat:imagePaste）由 PromptInput 中的 useKeybindings 处理

    // 若提供 filter，则应用
    const filteredInput = inputFilter ? inputFilter(input, key) : input

    // 输入被过滤掉时不执行任何操作
    if (filteredInput === '' && input !== '') {
      return
    }

    // 全屏 ink 拖选存在时，禁止落到单字符 backspace（否则表现为「只删了最后一字符」）。
    // 仅当选区文本落在当前输入缓冲时整段删除；对话历史不支持拖选删除。
    // 历史区选区在此 no-op，由 ScrollKeybindingHandler 清高亮并 stop。
    if (
      (key.backspace || key.delete || filteredInput.includes('\x7f')) &&
      instances.get(process.stdout)?.hasTextSelection()
    ) {
      const ink = instances.get(process.stdout)
      const selected = ink?.getSelectedText() ?? ''
      if (selected) {
        const candidates = [selected, selected.replace(/\n/g, '')].filter(
          (t, i, arr) => t.length > 0 && arr.indexOf(t) === i,
        )
        for (const cand of candidates) {
          let at = originalValue.lastIndexOf(cand, Math.max(0, offset))
          if (at < 0) {
            at = originalValue.indexOf(cand)
          }
          if (at >= 0) {
            const next = originalValue.slice(0, at) + originalValue.slice(at + cand.length)
            onChange(next)
            setOffset(at)
            ink?.clearTextSelection()
            resetKillAccumulation()
            resetYankState()
            return
          }
        }
      }
      // 选区不在本输入框——不单字符删除
      return
    }

    // 修复 Issue #1853：过滤会在 SSH/tmux 中干扰 backspace 的 DEL 字符。
    // SSH/tmux 环境中的 backspace 会同时生成 key event 和原始 DEL 字符
    if (!key.backspace && !key.delete && input.includes('\x7f')) {
      const delCount = (input.match(/\x7f/g) || []).length

      // 将所有 DEL 字符同步应用为 backspace 操作；优先删除 token，失败后回退到字符 backspace
      let currentCursor = cursor
      for (let i = 0; i < delCount; i++) {
        currentCursor = currentCursor.deleteTokenBefore() ?? currentCursor.backspace()
      }

      // 用最终结果一次性更新状态
      if (!cursor.equals(currentCursor)) {
        if (cursor.text !== currentCursor.text) {
          onChange(currentCursor.text)
        }
        setOffset(currentCursor.offset)
      }
      resetKillAccumulation()
      resetYankState()
      return
    }

    // 非 kill 键会重置 kill 累积
    if (!isKillKey(key, filteredInput)) {
      resetKillAccumulation()
    }

    // 非 yank 键会重置 yank 状态，中断 yank-pop 链
    if (!isYankKey(key, filteredInput)) {
      resetYankState()
    }

    const nextCursor = mapKey(key)(filteredInput)
    if (nextCursor) {
      if (!cursor.equals(nextCursor)) {
        if (cursor.text !== nextCursor.text) {
          onChange(nextCursor.text)
        }
        setOffset(nextCursor.offset)
      }
      // SSH-coalesced Enter: on slow links, "o" + Enter can arrive as one
      // chunk "o\r". parseKeypress only matches s === '\r', so it hit the
      // default handler above (which stripped the trailing \r). Text with
      // exactly one trailing \r is coalesced Enter; lone \r is Alt+Enter
      // (newline); embedded \r is multi-line paste.
      if (
        filteredInput.length > 1 &&
        filteredInput.endsWith('\r') &&
        !filteredInput.slice(0, -1).includes('\r') &&
        // Backslash+CR is a stale VS Code Shift+Enter binding, not
        // coalesced Enter. See default handler above.
        filteredInput[filteredInput.length - 2] !== '\\'
      ) {
        onSubmit?.(nextCursor.text)
      }
    }
  }

  // 准备用于渲染的 ghost text：校验 insertPosition 与当前光标 offset 匹配，
  // 避免上一次按键留下的旧 ghost text 造成单帧抖动；ghost text 状态会在渲染后
  // 通过 useEffect 更新。
  const ghostTextForRender =
    inlineGhostText && dim && inlineGhostText.insertPosition === offset
      ? { text: inlineGhostText.text, dim }
      : undefined

  const cursorPos = cursor.getPosition()

  return {
    onInput,
    renderedValue: cursor.render(cursorChar, mask, invert, ghostTextForRender, maxVisibleLines),
    offset,
    setOffset,
    cursorLine: cursorPos.line - cursor.getViewportStartLine(maxVisibleLines),
    cursorColumn: cursorPos.column,
    viewportCharOffset: cursor.getViewportCharOffset(maxVisibleLines),
    viewportCharEnd: cursor.getViewportCharEnd(maxVisibleLines),
  }
}
