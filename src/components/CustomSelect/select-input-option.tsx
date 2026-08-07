import { type ReactNode, useContext, useEffect, useRef, useState } from 'react'
import type { ClickEvent } from '../../ink/events/clickEvent.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- UP arrow exit not in Attachments bindings
import { Box, Text, useInput } from '../../ink/index.js'
import { TerminalSizeContext } from '../../ink/components/TerminalSizeContext.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js'
import type { PastedContent } from '../../services/config/config.js'
import { getImageFromClipboard } from '../../services/attachments/imagePaste.js'
import type { ImageDimensions } from '../../services/attachments/imageResizer.js'
import { ClickableImageRef } from '../ClickableImageRef.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'
import { Byline } from '../design-system/Byline.js'
import TextInput from '../TextInput.js'
import type { OptionWithDescription } from './select.js'
import { SelectOption } from './select-option.js'

type Props<T> = {
  option: Extract<
    OptionWithDescription<T>,
    {
      type: 'input'
    }
  >
  isFocused: boolean
  isSelected: boolean
  isHovered?: boolean
  shouldShowDownArrow: boolean
  shouldShowUpArrow: boolean
  maxIndexWidth: number
  index: number
  inputValue: string
  onInputChange: (value: string) => void
  onSubmit: (value: string) => void
  onExit?: () => void
  layout: 'compact' | 'expanded'
  children?: ReactNode
  /**
   * When true, shows the label before the input field.
   * When false (default), uses the label as the placeholder.
   */
  showLabel?: boolean
  /**
   * Callback to open external editor for editing the input value.
   * When provided, ctrl+g will trigger this callback with the current value
   * and a setter function to update the internal state.
   */
  onOpenEditor?: (currentValue: string, setValue: (value: string) => void) => void
  /**
   * When true, automatically reset cursor to end of line when:
   * - Option becomes focused
   * - Input value changes
   * This prevents cursor position bugs when the input value updates asynchronously.
   */
  resetCursorOnUpdate?: boolean
  /**
   * Optional callback when an image is pasted into the input.
   */
  onImagePaste?: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    sourcePath?: string,
  ) => void
  /**
   * Pasted content to display inline above the input when focused.
   */
  pastedContents?: Record<number, PastedContent>
  /**
   * Callback to remove a pasted image by its ID.
   */
  onRemoveImage?: (id: number) => void
  /**
   * Whether image selection mode is active.
   */
  imagesSelected?: boolean
  /**
   * Currently selected image index within the image attachments array.
   */
  selectedImageIndex?: number
  /**
   * Callback to set image selection mode on/off.
   */
  onImagesSelectedChange?: (selected: boolean) => void
  /**
   * Callback to change the selected image index.
   */
  onSelectedImageIndexChange?: (index: number) => void
  /**
   * 鼠标点击时触发。
   */
  onClick?: (event: ClickEvent) => void
  /**
   * 鼠标移入时触发。
   */
  onMouseEnter?: () => void
  /**
   * 鼠标移出时触发。
   */
  onMouseLeave?: () => void
}
export function SelectInputOption({
  option,
  isFocused,
  isSelected,
  isHovered = false,
  shouldShowDownArrow,
  shouldShowUpArrow,
  maxIndexWidth,
  index,
  inputValue,
  onInputChange,
  onSubmit,
  onExit,
  layout,
  children,
  showLabel: showLabelProp = false,
  onOpenEditor,
  resetCursorOnUpdate = false,
  onImagePaste,
  pastedContents,
  onRemoveImage,
  imagesSelected,
  selectedImageIndex = 0,
  onImagesSelectedChange,
  onSelectedImageIndexChange,
  onClick,
  onMouseEnter,
  onMouseLeave,
}: // biome-ignore lint/suspicious/noExplicitAny: 泛型组件内部转发，无法避免 any
Props<any>) {
  const imageAttachments = pastedContents
    ? Object.values(pastedContents).filter((c) => c.type === 'image')
    : []
  const terminalSize = useContext(TerminalSizeContext)
  const showLabel = showLabelProp || option.showLabelWithValue === true
  const [cursorOffset, setCursorOffset] = useState(inputValue.length)
  const isUserEditing = useRef(false)
  useEffect(() => {
    if (resetCursorOnUpdate && isFocused) {
      if (isUserEditing.current) {
        isUserEditing.current = false
      } else {
        setCursorOffset(inputValue.length)
      }
    }
  }, [resetCursorOnUpdate, isFocused, inputValue])
  useKeybinding(
    'chat:externalEditor',
    () => {
      onOpenEditor?.(inputValue, onInputChange)
    },
    {
      context: 'Chat',
      isActive: isFocused && !!onOpenEditor,
    },
  )
  useKeybinding(
    'chat:imagePaste',
    () => {
      if (!onImagePaste) {
        return
      }
      getImageFromClipboard().then((imageData) => {
        if (imageData) {
          onImagePaste(imageData.base64, imageData.mediaType, undefined, imageData.dimensions)
        }
      })
    },
    {
      context: 'Chat',
      isActive: isFocused && !!onImagePaste,
    },
  )
  useKeybinding(
    'attachments:remove',
    () => {
      if (imageAttachments.length > 0 && onRemoveImage) {
        onRemoveImage(imageAttachments.at(-1)!.id)
      }
    },
    {
      context: 'Attachments',
      isActive:
        isFocused &&
        !imagesSelected &&
        inputValue === '' &&
        imageAttachments.length > 0 &&
        !!onRemoveImage,
    },
  )
  useKeybindings(
    {
      'attachments:next': () => {
        if (imageAttachments.length > 1) {
          onSelectedImageIndexChange?.((selectedImageIndex + 1) % imageAttachments.length)
        }
      },
      'attachments:previous': () => {
        if (imageAttachments.length > 1) {
          onSelectedImageIndexChange?.(
            (selectedImageIndex - 1 + imageAttachments.length) % imageAttachments.length,
          )
        }
      },
      'attachments:remove': () => {
        const img = imageAttachments[selectedImageIndex]
        if (img && onRemoveImage) {
          onRemoveImage(img.id)
          if (imageAttachments.length <= 1) {
            onImagesSelectedChange?.(false)
          } else {
            onSelectedImageIndexChange?.(Math.min(selectedImageIndex, imageAttachments.length - 2))
          }
        }
      },
      'attachments:exit': () => {
        onImagesSelectedChange?.(false)
      },
    },
    {
      context: 'Attachments',
      isActive: isFocused && !!imagesSelected,
    },
  )
  useInput(
    (_input, key) => {
      if (key.upArrow) {
        onImagesSelectedChange?.(false)
      }
    },
    {
      isActive: isFocused && !!imagesSelected,
    },
  )
  useEffect(() => {
    if (!isFocused && imagesSelected) {
      onImagesSelectedChange?.(false)
    }
  }, [isFocused, imagesSelected, onImagesSelectedChange])
  const descriptionPaddingLeft = layout === 'expanded' ? maxIndexWidth + 3 : maxIndexWidth + 4
  const indexLabel = `${index}.`.padEnd(maxIndexWidth + 2)
  const labelValueSeparator = option.labelValueSeparator ?? ', '
  const labelWidth =
    typeof option.label === 'string'
      ? stringWidth(option.label) + stringWidth(labelValueSeparator)
      : 0
  // 标签与长输入值同处一行时，输入框内部换行会继承标签后的横向偏移。
  // 超出当前行后改用悬挂布局，让输入值及其所有续行从选项正文列开始。
  const optionContentColumns = Math.max(
    2,
    (terminalSize?.columns ?? 80) - 2 - stringWidth(indexLabel),
  )
  const shouldStackLabeledInput =
    isFocused &&
    showLabel &&
    labelWidth > 0 &&
    labelWidth + stringWidth(inputValue) >= optionContentColumns
  const inputColumns = Math.max(
    2,
    shouldStackLabeledInput ? optionContentColumns : optionContentColumns - labelWidth,
  )
  const inputElement = isFocused ? (
    <TextInput
      value={inputValue}
      onChange={(value) => {
        isUserEditing.current = true
        onInputChange(value)
        option.onChange(value)
      }}
      onSubmit={onSubmit}
      onExit={onExit}
      placeholder={
        showLabel
          ? option.placeholder
          : option.placeholder || (typeof option.label === 'string' ? option.label : undefined)
      }
      focus={!imagesSelected}
      showCursor={true}
      multiline={true}
      cursorOffset={cursorOffset}
      onChangeCursorOffset={setCursorOffset}
      columns={inputColumns}
      onImagePaste={onImagePaste}
      onPaste={(pastedText) => {
        isUserEditing.current = true
        const before = inputValue.slice(0, cursorOffset)
        const after = inputValue.slice(cursorOffset)
        const newValue = before + pastedText + after
        onInputChange(newValue)
        option.onChange(newValue)
        setCursorOffset(before.length + pastedText.length)
      }}
    />
  ) : null
  return (
    <Box flexDirection="column" flexShrink={0}>
      {
        <SelectOption
          isFocused={isFocused}
          isSelected={isSelected}
          isHovered={isHovered}
          shouldShowDownArrow={shouldShowDownArrow}
          shouldShowUpArrow={shouldShowUpArrow}
          declareCursor={false}
          onClick={onClick}
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
        >
          {
            <Box
              flexDirection={shouldStackLabeledInput ? 'column' : 'row'}
              flexShrink={layout === 'compact' ? 0 : undefined}
            >
              {shouldStackLabeledInput ? (
                <>
                  <Box flexDirection="row">
                    <Text dimColor={true}>{indexLabel}</Text>
                    {children}
                    <Text color="suggestion">
                      {option.label}
                      {labelValueSeparator}
                    </Text>
                  </Box>
                  <Box paddingLeft={stringWidth(indexLabel)}>{inputElement}</Box>
                </>
              ) : (
                <>
                  <Text dimColor={true}>{indexLabel}</Text>
                  {children}
                  {showLabel ? (
                    isFocused ? (
                      <>
                        <Text color="suggestion">
                          {option.label}
                          {labelValueSeparator}
                        </Text>
                        {inputElement}
                      </>
                    ) : (
                      <Text color={inputValue ? undefined : 'inactive'}>
                        {option.label}
                        {inputValue ? `${labelValueSeparator}${inputValue}` : ''}
                      </Text>
                    )
                  ) : isFocused ? (
                    inputElement
                  ) : (
                    <Text color={inputValue ? undefined : 'inactive'}>
                      {inputValue || option.placeholder || option.label}
                    </Text>
                  )}
                </>
              )}
            </Box>
          }
        </SelectOption>
      }
      {option.description && (
        <Box paddingLeft={descriptionPaddingLeft}>
          <Text
            dimColor={option.dimDescription !== false}
            color={isSelected ? 'success' : isFocused ? 'suggestion' : undefined}
          >
            {option.description}
          </Text>
        </Box>
      )}
      {imageAttachments.length > 0 && (
        <Box flexDirection="row" gap={1} paddingLeft={descriptionPaddingLeft}>
          {imageAttachments.map((img_0, idx) => (
            <ClickableImageRef
              key={img_0.id}
              imageId={img_0.id}
              isSelected={!!imagesSelected && idx === selectedImageIndex}
            />
          ))}
          <Box flexGrow={1} justifyContent="flex-start" flexDirection="row">
            <Text dimColor={true}>
              {imagesSelected ? (
                <Byline>
                  {imageAttachments.length > 1 && (
                    <>
                      <ConfigurableShortcutHint
                        action="attachments:next"
                        context="Attachments"
                        fallback={'\u2192'}
                        description="next"
                      />
                      <ConfigurableShortcutHint
                        action="attachments:previous"
                        context="Attachments"
                        fallback={'\u2190'}
                        description="prev"
                      />
                    </>
                  )}
                  <ConfigurableShortcutHint
                    action="attachments:remove"
                    context="Attachments"
                    fallback="backspace"
                    description="remove"
                  />
                  <ConfigurableShortcutHint
                    action="attachments:exit"
                    context="Attachments"
                    fallback="esc"
                    description="cancel"
                  />
                </Byline>
              ) : isFocused ? (
                '(\u2193 to select)'
              ) : null}
            </Text>
          </Box>
        </Box>
      )}
      {layout === 'expanded' && <Text> </Text>}
    </Box>
  )
}
