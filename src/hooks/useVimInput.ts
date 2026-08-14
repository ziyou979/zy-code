import React, { useCallback, useRef, useState } from 'react'
import type { Key } from '../ink/index.js'
import type { VimInputState, VimMode } from '../types/textInputTypes.js'
import { Cursor } from '../terminal-ui/cursor.js'
import { lastGrapheme } from '../utils/intl.js'
import { getInitialSettings } from '../services/settings/settings.js'
import {
  executeIndent,
  executeJoin,
  executeOpenLine,
  executeOperatorFind,
  executeOperatorMotion,
  executeOperatorTextObj,
  executeReplace,
  executeToggleCase,
  executeVisualIndent,
  executeVisualOperator,
  executeVisualToggleCase,
  executeX,
  type OperatorContext,
} from '../vim/operators.js'
import { type TransitionContext, transition } from '../vim/transitions.js'
import {
  createInitialPersistentState,
  createInitialVimState,
  type PersistentState,
  type RecordedChange,
  type VimState,
} from '../vim/types.js'
import { type UseTextInputProps, useTextInput } from './useTextInput.js'

type UseVimInputProps = Omit<UseTextInputProps, 'inputFilter'> & {
  onModeChange?: (mode: VimMode) => void
  onUndo?: () => void
  inputFilter?: UseTextInputProps['inputFilter']
}

