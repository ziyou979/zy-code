import { describe, expect, mock, test } from 'bun:test'
import {
  getNextSuggestionIndex,
  handleAutocompleteArrowFallback,
  resolveAutocompleteArrowAction,
  resolvePromptHistoryNavigation,
} from '../../src/components/PromptInput/promptInputNavigation.js'
import { getPreservedSelection } from '../../src/hooks/typeaheadTokenUtils.js'

describe('PromptInput 方向键路由', () => {
  test('slash command 完全匹配且候选仍可见时，不把上下键交给历史记录', () => {
    const onHistoryUp = mock(() => {})
    const onHistoryDown = mock(() => {})

    const handlers = resolvePromptHistoryNavigation(true, onHistoryUp, onHistoryDown)

    expect(handlers.onHistoryUp).toBeUndefined()
    expect(handlers.onHistoryDown).toBeUndefined()
  })

  test('没有自动补全候选时，保留历史记录导航', () => {
    const onHistoryUp = mock(() => {})
    const onHistoryDown = mock(() => {})

    const handlers = resolvePromptHistoryNavigation(false, onHistoryUp, onHistoryDown)

    expect(handlers.onHistoryUp).toBe(onHistoryUp)
    expect(handlers.onHistoryDown).toBe(onHistoryDown)
  })

  test('keybinding 未消费时，上下键仍能驱动候选选择', () => {
    expect(resolveAutocompleteArrowAction('up', true)).toBe('previous')
    expect(resolveAutocompleteArrowAction('down', true)).toBe('next')
  })

  test('候选索引按上下方向循环移动', () => {
    expect(getNextSuggestionIndex(0, 4, 'next')).toBe(1)
    expect(getNextSuggestionIndex(3, 4, 'next')).toBe(0)
    expect(getNextSuggestionIndex(0, 4, 'previous')).toBe(3)
    expect(getNextSuggestionIndex(-1, 4, 'next')).toBe(0)
    expect(getNextSuggestionIndex(-1, 0, 'next')).toBe(-1)
  })

  test('slash command 建议重新生成时保留键盘选中的候选', () => {
    const previous = [
      { id: 'help', displayText: 'help' },
      { id: 'model', displayText: 'model' },
    ]
    const regenerated = previous.map((item) => ({ ...item }))

    expect(getPreservedSelection(previous, 1, regenerated)).toBe(1)
  })

  test('方向键兜底执行对应选择并停止传播', () => {
    const preventDefault = mock(() => {})
    const stopImmediatePropagation = mock(() => {})
    const onPrevious = mock(() => {})
    const onNext = mock(() => {})

    const handled = handleAutocompleteArrowFallback(
      { key: 'down', preventDefault, stopImmediatePropagation },
      true,
      onPrevious,
      onNext,
    )

    expect(handled).toBeTrue()
    expect(onPrevious).not.toHaveBeenCalled()
    expect(onNext).toHaveBeenCalledTimes(1)
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(stopImmediatePropagation).toHaveBeenCalledTimes(1)
  })

  test('无候选或非方向键时不触发 autocomplete 兜底', () => {
    expect(resolveAutocompleteArrowAction('up', false)).toBeUndefined()
    expect(resolveAutocompleteArrowAction('return', true)).toBeUndefined()
  })
})
