export type PromptHistoryNavigation = {
  onHistoryUp?: () => void
  onHistoryDown?: () => void
}

export type AutocompleteArrowAction = 'previous' | 'next'

/** 计算候选列表循环导航后的索引。 */
export function getNextSuggestionIndex(
  selectedSuggestion: number,
  suggestionCount: number,
  action: AutocompleteArrowAction,
): number {
  if (suggestionCount <= 0) {
    return -1
  }
  if (action === 'previous') {
    return selectedSuggestion <= 0 ? suggestionCount - 1 : selectedSuggestion - 1
  }
  return selectedSuggestion < 0 || selectedSuggestion >= suggestionCount - 1
    ? 0
    : selectedSuggestion + 1
}

/**
 * 自动补全候选显示时，上下键必须只用于候选导航。
 * BaseTextInput 比父级 keybinding 更早收到输入；若仍传入历史回调，
 * 同一个方向键会先切换历史，再切换候选，输入刷新后又把候选选中项重置。
 */
export function resolvePromptHistoryNavigation(
  hasSuggestions: boolean,
  onHistoryUp: (() => void) | undefined,
  onHistoryDown: (() => void) | undefined,
): PromptHistoryNavigation {
  if (hasSuggestions) {
    return {}
  }
  return { onHistoryUp, onHistoryDown }
}

/**
 * keybinding resolver 未消费方向键时的 autocomplete 兜底。
 * 显式 rebind/unbind 会更早停止事件，因此这里只处理泄漏到输入框后的默认 ↑/↓。
 */
export function resolveAutocompleteArrowAction(
  key: string,
  hasSuggestions: boolean,
): AutocompleteArrowAction | undefined {
  if (!hasSuggestions) {
    return undefined
  }
  if (key === 'up') {
    return 'previous'
  }
  if (key === 'down') {
    return 'next'
  }
  return undefined
}

type AutocompleteArrowEvent = {
  key: string
  preventDefault: () => void
  stopImmediatePropagation: () => void
}

/** 执行方向键兜底；返回 true 表示事件已被 autocomplete 消费。 */
export function handleAutocompleteArrowFallback(
  event: AutocompleteArrowEvent,
  hasSuggestions: boolean,
  onPrevious: () => void,
  onNext: () => void,
): boolean {
  const action = resolveAutocompleteArrowAction(event.key, hasSuggestions)
  if (!action) {
    return false
  }
  event.preventDefault()
  if (action === 'previous') {
    onPrevious()
  } else {
    onNext()
  }
  event.stopImmediatePropagation()
  return true
}
