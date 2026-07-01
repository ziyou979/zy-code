import figures from 'figures'
import React, { type ReactNode, useEffect, useRef, useState } from 'react'
import { useDeclaredCursor } from '../../ink/hooks/use-declared-cursor.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { Ansi, Box, Text } from '../../ink.js'
import { count } from '../../utils/array.js'
import type { PastedContent } from '../../utils/config.js'
import type { ImageDimensions } from '../../utils/imageResizer.js'
import type { ClickEvent } from '../../ink/events/click-event.js'
import { SelectInputOption } from './select-input-option.js'
import { SelectOption } from './select-option.js'
import { createOptionClickHandler, createOptionHoverHandler, createHoverLeaveHandler } from './select-mouse-actions.js'
import { useSelectInput } from './use-select-input.js'
import { useSelectState } from './use-select-state.js'

// Extract text content from ReactNode for width calculation
function getTextContent(node: ReactNode): string {
  if (typeof node === 'string') {
    return node
  }
  if (typeof node === 'number') {
    return String(node)
  }
  if (!node) {
    return ''
  }
  if (Array.isArray(node)) {
    return node.map(getTextContent).join('')
  }
  if (
    React.isValidElement<{
      children?: ReactNode
    }>(node)
  ) {
    return getTextContent(node.props.children)
  }
  return ''
}
type BaseOption<T> = {
  description?: string
  dimDescription?: boolean
  label: ReactNode
  value: T
  disabled?: boolean
}
export type OptionWithDescription<T = string> =
  | (BaseOption<T> & {
      type?: 'text'
    })
  | (BaseOption<T> & {
      type: 'input'
      onChange: (value: string) => void
      placeholder?: string
      initialValue?: string
      /**
       * Controls behavior when submitting with empty input:
       * - true: calls onChange (treats empty as valid submission)
       * - false (default): calls onCancel (treats empty as cancellation)
       *
       * Also affects initial Enter press: when true, submits immediately;
       * when false, enters input mode first so user can type.
       */
      allowEmptySubmitToCancel?: boolean
      /**
       * When true, always shows the label alongside the input value, regardless of
       * the global inlineDescriptions/showLabel setting. Use this when the label
       * provides important context that should always be visible (e.g., "Yes, and allow...").
       */
      showLabelWithValue?: boolean
      /**
       * Custom separator between label and value when showLabel is true.
       * Defaults to ", ". Use ": " for labels that read better with a colon.
       */
      labelValueSeparator?: string
      /**
       * When true, automatically reset cursor to end of line when:
       * - Option becomes focused
       * - Input value changes
       * This prevents cursor position bugs when the input value updates asynchronously.
       */
      resetCursorOnUpdate?: boolean
    })