export function useVimInput(props: UseVimInputProps): VimInputState {
  const vimStateRef = React.useRef<VimState>(createInitialVimState())
  const [mode, setMode] = useState<VimMode>('INSERT')

  const persistentRef = React.useRef<PersistentState>(createInitialPersistentState())

  // ── vimInsertModeRemaps ──────────────────────────────────────────────────
  // 仅从 settings 读取一次；重新渲染不会获取实时变化，这是可接受的，
  // 因为用户必须切换 editorMode 才会改变 vim 行为。
  const remapsRef = useRef<Record<string, string> | undefined>(undefined)
  const remapBufferRef = useRef<{ char: string; timer: NodeJS.Timeout | null } | null>(null)
  if (remapsRef.current === undefined) {
    const s = getInitialSettings()
    const raw: unknown = s.vimInsertModeRemaps
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      remapsRef.current = raw as Record<string, string>
    } else {
      remapsRef.current = {}
    }
  }

  // inputFilter is applied once at the top of handleVimInput (not here) so
  // vim-handled paths that return without calling textInput.onInput still
  // run the filter — otherwise a stateful filter (e.g. lazy-space-after-
  // pill) stays armed across an Escape → NORMAL → INSERT round-trip.
  const textInput = useTextInput({ ...props, inputFilter: undefined })
  const { onModeChange, inputFilter } = props

  const switchToInsertMode = useCallback(
    (offset?: number): void => {
      if (offset !== undefined) {
        textInput.setOffset(offset)
      }
      vimStateRef.current = { mode: 'INSERT', insertedText: '' }
      setMode('INSERT')
      onModeChange?.('INSERT')
    },
    [textInput, onModeChange],
  )

  const switchToNormalMode = useCallback((): void => {
    const current = vimStateRef.current
    if (current.mode === 'INSERT' && current.insertedText) {
      persistentRef.current.lastChange = {
        type: 'insert',
        text: current.insertedText,
      }
    }

    // Vim 行为：退出 insert 模式时将光标左移一位，除非位于行首或 offset 0
    const offset = textInput.offset
    if (offset > 0 && props.value[offset - 1] !== '\n') {
      textInput.setOffset(offset - 1)
    }

    vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
    setMode('NORMAL')
    onModeChange?.('NORMAL')
  }, [onModeChange, textInput, props.value])

  function createOperatorContext(cursor: Cursor, isReplay: boolean = false): OperatorContext {
    return {
      cursor,
      text: props.value,
      setText: (newText: string) => props.onChange(newText),
      setOffset: (offset: number) => textInput.setOffset(offset),
      enterInsert: (offset: number) => switchToInsertMode(offset),
      getRegister: () => persistentRef.current.register,
      setRegister: (content: string, linewise: boolean) => {
        persistentRef.current.register = content
        persistentRef.current.registerIsLinewise = linewise
      },
      getLastFind: () => persistentRef.current.lastFind,
      setLastFind: (type, char) => {
        persistentRef.current.lastFind = { type, char }
      },
      recordChange: isReplay
        ? () => {}
        : (change: RecordedChange) => {
            persistentRef.current.lastChange = change
          },
    }
  }

  function replayLastChange(): void {
    const change = persistentRef.current.lastChange
    if (!change) {
      return
    }

    const cursor = Cursor.fromText(props.value, props.columns, textInput.offset)
    const ctx = createOperatorContext(cursor, true)

    switch (change.type) {
      case 'insert':
        if (change.text) {
          const newCursor = cursor.insert(change.text)
          props.onChange(newCursor.text)
          textInput.setOffset(newCursor.offset)
        }
        break

      case 'x':
        executeX(change.count, ctx)
        break

      case 'replace':
        executeReplace(change.char, change.count, ctx)
        break

      case 'toggleCase':
        executeToggleCase(change.count, ctx)
        break

      case 'indent':
        executeIndent(change.dir, change.count, ctx)
        break

      case 'join':
        executeJoin(change.count, ctx)
        break

      case 'openLine':
        executeOpenLine(change.direction, ctx)
        break

      case 'operator':
        executeOperatorMotion(change.op, change.motion, change.count, ctx)
        break

      case 'operatorFind':
        executeOperatorFind(change.op, change.find, change.char, change.count, ctx)
        break

      case 'operatorTextObj':
        executeOperatorTextObj(change.op, change.scope, change.objType, change.count, ctx)
        break
    }
  }

  function handleVimInput(rawInput: string, key: Key): void {
    const state = vimStateRef.current
    // Run inputFilter in all modes so stateful filters disarm on any key,
    // but only apply the transformed input in INSERT — NORMAL-mode command
    // lookups expect single chars and a prepended space would break them.
    const filtered = inputFilter ? inputFilter(rawInput, key) : rawInput
    const input = state.mode === 'INSERT' ? filtered : rawInput
    const cursor = Cursor.fromText(props.value, props.columns, textInput.offset)

    if (key.ctrl) {
      textInput.onInput(input, key)
      return
    }

    // NOTE(keybindings)：此 escape 处理器有意不迁移到 keybinding 系统。
    // 它是 vim 标准的 INSERT->NORMAL 模式切换，属于 vim 固有行为，不应通过 keybinding 配置。
    // Vim 用户预期 Esc 始终退出 INSERT 模式。
    if (key.escape && state.mode === 'INSERT') {
      switchToNormalMode()
      return
    }

    // NORMAL 模式下 Escape 取消所有待处理命令（replace、operator 等）
    if (key.escape && state.mode === 'NORMAL') {
      vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
      return
    }

    // 无论模式如何都将 Enter 交给基础处理器，使 NORMAL 模式也能提交
    if (key.return) {
      textInput.onInput(input, key)
      return
    }

    if (state.mode === 'INSERT') {
      // 跟踪插入文本，供 dot-repeat 使用
      if (key.backspace || key.delete) {
        // 刷新待处理的 remap buffer
        if (remapBufferRef.current) {
          clearTimeout(remapBufferRef.current.timer as unknown as NodeJS.Timeout)
          const saved = remapBufferRef.current.char
          remapBufferRef.current = null
          // buffer 中的字符从未提交，因此推入 backspace 将其从虚拟状态移除。
          // 文本输入从未收到该字符，只需更新 ref。
          if (state.insertedText.endsWith(saved)) {
            vimStateRef.current = {
              mode: 'INSERT',
              insertedText: state.insertedText.slice(0, -saved.length),
            }
            return
          }
        }
        if (state.insertedText.length > 0) {
          vimStateRef.current = {
            mode: 'INSERT',
            insertedText: state.insertedText.slice(
              0,
              -(lastGrapheme(state.insertedText).length || 1),
            ),
          }
        }
        textInput.onInput(input, key)
        return
      }

      // ── vimInsertModeRemaps ────────────────────────────────────────────
      // 有单字符 buffer 待处理时，与新按键组合并查询 remap 字典。
      const buf = remapBufferRef.current
      if (buf) {
        clearTimeout(buf.timer as unknown as NodeJS.Timeout)
        remapBufferRef.current = null

        const seq = buf.char + input
        const target = remapsRef.current?.[seq]
        if (target === '<Esc>') {
          // 吞掉两个字符并切换到 NORMAL。
          switchToNormalMode()
          return
        }
        // 未知序列：先刷新 buffer 中的字符，再落入下方正常 INSERT 路径提交新字符。
        vimStateRef.current = {
          mode: 'INSERT',
          insertedText: state.insertedText + buf.char,
        }
        textInput.onInput(buf.char, key)
        // 继续向下执行；新的 `input` 字符仍需提交
      }

      // ── Normal INSERT character ────────────────────────────────────────
      // 检查此字符能否作为双字符 remap 序列的开头；若可以则放入 buffer，不立即提交。
      const pendingSeq =
        remapsRef.current &&
        Object.keys(remapsRef.current).some((k) => k[0] === input && k.length === 2)
      if (pendingSeq) {
        const timer = setTimeout(() => {
          // 超时后将 buffer 中的字符作为普通输入刷新
          if (remapBufferRef.current) {
            const saved = remapBufferRef.current.char
            remapBufferRef.current = null
            vimStateRef.current = {
              mode: 'INSERT',
              insertedText: state.insertedText + saved,
            }
            textInput.onInput(saved, {} as Key)
          }
        }, 500)
        remapBufferRef.current = { char: input, timer: timer as unknown as NodeJS.Timeout }
        return
      }

      vimStateRef.current = {
        mode: 'INSERT',
        insertedText: state.insertedText + input,
      }
      textInput.onInput(input, key)
      return
    }

    // VISUAL 模式处理
    if (state.mode === 'VISUAL') {
      const ctx = createOperatorContext(cursor, false)

      // Escape 或 v 返回 NORMAL idle
      if (key.escape || input === 'v') {
        vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
        setMode('NORMAL')
        onModeChange?.('NORMAL')
        return
      }

      // 将方向键映射为 motion
      let visInput = input
      if (key.leftArrow) {
        visInput = 'h'
      } else if (key.rightArrow) {
        visInput = 'l'
      } else if (key.upArrow) {
        visInput = 'k'
      } else if (key.downArrow) {
        visInput = 'j'
      }

      // motion 键扩展选区
      if (['h', 'j', 'k', 'l'].includes(visInput)) {
        const motionMap: Record<string, () => void> = {
          h: () => textInput.setOffset(Math.max(0, cursor.offset - 1)),
          l: () =>
            textInput.setOffset(
              Math.min(props.value.length, cursor.measuredText.nextOffset(cursor.offset)),
            ),
          j: () => {
            const next = cursor.text.indexOf('\n', cursor.offset)
            if (next !== -1) {
              const col = cursor.offset - cursor.startOfLogicalLine().offset
              const nextLine = new Cursor(cursor.measuredText, next + 1)
              textInput.setOffset(Math.min(nextLine.text.length, nextLine.offset + col))
            }
          },
          k: () => {
            if (cursor.offset === 0) {
              return
            }
            const prev = cursor.text.lastIndexOf('\n', cursor.offset - 1)
            if (prev !== -1) {
              const col = cursor.offset - cursor.startOfLogicalLine().offset
              const prevLine = new Cursor(cursor.measuredText, prev)
              textInput.setOffset(Math.min(prev, prevLine.offset + col))
            } else {
              textInput.setOffset(0)
            }
          },
        }
        motionMap[visInput]?.()
        return
      }

      // w/b/e word motion
      if (['w', 'b', 'e'].includes(visInput)) {
        const wordMap: Record<string, () => Cursor> = {
          w: () => cursor.nextVimWord(),
          b: () => cursor.prevVimWord(),
          e: () => cursor.endOfVimWord(),
        }
        const target = wordMap[visInput]?.()
        if (target) {
          textInput.setOffset(target.offset)
        }
        return
      }

      // 行边界
      if (visInput === '0') {
        textInput.setOffset(cursor.startOfLogicalLine().offset)
        return
      }
      if (visInput === '$') {
        textInput.setOffset(cursor.endOfLogicalLine().offset)
        return
      }
      if (visInput === '^') {
        textInput.setOffset(cursor.firstNonBlankInLogicalLine().offset)
        return
      }

      // 作用于选区的 operator
      if (visInput === 'd') {
        executeVisualOperator('delete', state.anchor, cursor.offset, ctx)
        vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
        setMode('NORMAL')
        onModeChange?.('NORMAL')
        return
      }
      if (visInput === 'c') {
        executeVisualOperator('change', state.anchor, cursor.offset, ctx)
        switchToInsertMode(Math.min(state.anchor, cursor.offset))
        return
      }
      if (visInput === 'y') {
        executeVisualOperator('yank', state.anchor, cursor.offset, ctx)
        vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
        setMode('NORMAL')
        onModeChange?.('NORMAL')
        return
      }
      if (visInput === '~') {
        executeVisualToggleCase(state.anchor, cursor.offset, ctx)
        vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
        setMode('NORMAL')
        onModeChange?.('NORMAL')
        return
      }
      if (visInput === '>' || visInput === '<') {
        executeVisualIndent(visInput, state.anchor, cursor.offset, ctx)
        vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
        setMode('NORMAL')
        onModeChange?.('NORMAL')
        return
      }
      if (visInput === 'x' || (key.delete && !key.ctrl)) {
        executeVisualOperator('delete', state.anchor, cursor.offset, ctx)
        vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
        setMode('NORMAL')
        onModeChange?.('NORMAL')
        return
      }

      return
    }

    if (state.mode !== 'NORMAL') {
      return
    }

    // In idle state, delegate arrow keys to base handler for cursor movement
    // and history fallback (upOrHistoryUp / downOrHistoryDown)
    if (
      state.command.type === 'idle' &&
      (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow)
    ) {
      textInput.onInput(input, key)
      return
    }

    // idle 状态下按 v 进入 VISUAL 模式
    if (state.command.type === 'idle' && input === 'v' && !key.ctrl) {
      vimStateRef.current = { mode: 'VISUAL', anchor: cursor.offset }
      setMode('VISUAL')
      onModeChange?.('VISUAL')
      return
    }

    const ctx: TransitionContext = {
      ...createOperatorContext(cursor, false),
      onUndo: props.onUndo,
      onDotRepeat: replayLastChange,
    }

    // Backspace/Delete are only mapped in motion-expecting states. In
    // literal-char states (replace, find, operatorFind), mapping would turn
    // r+Backspace into "replace with h" and df+Delete into "delete to next x".
    // Delete additionally skips count state: in vim, N<Del> removes a count
    // digit rather than executing Nx; we don't implement digit removal but
    // should at least not turn a cancel into a destructive Nx.
    const expectsMotion =
      state.command.type === 'idle' ||
      state.command.type === 'count' ||
      state.command.type === 'operator' ||
      state.command.type === 'operatorCount'

    // NORMAL 模式下将方向键映射为 vim motion
    let vimInput = input
    if (key.leftArrow) {
      vimInput = 'h'
    } else if (key.rightArrow) {
      vimInput = 'l'
    } else if (key.upArrow) {
      vimInput = 'k'
    } else if (key.downArrow) {
      vimInput = 'j'
    } else if (expectsMotion && key.backspace) {
      vimInput = 'h'
    } else if (expectsMotion && state.command.type !== 'count' && key.delete) {
      vimInput = 'x'
    }

    const result = transition(state.command, vimInput, ctx)

    if (result.execute) {
      result.execute()
    }

    // 更新命令状态（仅当 execute 未切换到 INSERT 时）
    if (vimStateRef.current.mode === 'NORMAL') {
      if (result.next) {
        vimStateRef.current = { mode: 'NORMAL', command: result.next }
      } else if (result.execute) {
        vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
      }
    }

    if (input === '?' && state.mode === 'NORMAL' && state.command.type === 'idle') {
      props.onChange('?')
    }
  }

  const setModeExternal = useCallback(
    (newMode: VimMode) => {
      if (newMode === 'INSERT') {
        vimStateRef.current = { mode: 'INSERT', insertedText: '' }
      } else {
        vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
      }
      setMode(newMode)
      onModeChange?.(newMode)
    },
    [onModeChange],
  )

  return {
    ...textInput,
    onInput: handleVimInput,
    mode,
    setMode: setModeExternal,
  }
}
