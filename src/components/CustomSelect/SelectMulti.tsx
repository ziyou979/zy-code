import { fig } from '../../constants/figures.js'
import { useState } from 'react'
import { Box, Text } from '../../ink.js'
import type { PastedContent } from '../../utils/config.js'
import type { ImageDimensions } from '../../utils/imageResizer.js'
import type { OptionWithDescription } from './select.js'
import { SelectInputOption } from './select-input-option.js'
import { SelectOption } from './select-option.js'
import {
  createMultiOptionClickHandler,
  createOptionHoverHandler,
  createHoverLeaveHandler,
} from './select-mouse-actions.js'
import { useMultiSelectState } from './use-multi-select-state.js'
export type SelectMultiProps<T> = {
  readonly isDisabled?: boolean
  readonly visibleOptionCount?: number
  readonly options: OptionWithDescription<T>[]
  readonly defaultValue?: T[]
  readonly onCancel: () => void
  readonly onChange?: (values: T[]) => void
  readonly onFocus?: (value: T) => void
  readonly focusValue?: T
  /**
   * Text for the submit button. When provided, a submit button is shown and
   * Enter toggles selection (submit only fires when the button is focused).
   * When omitted, Enter submits directly and Space toggles selection.
   */
  readonly submitButtonText?: string
  /**
   * Callback when user submits. Receives the currently selected values.
   */
  readonly onSubmit?: (values: T[]) => void
  /**
   * When true, hides the numeric indexes next to each option.
   */
  readonly hideIndexes?: boolean
  /**
   * Callback when user presses down from the last item (submit button).
   * If provided, navigation will not wrap to the first item.
   */
  readonly onDownFromLastItem?: () => void
  /**
   * Callback when user presses up from the first item.
   * If provided, navigation will not wrap to the last item.
   */
  readonly onUpFromFirstItem?: () => void
  /**
   * Focus the last option initially instead of the first.
   */
  readonly initialFocusLast?: boolean
  /**
   * Callback to open external editor for editing input option values.
   * When provided, ctrl+g will trigger this callback in input options
   * with the current value and a setter function to update the internal state.
   */
  readonly onOpenEditor?: (currentValue: string, setValue: (value: string) => void) => void
  readonly onImagePaste?: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    sourcePath?: string,
  ) => void
  readonly pastedContents?: Record<number, PastedContent>
  readonly onRemoveImage?: (id: number) => void
}
export function SelectMulti({
  isDisabled = false,
  visibleOptionCount = 5,
  options,
  defaultValue: defaultValueProp = [],
  onCancel,
  onChange,
  onFocus,
  focusValue,
  submitButtonText,
  onSubmit,
  onDownFromLastItem,
  onUpFromFirstItem,
  initialFocusLast,
  onOpenEditor,
  hideIndexes = false,
  onImagePaste,
  pastedContents,
  onRemoveImage,
}: // biome-ignore lint/suspicious/noExplicitAny: 泛型组件需要 any 以兼容多种调用方
SelectMultiProps<any>) {
  const defaultValue = defaultValueProp
  const state = useMultiSelectState({
    isDisabled,
    visibleOptionCount,
    options,
    defaultValue,
    onChange,
    onCancel,
    onFocus,
    focusValue,
    submitButtonText,
    onSubmit,
    onDownFromLastItem,
    onUpFromFirstItem,
    initialFocusLast,
    hideIndexes,
  })
  const maxIndexWidth = options.length.toString().length
  // 鼠标悬停状态，独立于 focusedValue，避免 hover 触发滚动
  const [hoveredId, setHoveredId] = useState<any>(null)

  // 切换选项的选中状态，用于鼠标点击
  const toggleSelectedValue = (value: any) => {
    if (state.selectedValues.includes(value)) {
      onChange?.(state.selectedValues.filter((v) => v !== value))
    } else {
      onChange?.([...state.selectedValues, value])
    }
  }
  const visibleOptionElements = state.visibleOptions.map((option, index) => {
    const isOptionFocused =
      !isDisabled && state.focusedValue === option.value && !state.isSubmitFocused
    const isSelected = state.selectedValues.includes(option.value)
    const isFirstVisibleOption = option.index === state.visibleFromIndex
    const isLastVisibleOption = option.index === state.visibleToIndex - 1
    const areMoreOptionsBelow = state.visibleToIndex < options.length
    const areMoreOptionsAbove = state.visibleFromIndex > 0
    const i = state.visibleFromIndex + index + 1
    if (option.type === 'input') {
      const inputValue = state.inputValues.get(option.value) || ''
      return (
        <Box key={String(option.value)} gap={1}>
          <SelectInputOption
            option={option}
            isFocused={isOptionFocused}
            isSelected={false}
            shouldShowDownArrow={areMoreOptionsBelow && isLastVisibleOption}
            shouldShowUpArrow={areMoreOptionsAbove && isFirstVisibleOption}
            maxIndexWidth={maxIndexWidth}
            index={i}
            inputValue={inputValue}
            onInputChange={(value) => {
              state.updateInputValue(option.value, value)
            }}
            onSubmit={noop}
            onExit={() => {
              onCancel()
            }}
            layout="compact"
            onOpenEditor={onOpenEditor}
            onImagePaste={onImagePaste}
            pastedContents={pastedContents}
            onRemoveImage={onRemoveImage}
          >
            <Text color={isSelected ? 'success' : undefined}>[{isSelected ? fig.tick : ' '}] </Text>
          </SelectInputOption>
        </Box>
      )
    }
    // 高亮逻辑：优先使用 hoveredId，否则使用 isSelected
    const isHovered = hoveredId != null && option.value === hoveredId
    const isEffectivelySelected = isHovered || isSelected
    return (
      <Box
        key={String(option.value)}
        gap={1}
        onClick={createMultiOptionClickHandler(option, state.focusOption, toggleSelectedValue)}
        onMouseEnter={createOptionHoverHandler(option, setHoveredId)}
        onMouseLeave={createHoverLeaveHandler(setHoveredId)}
      >
        <SelectOption
          isFocused={isOptionFocused}
          isSelected={isEffectivelySelected}
          shouldShowDownArrow={areMoreOptionsBelow && isLastVisibleOption}
          shouldShowUpArrow={areMoreOptionsAbove && isFirstVisibleOption}
          description={option.description}
        >
          {!hideIndexes && <Text dimColor={true}>{`${i}.`.padEnd(maxIndexWidth)}</Text>}
          <Text color={isEffectivelySelected ? 'success' : undefined}>
            [{isEffectivelySelected ? fig.tick : ' '}]
          </Text>
          <Text color={isOptionFocused ? 'suggestion' : undefined}>{option.label}</Text>
        </SelectOption>
      </Box>
    )
  })
  return (
    <Box flexDirection={'column'}>
      {<Box flexDirection={'column'}>{visibleOptionElements}</Box>}
      {submitButtonText && onSubmit && (
        <Box marginTop={0} gap={1}>
          {state.isSubmitFocused ? <Text color="suggestion">{fig.pointer}</Text> : <Text> </Text>}
          <Box marginLeft={3}>
            <Text color={state.isSubmitFocused ? 'suggestion' : undefined} bold={true}>
              {submitButtonText}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  )
}
function noop() {}