export type SelectProps<T> = {
  /**
   * When disabled, user input is ignored.
   *
   * @default false
   */
  readonly isDisabled?: boolean

  /**
   * When true, prevents selection on Enter but allows scrolling.
   *
   * @default false
   */
  readonly disableSelection?: boolean

  /**
   * When true, hides the numeric indexes next to each option.
   *
   * @default false
   */
  readonly hideIndexes?: boolean

  /**
   * Number of visible options.
   *
   * @default 5
   */
  readonly visibleOptionCount?: number

  /**
   * Highlight text in option labels.
   */
  readonly highlightText?: string

  /**
   * Options.
   */
  readonly options: OptionWithDescription<T>[]

  /**
   * Default value.
   */
  readonly defaultValue?: T

  /**
   * Callback when cancel is pressed.
   */
  readonly onCancel?: () => void

  /**
   * Callback when selected option changes.
   */
  readonly onChange?: (value: T) => void

  /**
   * Callback when focused option changes.
   * Note: This is for one-way notification only. Avoid combining with focusValue
   * for bidirectional sync, as this can cause feedback loops.
   */
  readonly onFocus?: (value: T) => void

  /**
   * Initial value to focus. This is used to set focus when the component mounts.
   */
  readonly defaultFocusValue?: T

  /**
   * Layout of the options.
   * - `compact` (default) tries to use one line per option
   * - `expanded` uses multiple lines and an empty line between options
   * - `compact-vertical` uses compact index formatting with descriptions below labels
   */
  readonly layout?: 'compact' | 'expanded' | 'compact-vertical'

  /**
   * When true, descriptions are rendered inline after the label instead of
   * in a separate column. Use this for short descriptions like hints.
   *
   * @default false
   */
  readonly inlineDescriptions?: boolean

  /**
   * Callback when user presses up from the first item.
   * If provided, navigation will not wrap to the last item.
   */
  readonly onUpFromFirstItem?: () => void

  /**
   * Callback when user presses down from the last item.
   * If provided, navigation will not wrap to the first item.
   */
  readonly onDownFromLastItem?: () => void

  /**
   * Callback when input mode should be toggled for an option.
   * Called when Tab is pressed (to enter or exit input mode).
   */
  readonly onInputModeToggle?: (value: T) => void

  /**
   * Callback to open external editor for editing input option values.
   * When provided, ctrl+g will trigger this callback in input options
   * with the current value and a setter function to update the internal state.
   */
  readonly onOpenEditor?: (currentValue: string, setValue: (value: string) => void) => void

  /**
   * Optional callback when an image is pasted into an input option.
   */
  readonly onImagePaste?: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    sourcePath?: string,
  ) => void

  /**
   * Pasted content to display inline in input options.
   */
  readonly pastedContents?: Record<number, PastedContent>

  /**
   * Callback to remove a pasted image by its ID.
   */
  readonly onRemoveImage?: (id: number) => void
}
export function Select({
  isDisabled = false,
  hideIndexes = false,
  visibleOptionCount = 5,
  highlightText,
  options,
  defaultValue,
  onCancel,
  onChange,
  onFocus,
  defaultFocusValue,
  layout = 'compact',
  disableSelection = false,
  inlineDescriptions = false,
  onUpFromFirstItem,
  onDownFromLastItem,
  onInputModeToggle,
  onOpenEditor,
  onImagePaste,
  pastedContents,
  onRemoveImage,
}: // biome-ignore lint/suspicious/noExplicitAny: 泛型组件内部转发，无法避免 any
SelectProps<any>) {
  const [imagesSelected, setImagesSelected] = useState(false)
  const [selectedImageIndex, setSelectedImageIndex] = useState(0)
  const [inputValues, setInputValues] = useState(() => {
    const initialMap = new Map()
    options.forEach((option: OptionWithDescription<unknown>) => {
      if (option.type === 'input' && option.initialValue) {
        initialMap.set(option.value, option.initialValue)
      }
    })
    return initialMap
  })
  const emptyMap = new Map()
  const lastInitialValues = useRef(emptyMap)
  useEffect(() => {
    for (const option of options) {
      if (option.type === 'input' && option.initialValue !== undefined) {
        const lastInitial = lastInitialValues.current.get(option.value) ?? ''
        const currentValue = inputValues.get(option.value) ?? ''
        const newInitial = option.initialValue
        if (newInitial !== lastInitial && currentValue === lastInitial) {
          setInputValues((prev) => {
            const next = new Map(prev)
            next.set(option.value, newInitial)
            return next
          })
        }
        lastInitialValues.current.set(option.value, newInitial)
      }
    }
  }, [options, inputValues])
  const state = useSelectState({
    visibleOptionCount,
    options,
    defaultValue,
    onChange,
    onCancel,
    onFocus,
    focusValue: defaultFocusValue,
  })
  // 鼠标悬停状态，独立于 selectedSuggestion，避免 hover 触发滚动
  const [hoveredId, setHoveredId] = useState<any>(null)
  useSelectInput({
    isDisabled,
    disableSelection: disableSelection || (hideIndexes ? 'numeric' : false),
    state,
    options,
    isMultiSelect: false,
    onUpFromFirstItem,
    onDownFromLastItem,
    onInputModeToggle,
    inputValues,
    imagesSelected,
    onEnterImageSelection: () => {
      if (
        pastedContents &&
        Object.values(pastedContents).some((content) => content.type === 'image')
      ) {
        const imageCount = count(
          Object.values(pastedContents),
          (content) => content.type === 'image',
        )
        setImagesSelected(true)
        setSelectedImageIndex(imageCount - 1)
        return true
      }
      return false
    },
  })
  let BoxComponent!: typeof Box
  let containerResult
  let mappedItems
  let earlyReturn: React.ReactNode | symbol
  earlyReturn = Symbol.for('react.early_return_sentinel')
  const styles = {
    container: () => ({
      flexDirection: 'column' as const,
    }),
    highlightedText: () => ({
      bold: true,
    }),
  }
  if (layout === 'expanded') {
    const toStringResult = state.options.length.toString()
    const maxIndexWidth = toStringResult.length
    earlyReturn = (
      <Box {...styles.container()}>
        {state.visibleOptions.map((option, index) => {
          const isFirstVisibleOption = option.index === state.visibleFromIndex
          const isLastVisibleOption = option.index === state.visibleToIndex - 1
          const areMoreOptionsBelow = state.visibleToIndex < options.length
          const areMoreOptionsAbove = state.visibleFromIndex > 0
          const i = state.visibleFromIndex + index + 1
          const isFocused = !isDisabled && state.focusedValue === option.value
          const isSelected = state.value === option.value
          if (option.type === 'input') {
            const inputValue = inputValues.has(option.value)
              ? inputValues.get(option.value)
              : option.initialValue || ''
            return (
              <SelectInputOption
                key={String(option.value)}
                option={option}
                isFocused={isFocused}
                isSelected={isSelected}
                shouldShowDownArrow={areMoreOptionsBelow && isLastVisibleOption}
                shouldShowUpArrow={areMoreOptionsAbove && isFirstVisibleOption}
                maxIndexWidth={maxIndexWidth}
                index={i}
                inputValue={inputValue}
                onInputChange={(value) => {
                  setInputValues((prev) => {
                    const next = new Map(prev)
                    next.set(option.value, value)
                    return next
                  })
                }}
                onSubmit={(inputValue) => {
                  const hasImageAttachments =
                    pastedContents &&
                    Object.values(pastedContents).some((content) => content.type === 'image')
                  if (inputValue.trim() || hasImageAttachments || option.allowEmptySubmitToCancel) {
                    onChange?.(option.value)
                  } else {
                    onCancel?.()
                  }
                }}
                onExit={onCancel}
                layout="expanded"
                showLabel={inlineDescriptions}
                onOpenEditor={onOpenEditor}
                resetCursorOnUpdate={option.resetCursorOnUpdate}
                onImagePaste={onImagePaste}
                pastedContents={pastedContents}
                onRemoveImage={onRemoveImage}
                imagesSelected={imagesSelected}
                selectedImageIndex={selectedImageIndex}
                onImagesSelectedChange={setImagesSelected}
                onSelectedImageIndexChange={setSelectedImageIndex}
              />
            )
          }
          let label = option.label
          if (
            typeof option.label === 'string' &&
            highlightText &&
            option.label.includes(highlightText)
          ) {
            const labelText = option.label
            const displayIndex = labelText.indexOf(highlightText)
            label = (
              <>
                {labelText.slice(0, displayIndex)}
                <Text {...styles.highlightedText()}>{highlightText}</Text>
                {labelText.slice(displayIndex + highlightText.length)}
              </>
            )
          }
          const isOptionDisabled = option.disabled === true
          // 高亮逻辑：优先使用 hoveredId，否则使用 selectedSuggestion
          const isHovered = hoveredId != null && option.value === hoveredId
          const isEffectivelySelected = isHovered || isSelected
          const optionColor = isOptionDisabled
            ? undefined
            : isEffectivelySelected
              ? 'success'
              : isFocused
                ? 'suggestion'
                : undefined
          return (
            <Box
              key={String(option.value)}
              flexDirection="column"
              flexShrink={0}
              onClick={createOptionClickHandler(
                option,
                state.focusOption,
                state.selectFocusedOption,
                onChange,
              )}
              onMouseEnter={createOptionHoverHandler(option, setHoveredId)}
              onMouseLeave={createHoverLeaveHandler(setHoveredId)}
            >
              <SelectOption
                isFocused={isFocused}
                isSelected={isEffectivelySelected}
                shouldShowDownArrow={areMoreOptionsBelow && isLastVisibleOption}
                shouldShowUpArrow={areMoreOptionsAbove && isFirstVisibleOption}
              >
                <Text dimColor={isOptionDisabled} color={optionColor}>
                  {label}
                </Text>
              </SelectOption>
              {option.description && (
                <Box paddingLeft={2}>
                  <Text
                    dimColor={isOptionDisabled || option.dimDescription !== false}
                    color={optionColor}
                  >
                    <Ansi>{option.description}</Ansi>
                  </Text>
                </Box>
              )}
              <Text> </Text>
            </Box>
          )
        })}
      </Box>
    )
  } else if (layout === 'compact-vertical') {
    const maxIndexWidth_0 = hideIndexes ? 0 : state.options.length.toString().length
    earlyReturn = (
      <Box {...styles.container()}>
        {state.visibleOptions.map((option_2, index_1) => {
          const isFirstVisibleOption_0 = option_2.index === state.visibleFromIndex
          const isLastVisibleOption_0 = option_2.index === state.visibleToIndex - 1
          const areMoreOptionsBelow_0 = state.visibleToIndex < options.length
          const areMoreOptionsAbove_0 = state.visibleFromIndex > 0
          const i_0 = state.visibleFromIndex + index_1 + 1
          const isFocused_0 = !isDisabled && state.focusedValue === option_2.value
          const isSelected_0 = state.value === option_2.value
          if (option_2.type === 'input') {
            const inputValue_0 = inputValues.has(option_2.value)
              ? inputValues.get(option_2.value)
              : option_2.initialValue || ''
            return (
              <SelectInputOption
                key={String(option_2.value)}
                option={option_2}
                isFocused={isFocused_0}
                isSelected={isSelected_0}
                shouldShowDownArrow={areMoreOptionsBelow_0 && isLastVisibleOption_0}
                shouldShowUpArrow={areMoreOptionsAbove_0 && isFirstVisibleOption_0}
                maxIndexWidth={maxIndexWidth_0}
                index={i_0}
                inputValue={inputValue_0}
                onInputChange={(value_1) => {
                  setInputValues((prev_1) => {
                    const next_1 = new Map(prev_1)
                    next_1.set(option_2.value, value_1)
                    return next_1
                  })
                }}
                onSubmit={(value_2) => {
                  const hasImageAttachments_0 =
                    pastedContents &&
                    Object.values(pastedContents).some((c_2) => c_2.type === 'image')
                  if (
                    value_2.trim() ||
                    hasImageAttachments_0 ||
                    option_2.allowEmptySubmitToCancel
                  ) {
                    onChange?.(option_2.value)
                  } else {
                    onCancel?.()
                  }
                }}
                onExit={onCancel}
                layout="compact"
                showLabel={inlineDescriptions}
                onOpenEditor={onOpenEditor}
                resetCursorOnUpdate={option_2.resetCursorOnUpdate}
                onImagePaste={onImagePaste}
                pastedContents={pastedContents}
                onRemoveImage={onRemoveImage}
                imagesSelected={imagesSelected}
                selectedImageIndex={selectedImageIndex}
                onImagesSelectedChange={setImagesSelected}
                onSelectedImageIndexChange={setSelectedImageIndex}
              />
            )
          }
          let label_0 = option_2.label
          if (
            typeof option_2.label === 'string' &&
            highlightText &&
            option_2.label.includes(highlightText)
          ) {
            const labelText_0 = option_2.label
            const index_2 = labelText_0.indexOf(highlightText)
            label_0 = (
              <>
                {labelText_0.slice(0, index_2)}
                <Text {...styles.highlightedText()}>{highlightText}</Text>
                {labelText_0.slice(index_2 + highlightText.length)}
              </>
            )
          }
          const isOptionDisabled_0 = option_2.disabled === true
          // 高亮逻辑：优先使用 hoveredId，否则使用 selectedSuggestion
          const isHovered_0 = hoveredId != null && option_2.value === hoveredId
          const isEffectivelySelected_0 = isHovered_0 || isSelected_0
          return (
            <Box
              key={String(option_2.value)}
              flexDirection="column"
              flexShrink={0}
              onClick={createOptionClickHandler(
                option_2,
                state.focusOption,
                state.selectFocusedOption,
                onChange,
              )}
              onMouseEnter={createOptionHoverHandler(option_2, setHoveredId)}
              onMouseLeave={createHoverLeaveHandler(setHoveredId)}
            >
              <SelectOption
                isFocused={isFocused_0}
                isSelected={isEffectivelySelected_0}
                shouldShowDownArrow={areMoreOptionsBelow_0 && isLastVisibleOption_0}
                shouldShowUpArrow={areMoreOptionsAbove_0 && isFirstVisibleOption_0}
              >
                {!hideIndexes && (
                  <Text dimColor={true}>{`${i_0}.`.padEnd(maxIndexWidth_0 + 1)}</Text>
                )}
                <Text
                  dimColor={isOptionDisabled_0}
                  color={
                    isOptionDisabled_0
                      ? undefined
                      : isEffectivelySelected_0
                        ? 'success'
                        : isFocused_0
                          ? 'suggestion'
                          : undefined
                  }
                >
                  {label_0}
                </Text>
              </SelectOption>
              {option_2.description && (
                <Box paddingLeft={hideIndexes ? 4 : maxIndexWidth_0 + 4}>
                  <Text
                    dimColor={isOptionDisabled_0 || option_2.dimDescription !== false}
                    color={
                      isOptionDisabled_0
                        ? undefined
                        : isEffectivelySelected_0
                          ? 'success'
                          : isFocused_0
                            ? 'suggestion'
                            : undefined
                    }
                  >
                    <Ansi>{option_2.description}</Ansi>
                  </Text>
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )
  } else {
    const maxIndexWidth_1 = hideIndexes ? 0 : state.options.length.toString().length
    const hasInputOptions = state.visibleOptions.some((opt) => opt.type === 'input')
    const hasDescriptions =
      !inlineDescriptions && !hasInputOptions && state.visibleOptions.some((opt) => opt.description)
    const optionData = state.visibleOptions.map((option, index) => {
      const isFirstVisibleOption = option.index === state.visibleFromIndex
      const isLastVisibleOption = option.index === state.visibleToIndex - 1
      const areMoreOptionsBelow = state.visibleToIndex < options.length
      const areMoreOptionsAbove = state.visibleFromIndex > 0
      const displayIndex = state.visibleFromIndex + index + 1
      const isFocused = !isDisabled && state.focusedValue === option.value
      const isSelected = state.value === option.value
      const isOptionDisabled = option.disabled === true
      let renderedLabel = option.label
      if (
        typeof option.label === 'string' &&
        highlightText &&
        option.label.includes(highlightText)
      ) {
        const labelText = option.label
        const idx = labelText.indexOf(highlightText)
        renderedLabel = (
          <>
            {labelText.slice(0, idx)}
            <Text {...styles.highlightedText()}>{highlightText}</Text>
            {labelText.slice(idx + highlightText.length)}
          </>
        )
      }
      return {
        option: option,
        index: displayIndex,
        label: renderedLabel,
        isFocused: isFocused,
        isSelected: isSelected,
        isOptionDisabled: isOptionDisabled,
        shouldShowDownArrow: areMoreOptionsBelow && isLastVisibleOption,
        shouldShowUpArrow: areMoreOptionsAbove && isFirstVisibleOption,
      }
    })
    if (hasDescriptions) {
      const maxLabelWidth = Math.max(
        ...optionData.map((data) => {
          if (data.option.type === 'input') {
            return 0
          }
          const labelText_2 = getTextContent(data.option.label)
          const indexWidth = hideIndexes ? 0 : maxIndexWidth_1 + 2
          const checkmarkWidth = data.isSelected ? 2 : 0
          return 2 + indexWidth + stringWidth(labelText_2) + checkmarkWidth
        }),
      )
      earlyReturn = (
        <Box {...styles.container()}>
          {optionData.map((data) => {
            if (data.option.type === 'input') {
              return null
            }
            const labelText = getTextContent(data.option.label)
            const indexWidth = hideIndexes ? 0 : maxIndexWidth_1 + 2
            // 高亮逻辑：优先使用 hoveredId，否则使用 selectedSuggestion
            const isHovered_1 = hoveredId != null && data.option.value === hoveredId
            const isEffectivelySelected_1 = isHovered_1 || data.isSelected
            const checkmarkWidth = isEffectivelySelected_1 ? 2 : 0
            const currentLabelWidth = 2 + indexWidth + stringWidth(labelText) + checkmarkWidth
            const padding = maxLabelWidth - currentLabelWidth
            return (
              <TwoColumnRow
                key={String(data.option.value)}
                isFocused={data.isFocused}
                onClick={createOptionClickHandler(
                  data.option,
                  state.focusOption,
                  state.selectFocusedOption,
                  onChange,
                )}
                onMouseEnter={createOptionHoverHandler(data.option, setHoveredId)}
                onMouseLeave={createHoverLeaveHandler(setHoveredId)}
              >
                <Box flexDirection="row" flexShrink={0}>
                  {data.isFocused ? (
                    <Text color="suggestion">{figures.pointer}</Text>
                  ) : data.shouldShowDownArrow ? (
                    <Text dimColor={true}>{figures.arrowDown}</Text>
                  ) : data.shouldShowUpArrow ? (
                    <Text dimColor={true}>{figures.arrowUp}</Text>
                  ) : (
                    <Text> </Text>
                  )}
                  <Text> </Text>
                  <Text
                    dimColor={data.isOptionDisabled}
                    color={
                      data.isOptionDisabled
                        ? undefined
                        : isEffectivelySelected_1
                          ? 'success'
                          : data.isFocused
                            ? 'suggestion'
                            : undefined
                    }
                  >
                    {!hideIndexes && (
                      <Text dimColor={true}>{`${data.index}.`.padEnd(maxIndexWidth_1 + 2)}</Text>
                    )}
                    {data.label}
                  </Text>
                  {isEffectivelySelected_1 && <Text color="success"> {figures.tick}</Text>}
                  {padding > 0 && <Text>{' '.repeat(padding)}</Text>}
                </Box>
                <Box flexGrow={1} marginLeft={2}>
                  <Text
                    wrap="wrap"
                    dimColor={data.isOptionDisabled || data.option.dimDescription !== false}
                    color={
                      data.isOptionDisabled
                        ? undefined
                        : isEffectivelySelected_1
                          ? 'success'
                          : data.isFocused
                            ? 'suggestion'
                            : undefined
                    }
                  >
                    <Ansi>{data.option.description || ' '}</Ansi>
                  </Text>
                </Box>
              </TwoColumnRow>
            )
          })}
        </Box>
      )
    } else {
      BoxComponent = Box
      containerResult = styles.container()
      mappedItems = state.visibleOptions.map((option, index) => {
        if (option.type === 'input') {
          const inputValue = inputValues.has(option.value)
            ? inputValues.get(option.value)
            : option.initialValue || ''
          const isFirstVisibleOption = option.index === state.visibleFromIndex
          const isLastVisibleOption = option.index === state.visibleToIndex - 1
          const areMoreOptionsBelow = state.visibleToIndex < options.length
          const areMoreOptionsAbove = state.visibleFromIndex > 0
          const displayIndex = state.visibleFromIndex + index + 1
          const isFocused = !isDisabled && state.focusedValue === option.value
          const isSelected = state.value === option.value
          return (
            <SelectInputOption
              key={String(option.value)}
              option={option}
              isFocused={isFocused}
              isSelected={isSelected}
              shouldShowDownArrow={areMoreOptionsBelow && isLastVisibleOption}
              shouldShowUpArrow={areMoreOptionsAbove && isFirstVisibleOption}
              maxIndexWidth={maxIndexWidth_1}
              index={displayIndex}
              inputValue={inputValue}
              onInputChange={(value) => {
                setInputValues((prev) => {
                  const next = new Map(prev)
                  next.set(option.value, value)
                  return next
                })
              }}
              onSubmit={(newValue) => {
                const hasImageAttachments =
                  pastedContents &&
                  Object.values(pastedContents).some((content) => content.type === 'image')
                if (newValue.trim() || hasImageAttachments || option.allowEmptySubmitToCancel) {
                  onChange?.(option.value)
                } else {
                  onCancel?.()
                }
              }}
              onExit={onCancel}
              layout="compact"
              showLabel={inlineDescriptions}
              onOpenEditor={onOpenEditor}
              resetCursorOnUpdate={option.resetCursorOnUpdate}
              onImagePaste={onImagePaste}
              pastedContents={pastedContents}
              onRemoveImage={onRemoveImage}
              imagesSelected={imagesSelected}
              selectedImageIndex={selectedImageIndex}
              onImagesSelectedChange={setImagesSelected}
              onSelectedImageIndexChange={setSelectedImageIndex}
            />
          )
        }
        let renderedLabel = option.label
        if (
          typeof option.label === 'string' &&
          highlightText &&
          option.label.includes(highlightText)
        ) {
          const labelText = option.label
          const displayIndex = labelText.indexOf(highlightText)
          renderedLabel = (
            <>
              {labelText.slice(0, displayIndex)}
              <Text {...styles.highlightedText()}>{highlightText}</Text>
              {labelText.slice(displayIndex + highlightText.length)}
            </>
          )
        }
        const isFirstVisibleOption = option.index === state.visibleFromIndex
        const isLastVisibleOption = option.index === state.visibleToIndex - 1
        const areMoreOptionsBelow = state.visibleToIndex < options.length
        const areMoreOptionsAbove = state.visibleFromIndex > 0
        const displayIndex = state.visibleFromIndex + index + 1
        const isFocused = !isDisabled && state.focusedValue === option.value
        const isSelected = state.value === option.value
        const isOptionDisabled = option.disabled === true
        // 高亮逻辑：优先使用 hoveredId，否则使用 selectedSuggestion
        const isHovered_2 = hoveredId != null && option.value === hoveredId
        const isEffectivelySelected_2 = isHovered_2 || isSelected
        return (
          <SelectOption
            key={String(option.value)}
            isFocused={isFocused}
            isSelected={isEffectivelySelected_2}
            shouldShowDownArrow={areMoreOptionsBelow && isLastVisibleOption}
            shouldShowUpArrow={areMoreOptionsAbove && isFirstVisibleOption}
            onClick={createOptionClickHandler(
              option,
              state.focusOption,
              state.selectFocusedOption,
              onChange,
            )}
            onMouseEnter={createOptionHoverHandler(option, setHoveredId)}
            onMouseLeave={createHoverLeaveHandler(setHoveredId)}
          >
            <Box flexDirection="row" flexShrink={0}>
              {!hideIndexes && (
                <Text dimColor={true}>{`${displayIndex}.`.padEnd(maxIndexWidth_1 + 2)}</Text>
              )}
              <Text
                dimColor={isOptionDisabled}
                color={
                  isOptionDisabled
                    ? undefined
                    : isEffectivelySelected_2
                      ? 'success'
                      : isFocused
                        ? 'suggestion'
                        : undefined
                }
              >
                {renderedLabel}
                {inlineDescriptions && option.description && (
                  <Text dimColor={isOptionDisabled || option.dimDescription !== false}>
                    {' '}
                    {option.description}
                  </Text>
                )}
              </Text>
            </Box>
            {!inlineDescriptions && option.description && (
              <Box flexShrink={99} marginLeft={2}>
                <Text
                  wrap="wrap-trim"
                  dimColor={isOptionDisabled || option.dimDescription !== false}
                  color={
                    isOptionDisabled
                      ? undefined
                      : isEffectivelySelected_2
                        ? 'success'
                        : isFocused
                          ? 'suggestion'
                          : undefined
                  }
                >
                  <Ansi>{option.description}</Ansi>
                </Text>
              </Box>
            )}
          </SelectOption>
        )
      })
    }
  }
  if (earlyReturn !== Symbol.for('react.early_return_sentinel')) {
    return earlyReturn as React.ReactNode
  }
  return <BoxComponent {...containerResult}>{mappedItems}</BoxComponent>
}

// Row container for the two-column (label + description) layout. Unlike
// the other Select layouts, this one doesn't render through SelectOption →
// ListItem, so it declares the native cursor directly. Parks the cursor
// on the pointer indicator so screen readers / magnifiers track focus.

function TwoColumnRow({
  isFocused,
  children,
  onClick,
  onMouseEnter,
  onMouseLeave,
}: {
  isFocused: boolean
  children: React.ReactNode
  onClick?: (event: ClickEvent) => void
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}) {
  const cursorRef = useDeclaredCursor({
    line: 0,
    column: 0,
    active: isFocused,
  })
  return (
    <Box ref={cursorRef} flexDirection="row" onClick={onClick} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      {children}
    </Box>
  )
}
