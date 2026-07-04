import type { ClickEvent } from '../../ink/events/click-event.js'
import type { OptionWithDescription } from './select.js'

/**
 * 鼠标点击选项的处理选项
 */
export type HandleOptionClickOptions<T> = {
  /** 聚焦指定值的选项 */
  focusOption: (value: T | undefined) => void
  /** 选择当前聚焦的选项（单选模式） */
  selectFocusedOption?: () => void
  /** 值变更回调（单选模式） */
  onChange?: (value: T) => void
  /** 切换选项选中状态（多选模式） */
  onToggle?: (value: T) => void
  /** 是否为多选模式 */
  isMultiSelect?: boolean
  /** input 选项当前值，用于与数字键选择语义保持一致 */
  inputValue?: string
}

/**
 * 处理 Select 选项的鼠标点击
 *
 * 与键盘路径保持一致：
 * - disabled 选项忽略
 * - input 选项有预填值时直接提交，空值时只聚焦
 * - 多选模式 toggle 选中状态
 * - 普通单选聚焦并选择
 *
 * @param option 被点击的选项
 * @param options 处理选项
 */
export function handleOptionClick<T>(
  option: OptionWithDescription<T>,
  options: HandleOptionClickOptions<T>,
): void {
  // disabled 选项忽略
  if (option.disabled) return

  // input 选项对齐数字键选择：预填值直接提交，空值进入编辑。
  if (option.type === 'input') {
    const currentInputValue = options.inputValue ?? option.initialValue ?? ''
    if (!options.isMultiSelect && (currentInputValue.trim() || option.allowEmptySubmitToCancel)) {
      options.onChange?.(option.value)
      return
    }
    options.focusOption(option.value)
    return
  }

  // 多选模式：聚焦并 toggle 选中状态
  if (options.isMultiSelect && options.onToggle) {
    options.focusOption(option.value)
    options.onToggle(option.value)
    return
  }

  // 普通单选：聚焦并选择
  options.focusOption(option.value)
  options.selectFocusedOption?.()
  options.onChange?.(option.value)
}

/**
 * 为 Select 组件创建 onClick 处理器
 *
 * @param option 选项
 * @param focusOption 聚焦函数
 * @param selectFocusedOption 选择聚焦选项函数
 * @param onChange 值变更回调
 * @returns onClick 处理器
 */
export function createOptionClickHandler<T>(
  option: OptionWithDescription<T>,
  focusOption: (value: T | undefined) => void,
  selectFocusedOption: () => void,
  onChange?: (value: T) => void,
  inputValue?: string,
): (event: ClickEvent) => void {
  return (_event: ClickEvent) => {
    handleOptionClick(option, {
      focusOption,
      selectFocusedOption,
      onChange,
      inputValue,
    })
  }
}

/**
 * 为 Select 组件创建鼠标悬浮处理器
 *
 * 参考 Claude Code 实现：hover 只更新 hoveredId 状态，不触发滚动。
 * 高亮逻辑由调用方根据 hoveredId ?? selectedSuggestion 决定。
 *
 * @param option 选项
 * @param setHoveredId 更新 hoveredId 的回调
 * @returns onMouseEnter 处理器
 */
export function createOptionHoverHandler<T>(
  option: OptionWithDescription<T>,
  setHoveredId: (id: T | null) => void,
): () => void {
  return () => {
    if (option.disabled) {
      return
    }
    setHoveredId(option.value)
  }
}

/**
 * 创建 onMouseLeave 处理器，清除 hoveredId
 *
 * @param setHoveredId 更新 hoveredId 的回调
 * @returns onMouseLeave 处理器
 */
export function createHoverLeaveHandler<T>(setHoveredId: (id: T | null) => void): () => void {
  return () => setHoveredId(null)
}

/**
 * 为 SelectMulti 组件创建 onClick 处理器
 *
 * @param option 选项
 * @param focusOption 聚焦函数
 * @param onToggle 切换选中状态函数
 * @returns onClick 处理器
 */
export function createMultiOptionClickHandler<T>(
  option: OptionWithDescription<T>,
  focusOption: (value: T | undefined) => void,
  onToggle: (value: T) => void,
): (event: ClickEvent) => void {
  return (_event: ClickEvent) => {
    handleOptionClick(option, {
      focusOption,
      onToggle,
      isMultiSelect: true,
    })
  }
}
