import figures from 'figures';
import React, { type ReactNode, useEffect, useRef, useState } from 'react';
import { useDeclaredCursor } from '../../ink/hooks/use-declared-cursor.js';
import { stringWidth } from '../../ink/stringWidth.js';
import { Ansi, Box, Text } from '../../ink.js';
import { count } from '../../utils/array.js';
import type { PastedContent } from '../../utils/config.js';
import type { ImageDimensions } from '../../utils/imageResizer.js';
import { SelectInputOption } from './select-input-option.js';
import { SelectOption } from './select-option.js';
import { useSelectInput } from './use-select-input.js';
import { useSelectState } from './use-select-state.js';

// Extract text content from ReactNode for width calculation
function getTextContent(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (!node) return '';
  if (Array.isArray(node)) return node.map(getTextContent).join('');
  if (React.isValidElement<{
    children?: ReactNode;
  }>(node)) {
    return getTextContent(node.props.children);
  }
  return '';
}
type BaseOption<T> = {
  description?: string;
  dimDescription?: boolean;
  label: ReactNode;
  value: T;
  disabled?: boolean;
};
export type OptionWithDescription<T = string> = (BaseOption<T> & {
  type?: 'text';
}) | (BaseOption<T> & {
  type: 'input';
  onChange: (value: string) => void;
  placeholder?: string;
  initialValue?: string;
  /**
   * Controls behavior when submitting with empty input:
   * - true: calls onChange (treats empty as valid submission)
   * - false (default): calls onCancel (treats empty as cancellation)
   *
   * Also affects initial Enter press: when true, submits immediately;
   * when false, enters input mode first so user can type.
   */
  allowEmptySubmitToCancel?: boolean;
  /**
   * When true, always shows the label alongside the input value, regardless of
   * the global inlineDescriptions/showLabel setting. Use this when the label
   * provides important context that should always be visible (e.g., "Yes, and allow...").
   */
  showLabelWithValue?: boolean;
  /**
   * Custom separator between label and value when showLabel is true.
   * Defaults to ", ". Use ": " for labels that read better with a colon.
   */
  labelValueSeparator?: string;
  /**
   * When true, automatically reset cursor to end of line when:
   * - Option becomes focused
   * - Input value changes
   * This prevents cursor position bugs when the input value updates asynchronously.
   */
  resetCursorOnUpdate?: boolean;
});
export type SelectProps<T> = {
  /**
   * When disabled, user input is ignored.
   *
   * @default false
   */
  readonly isDisabled?: boolean;

  /**
   * When true, prevents selection on Enter but allows scrolling.
   *
   * @default false
   */
  readonly disableSelection?: boolean;

  /**
   * When true, hides the numeric indexes next to each option.
   *
   * @default false
   */
  readonly hideIndexes?: boolean;

  /**
   * Number of visible options.
   *
   * @default 5
   */
  readonly visibleOptionCount?: number;

  /**
   * Highlight text in option labels.
   */
  readonly highlightText?: string;

  /**
   * Options.
   */
  readonly options: OptionWithDescription<T>[];

  /**
   * Default value.
   */
  readonly defaultValue?: T;

  /**
   * Callback when cancel is pressed.
   */
  readonly onCancel?: () => void;

  /**
   * Callback when selected option changes.
   */
  readonly onChange?: (value: T) => void;

  /**
   * Callback when focused option changes.
   * Note: This is for one-way notification only. Avoid combining with focusValue
   * for bidirectional sync, as this can cause feedback loops.
   */
  readonly onFocus?: (value: T) => void;

  /**
   * Initial value to focus. This is used to set focus when the component mounts.
   */
  readonly defaultFocusValue?: T;

  /**
   * Layout of the options.
   * - `compact` (default) tries to use one line per option
   * - `expanded` uses multiple lines and an empty line between options
   * - `compact-vertical` uses compact index formatting with descriptions below labels
   */
  readonly layout?: 'compact' | 'expanded' | 'compact-vertical';

  /**
   * When true, descriptions are rendered inline after the label instead of
   * in a separate column. Use this for short descriptions like hints.
   *
   * @default false
   */
  readonly inlineDescriptions?: boolean;

  /**
   * Callback when user presses up from the first item.
   * If provided, navigation will not wrap to the last item.
   */
  readonly onUpFromFirstItem?: () => void;

  /**
   * Callback when user presses down from the last item.
   * If provided, navigation will not wrap to the first item.
   */
  readonly onDownFromLastItem?: () => void;

  /**
   * Callback when input mode should be toggled for an option.
   * Called when Tab is pressed (to enter or exit input mode).
   */
  readonly onInputModeToggle?: (value: T) => void;

  /**
   * Callback to open external editor for editing input option values.
   * When provided, ctrl+g will trigger this callback in input options
   * with the current value and a setter function to update the internal state.
   */
  readonly onOpenEditor?: (currentValue: string, setValue: (value: string) => void) => void;

  /**
   * Optional callback when an image is pasted into an input option.
   */
  readonly onImagePaste?: (base64Image: string, mediaType?: string, filename?: string, dimensions?: ImageDimensions, sourcePath?: string) => void;

  /**
   * Pasted content to display inline in input options.
   */
  readonly pastedContents?: Record<number, PastedContent>;

  /**
   * Callback to remove a pasted image by its ID.
   */
  readonly onRemoveImage?: (id: number) => void;
};
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
  layout = "compact",
  disableSelection = false,
  inlineDescriptions = false,
  onUpFromFirstItem,
  onDownFromLastItem,
  onInputModeToggle,
  onOpenEditor,
  onImagePaste,
  pastedContents,
  onRemoveImage
}: any) {
  const [imagesSelected, setImagesSelected] = useState(false);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [inputValues, setInputValues] = useState(() => {
    const initialMap = new Map();
    options.forEach((option) => {
      if (option.type === "input" && option.initialValue) {
        initialMap.set(option.value, option.initialValue);
      }
    });
    return initialMap;
  });
  const t8 = new Map();
  const lastInitialValues = useRef(t8);
  useEffect(() => {
    for (const option_0 of options) {
      if (option_0.type === "input" && option_0.initialValue !== undefined) {
        const lastInitial = lastInitialValues.current.get(option_0.value) ?? "";
        const currentValue = inputValues.get(option_0.value) ?? "";
        const newInitial = option_0.initialValue;
        if (newInitial !== lastInitial && currentValue === lastInitial) {
          setInputValues((prev) => {
            const next = new Map(prev);
            next.set(option_0.value, newInitial);
            return next;
          });
        }
        lastInitialValues.current.set(option_0.value, newInitial);
      }
    }
  }, [options, inputValues]);
  const state = useSelectState({
    visibleOptionCount,
    options,
    defaultValue,
    onChange,
    onCancel,
    onFocus,
    focusValue: defaultFocusValue
  });
  useSelectInput({
    isDisabled,
    disableSelection: disableSelection || (hideIndexes ? "numeric" : false),
    state,
    options,
    isMultiSelect: false,
    onUpFromFirstItem,
    onDownFromLastItem,
    onInputModeToggle,
    inputValues,
    imagesSelected,
    onEnterImageSelection: () => {
      if (pastedContents && Object.values(pastedContents).some((c_0: any) => (c_0 as any).type === "image")) {
        const imageCount = count(Object.values(pastedContents), (c: any) => (c as any).type === "image");
        setImagesSelected(true);
        setSelectedImageIndex(imageCount - 1);
        return true;
      }
      return false;
    }
  });
  let BoxComponent;
  let containerResult;
  let mappedItems;
  let earlyReturn;
  earlyReturn = Symbol.for("react.early_return_sentinel");
  const styles = {
    container: () => ({
      flexDirection: "column" as const
    }),
    highlightedText: () => ({
      bold: true
    })
  };
  if (layout === "expanded") {
    const toStringResult = state.options.length.toString();
    const maxIndexWidth = toStringResult.length;
    earlyReturn = <Box {...styles.container()}>{state.visibleOptions.map((option_1, index) => {
        const isFirstVisibleOption = option_1.index === state.visibleFromIndex;
        const isLastVisibleOption = option_1.index === state.visibleToIndex - 1;
        const areMoreOptionsBelow = state.visibleToIndex < options.length;
        const areMoreOptionsAbove = state.visibleFromIndex > 0;
        const i = state.visibleFromIndex + index + 1;
        const isFocused = !isDisabled && state.focusedValue === option_1.value;
        const isSelected = state.value === option_1.value;
        if (option_1.type === "input") {
          const inputValue = inputValues.has(option_1.value) ? inputValues.get(option_1.value) : option_1.initialValue || "";
          return <SelectInputOption key={String(option_1.value)} option={option_1} isFocused={isFocused} isSelected={isSelected} shouldShowDownArrow={areMoreOptionsBelow && isLastVisibleOption} shouldShowUpArrow={areMoreOptionsAbove && isFirstVisibleOption} maxIndexWidth={maxIndexWidth} index={i} inputValue={inputValue} onInputChange={(value) => {
            setInputValues((prev_0) => {
              const next_0 = new Map(prev_0);
              next_0.set(option_1.value, value);
              return next_0;
            });
          }} onSubmit={(value_0) => {
            const hasImageAttachments = pastedContents && Object.values(pastedContents).some((c_1: any) => (c_1 as any).type === "image");
            if (value_0.trim() || hasImageAttachments || option_1.allowEmptySubmitToCancel) {
              onChange?.(option_1.value);
            } else {
              onCancel?.();
            }
          }} onExit={onCancel} layout="expanded" showLabel={inlineDescriptions} onOpenEditor={onOpenEditor} resetCursorOnUpdate={option_1.resetCursorOnUpdate} onImagePaste={onImagePaste} pastedContents={pastedContents} onRemoveImage={onRemoveImage} imagesSelected={imagesSelected} selectedImageIndex={selectedImageIndex} onImagesSelectedChange={setImagesSelected} onSelectedImageIndexChange={setSelectedImageIndex} />;
        }
        let label = option_1.label;
        if (typeof option_1.label === "string" && highlightText && option_1.label.includes(highlightText)) {
          const labelText = option_1.label;
          const index_0 = labelText.indexOf(highlightText);
          label = <>{labelText.slice(0, index_0)}<Text {...styles.highlightedText()}>{highlightText}</Text>{labelText.slice(index_0 + highlightText.length)}</>;
        }
        const isOptionDisabled = option_1.disabled === true;
        const optionColor = isOptionDisabled ? undefined : isSelected ? "success" : isFocused ? "suggestion" : undefined;
        return <Box key={String(option_1.value)} flexDirection="column" flexShrink={0}><SelectOption isFocused={isFocused} isSelected={isSelected} shouldShowDownArrow={areMoreOptionsBelow && isLastVisibleOption} shouldShowUpArrow={areMoreOptionsAbove && isFirstVisibleOption}><Text dimColor={isOptionDisabled} color={optionColor}>{label}</Text></SelectOption>{option_1.description && <Box paddingLeft={2}><Text dimColor={isOptionDisabled || option_1.dimDescription !== false} color={optionColor}><Ansi>{option_1.description}</Ansi></Text></Box>}<Text> </Text></Box>;
      })}</Box>;
  } else if (layout === "compact-vertical") {
    const maxIndexWidth_0 = hideIndexes ? 0 : state.options.length.toString().length;
    earlyReturn = <Box {...styles.container()}>{state.visibleOptions.map((option_2, index_1) => {
        const isFirstVisibleOption_0 = option_2.index === state.visibleFromIndex;
        const isLastVisibleOption_0 = option_2.index === state.visibleToIndex - 1;
        const areMoreOptionsBelow_0 = state.visibleToIndex < options.length;
        const areMoreOptionsAbove_0 = state.visibleFromIndex > 0;
        const i_0 = state.visibleFromIndex + index_1 + 1;
        const isFocused_0 = !isDisabled && state.focusedValue === option_2.value;
        const isSelected_0 = state.value === option_2.value;
        if (option_2.type === "input") {
          const inputValue_0 = inputValues.has(option_2.value) ? inputValues.get(option_2.value) : option_2.initialValue || "";
          return <SelectInputOption key={String(option_2.value)} option={option_2} isFocused={isFocused_0} isSelected={isSelected_0} shouldShowDownArrow={areMoreOptionsBelow_0 && isLastVisibleOption_0} shouldShowUpArrow={areMoreOptionsAbove_0 && isFirstVisibleOption_0} maxIndexWidth={maxIndexWidth_0} index={i_0} inputValue={inputValue_0} onInputChange={(value_1) => {
            setInputValues((prev_1) => {
              const next_1 = new Map(prev_1);
              next_1.set(option_2.value, value_1);
              return next_1;
            });
          }} onSubmit={(value_2) => {
            const hasImageAttachments_0 = pastedContents && Object.values(pastedContents).some((c_2: any) => (c_2 as any).type === "image");
            if (value_2.trim() || hasImageAttachments_0 || option_2.allowEmptySubmitToCancel) {
              onChange?.(option_2.value);
            } else {
              onCancel?.();
            }
          }} onExit={onCancel} layout="compact" showLabel={inlineDescriptions} onOpenEditor={onOpenEditor} resetCursorOnUpdate={option_2.resetCursorOnUpdate} onImagePaste={onImagePaste} pastedContents={pastedContents} onRemoveImage={onRemoveImage} imagesSelected={imagesSelected} selectedImageIndex={selectedImageIndex} onImagesSelectedChange={setImagesSelected} onSelectedImageIndexChange={setSelectedImageIndex} />;
        }
        let label_0 = option_2.label;
        if (typeof option_2.label === "string" && highlightText && option_2.label.includes(highlightText)) {
          const labelText_0 = option_2.label;
          const index_2 = labelText_0.indexOf(highlightText);
          label_0 = <>{labelText_0.slice(0, index_2)}<Text {...styles.highlightedText()}>{highlightText}</Text>{labelText_0.slice(index_2 + highlightText.length)}</>;
        }
        const isOptionDisabled_0 = option_2.disabled === true;
        return <Box key={String(option_2.value)} flexDirection="column" flexShrink={0}><SelectOption isFocused={isFocused_0} isSelected={isSelected_0} shouldShowDownArrow={areMoreOptionsBelow_0 && isLastVisibleOption_0} shouldShowUpArrow={areMoreOptionsAbove_0 && isFirstVisibleOption_0}><>{!hideIndexes && <Text dimColor={true}>{`${i_0}.`.padEnd(maxIndexWidth_0 + 1)}</Text>}<Text dimColor={isOptionDisabled_0} color={isOptionDisabled_0 ? undefined : isSelected_0 ? "success" : isFocused_0 ? "suggestion" : undefined}>{label_0}</Text></></SelectOption>{option_2.description && <Box paddingLeft={hideIndexes ? 4 : maxIndexWidth_0 + 4}><Text dimColor={isOptionDisabled_0 || option_2.dimDescription !== false} color={isOptionDisabled_0 ? undefined : isSelected_0 ? "success" : isFocused_0 ? "suggestion" : undefined}><Ansi>{option_2.description}</Ansi></Text></Box>}</Box>;
      })}</Box>;
  } else {
    const maxIndexWidth_1 = hideIndexes ? 0 : state.options.length.toString().length;
    const hasInputOptions = state.visibleOptions.some((opt) => opt.type === "input");
    const hasDescriptions = !inlineDescriptions && !hasInputOptions && state.visibleOptions.some((opt_0) => opt_0.description);
    const optionData = state.visibleOptions.map((option_3, index_3) => {
      const isFirstVisibleOption_1 = option_3.index === state.visibleFromIndex;
      const isLastVisibleOption_1 = option_3.index === state.visibleToIndex - 1;
      const areMoreOptionsBelow_1 = state.visibleToIndex < options.length;
      const areMoreOptionsAbove_1 = state.visibleFromIndex > 0;
      const i_1 = state.visibleFromIndex + index_3 + 1;
      const isFocused_1 = !isDisabled && state.focusedValue === option_3.value;
      const isSelected_1 = state.value === option_3.value;
      const isOptionDisabled_1 = option_3.disabled === true;
      let label_1 = option_3.label;
      if (typeof option_3.label === "string" && highlightText && option_3.label.includes(highlightText)) {
        const labelText_1 = option_3.label;
        const idx = labelText_1.indexOf(highlightText);
        label_1 = <>{labelText_1.slice(0, idx)}<Text {...styles.highlightedText()}>{highlightText}</Text>{labelText_1.slice(idx + highlightText.length)}</>;
      }
      return {
        option: option_3,
        index: i_1,
        label: label_1,
        isFocused: isFocused_1,
        isSelected: isSelected_1,
        isOptionDisabled: isOptionDisabled_1,
        shouldShowDownArrow: areMoreOptionsBelow_1 && isLastVisibleOption_1,
        shouldShowUpArrow: areMoreOptionsAbove_1 && isFirstVisibleOption_1
      };
    });
    if (hasDescriptions) {
      const maxLabelWidth = Math.max(...optionData.map((data) => {
        if (data.option.type === "input") {
          return 0;
        }
        const labelText_2 = getTextContent(data.option.label);
        const indexWidth = hideIndexes ? 0 : maxIndexWidth_1 + 2;
        const checkmarkWidth = data.isSelected ? 2 : 0;
        return 2 + indexWidth + stringWidth(labelText_2) + checkmarkWidth;
      }));
      earlyReturn = <Box {...styles.container()}>{optionData.map((data_0) => {
          if (data_0.option.type === "input") {
            return null;
          }
          const labelText_3 = getTextContent(data_0.option.label);
          const indexWidth_0 = hideIndexes ? 0 : maxIndexWidth_1 + 2;
          const checkmarkWidth_0 = data_0.isSelected ? 2 : 0;
          const currentLabelWidth = 2 + indexWidth_0 + stringWidth(labelText_3) + checkmarkWidth_0;
          const padding = maxLabelWidth - currentLabelWidth;
          return <TwoColumnRow key={String(data_0.option.value)} isFocused={data_0.isFocused}><Box flexDirection="row" flexShrink={0}>{data_0.isFocused ? <Text color="suggestion">{figures.pointer}</Text> : data_0.shouldShowDownArrow ? <Text dimColor={true}>{figures.arrowDown}</Text> : data_0.shouldShowUpArrow ? <Text dimColor={true}>{figures.arrowUp}</Text> : <Text> </Text>}<Text> </Text><Text dimColor={data_0.isOptionDisabled} color={data_0.isOptionDisabled ? undefined : data_0.isSelected ? "success" : data_0.isFocused ? "suggestion" : undefined}>{!hideIndexes && <Text dimColor={true}>{`${data_0.index}.`.padEnd(maxIndexWidth_1 + 2)}</Text>}{data_0.label}</Text>{data_0.isSelected && <Text color="success"> {figures.tick}</Text>}{padding > 0 && <Text>{" ".repeat(padding)}</Text>}</Box><Box flexGrow={1} marginLeft={2}><Text wrap="wrap" dimColor={data_0.isOptionDisabled || data_0.option.dimDescription !== false} color={data_0.isOptionDisabled ? undefined : data_0.isSelected ? "success" : data_0.isFocused ? "suggestion" : undefined}><Ansi>{data_0.option.description || " "}</Ansi></Text></Box></TwoColumnRow>;
        })}</Box>;
    } else {
      BoxComponent = Box;
      containerResult = styles.container();
      mappedItems = state.visibleOptions.map((option_4, index_4) => {
        if (option_4.type === "input") {
          const inputValue_1 = inputValues.has(option_4.value) ? inputValues.get(option_4.value) : option_4.initialValue || "";
          const isFirstVisibleOption_2 = option_4.index === state.visibleFromIndex;
          const isLastVisibleOption_2 = option_4.index === state.visibleToIndex - 1;
          const areMoreOptionsBelow_2 = state.visibleToIndex < options.length;
          const areMoreOptionsAbove_2 = state.visibleFromIndex > 0;
          const i_2 = state.visibleFromIndex + index_4 + 1;
          const isFocused_2 = !isDisabled && state.focusedValue === option_4.value;
          const isSelected_2 = state.value === option_4.value;
          return <SelectInputOption key={String(option_4.value)} option={option_4} isFocused={isFocused_2} isSelected={isSelected_2} shouldShowDownArrow={areMoreOptionsBelow_2 && isLastVisibleOption_2} shouldShowUpArrow={areMoreOptionsAbove_2 && isFirstVisibleOption_2} maxIndexWidth={maxIndexWidth_1} index={i_2} inputValue={inputValue_1} onInputChange={(value_3) => {
            setInputValues((prev_2) => {
              const next_2 = new Map(prev_2);
              next_2.set(option_4.value, value_3);
              return next_2;
            });
          }} onSubmit={(value_4) => {
            const hasImageAttachments_1 = pastedContents && Object.values(pastedContents).some((c_3: any) => (c_3 as any).type === "image");
            if (value_4.trim() || hasImageAttachments_1 || option_4.allowEmptySubmitToCancel) {
              onChange?.(option_4.value);
            } else {
              onCancel?.();
            }
          }} onExit={onCancel} layout="compact" showLabel={inlineDescriptions} onOpenEditor={onOpenEditor} resetCursorOnUpdate={option_4.resetCursorOnUpdate} onImagePaste={onImagePaste} pastedContents={pastedContents} onRemoveImage={onRemoveImage} imagesSelected={imagesSelected} selectedImageIndex={selectedImageIndex} onImagesSelectedChange={setImagesSelected} onSelectedImageIndexChange={setSelectedImageIndex} />;
        }
        let label_2 = option_4.label;
        if (typeof option_4.label === "string" && highlightText && option_4.label.includes(highlightText)) {
          const labelText_4 = option_4.label;
          const index_5 = labelText_4.indexOf(highlightText);
          label_2 = <>{labelText_4.slice(0, index_5)}<Text {...styles.highlightedText()}>{highlightText}</Text>{labelText_4.slice(index_5 + highlightText.length)}</>;
        }
        const isFirstVisibleOption_3 = option_4.index === state.visibleFromIndex;
        const isLastVisibleOption_3 = option_4.index === state.visibleToIndex - 1;
        const areMoreOptionsBelow_3 = state.visibleToIndex < options.length;
        const areMoreOptionsAbove_3 = state.visibleFromIndex > 0;
        const i_3 = state.visibleFromIndex + index_4 + 1;
        const isFocused_3 = !isDisabled && state.focusedValue === option_4.value;
        const isSelected_3 = state.value === option_4.value;
        const isOptionDisabled_2 = option_4.disabled === true;
        return <SelectOption key={String(option_4.value)} isFocused={isFocused_3} isSelected={isSelected_3} shouldShowDownArrow={areMoreOptionsBelow_3 && isLastVisibleOption_3} shouldShowUpArrow={areMoreOptionsAbove_3 && isFirstVisibleOption_3}><Box flexDirection="row" flexShrink={0}>{!hideIndexes && <Text dimColor={true}>{`${i_3}.`.padEnd(maxIndexWidth_1 + 2)}</Text>}<Text dimColor={isOptionDisabled_2} color={isOptionDisabled_2 ? undefined : isSelected_3 ? "success" : isFocused_3 ? "suggestion" : undefined}>{label_2}{inlineDescriptions && option_4.description && <Text dimColor={isOptionDisabled_2 || option_4.dimDescription !== false}>{" "}{option_4.description}</Text>}</Text></Box>{!inlineDescriptions && option_4.description && <Box flexShrink={99} marginLeft={2}><Text wrap="wrap-trim" dimColor={isOptionDisabled_2 || option_4.dimDescription !== false} color={isOptionDisabled_2 ? undefined : isSelected_3 ? "success" : isFocused_3 ? "suggestion" : undefined}><Ansi>{option_4.description}</Ansi></Text></Box>}</SelectOption>;
      });
    }
  }
  if (earlyReturn !== Symbol.for("react.early_return_sentinel")) {
    return earlyReturn;
  }
  return <BoxComponent {...containerResult}>{mappedItems}</BoxComponent>;
}

// Row container for the two-column (label + description) layout. Unlike
// the other Select layouts, this one doesn't render through SelectOption →
// ListItem, so it declares the native cursor directly. Parks the cursor
// on the pointer indicator so screen readers / magnifiers track focus.

function TwoColumnRow({
  isFocused,
  children
}: any) {
  const cursorRef = useDeclaredCursor({
    line: 0,
    column: 0,
    active: isFocused
  });
  return <Box ref={cursorRef} flexDirection="row">{children}</Box>;
}