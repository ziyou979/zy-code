/**
 * Select 鼠标点击测试
 *
 * 测试 select-mouse-actions.ts 中的点击激活逻辑
 */
import { describe, expect, test, mock } from 'bun:test'
import {
  handleOptionClick,
  createOptionClickHandler,
  createOptionHoverHandler,
  createHoverLeaveHandler,
  createMultiOptionClickHandler,
} from '../../../src/components/CustomSelect/select-mouse-actions.js'
import type { OptionWithDescription } from '../../../src/components/CustomSelect/select.js'

describe('handleOptionClick', () => {
  test('点击普通选项应聚焦并选择', () => {
    const focusOption = mock()
    const selectFocusedOption = mock()
    const onChange = mock()

    const option: OptionWithDescription<string> = {
      label: 'Option 1',
      value: '1',
    }

    handleOptionClick(option, {
      focusOption,
      selectFocusedOption,
      onChange,
    })

    expect(focusOption).toHaveBeenCalledWith('1')
    expect(selectFocusedOption).toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledWith('1')
  })

  test('点击 disabled 选项不应触发任何操作', () => {
    const focusOption = mock()
    const selectFocusedOption = mock()
    const onChange = mock()

    const option: OptionWithDescription<string> = {
      label: 'Option 1',
      value: '1',
      disabled: true,
    }

    handleOptionClick(option, {
      focusOption,
      selectFocusedOption,
      onChange,
    })

    expect(focusOption).not.toHaveBeenCalled()
    expect(selectFocusedOption).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })

  test('点击空 input 选项应只聚焦，不提交', () => {
    const focusOption = mock()
    const selectFocusedOption = mock()
    const onChange = mock()

    const option: OptionWithDescription<string> = {
      label: 'Input Option',
      value: 'input-1',
      type: 'input',
      onChange: mock(),
    }

    handleOptionClick(option, {
      focusOption,
      selectFocusedOption,
      onChange,
    })

    expect(focusOption).toHaveBeenCalledWith('input-1')
    expect(selectFocusedOption).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })

  test('点击有预填值的 input 选项应直接提交', () => {
    const focusOption = mock()
    const selectFocusedOption = mock()
    const onChange = mock()

    const option: OptionWithDescription<string> = {
      label: 'Input Option',
      value: 'input-1',
      type: 'input',
      initialValue: 'node:*',
      onChange: mock(),
    }

    handleOptionClick(option, {
      focusOption,
      selectFocusedOption,
      onChange,
      inputValue: 'node:*',
    })

    expect(focusOption).not.toHaveBeenCalled()
    expect(selectFocusedOption).not.toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledWith('input-1')
  })

  test('点击允许空提交的 input 选项应直接提交', () => {
    const focusOption = mock()
    const selectFocusedOption = mock()
    const onChange = mock()

    const option: OptionWithDescription<string> = {
      label: 'Input Option',
      value: 'input-1',
      type: 'input',
      onChange: mock(),
      allowEmptySubmitToCancel: true,
    }

    handleOptionClick(option, {
      focusOption,
      selectFocusedOption,
      onChange,
      inputValue: '',
    })

    expect(focusOption).not.toHaveBeenCalled()
    expect(selectFocusedOption).not.toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledWith('input-1')
  })

  test('多选模式下点击选项应聚焦并 toggle', () => {
    const focusOption = mock()
    const onToggle = mock()

    const option: OptionWithDescription<string> = {
      label: 'Option 1',
      value: '1',
    }

    handleOptionClick(option, {
      focusOption,
      onToggle,
      isMultiSelect: true,
    })

    expect(focusOption).toHaveBeenCalledWith('1')
    expect(onToggle).toHaveBeenCalledWith('1')
  })
})

describe('createOptionClickHandler', () => {
  test('返回的处理器应调用 handleOptionClick', () => {
    const focusOption = mock()
    const selectFocusedOption = mock()
    const onChange = mock()

    const option: OptionWithDescription<string> = {
      label: 'Option 1',
      value: '1',
    }

    const handler = createOptionClickHandler(option, focusOption, selectFocusedOption, onChange)

    // 模拟 ClickEvent
    const mockEvent = {} as any
    handler(mockEvent)

    expect(focusOption).toHaveBeenCalledWith('1')
    expect(selectFocusedOption).toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledWith('1')
  })
})

describe('createMultiOptionClickHandler', () => {
  test('返回的处理器应调用 handleOptionClick 并设置 isMultiSelect', () => {
    const focusOption = mock()
    const onToggle = mock()

    const option: OptionWithDescription<string> = {
      label: 'Option 1',
      value: '1',
    }

    const handler = createMultiOptionClickHandler(option, focusOption, onToggle)

    // 模拟 ClickEvent
    const mockEvent = {} as any
    handler(mockEvent)

    expect(focusOption).toHaveBeenCalledWith('1')
    expect(onToggle).toHaveBeenCalledWith('1')
  })
})

describe('createOptionHoverHandler', () => {
  test('悬浮普通选项应更新 hoveredId', () => {
    const setHoveredId = mock()

    const option: OptionWithDescription<string> = {
      label: 'Option 1',
      value: '1',
    }

    const handler = createOptionHoverHandler(option, setHoveredId)
    handler()

    expect(setHoveredId).toHaveBeenCalledWith('1')
  })

  test('悬浮 disabled 选项不应更新 hoveredId', () => {
    const setHoveredId = mock()

    const option: OptionWithDescription<string> = {
      label: 'Option 1',
      value: '1',
      disabled: true,
    }

    const handler = createOptionHoverHandler(option, setHoveredId)
    handler()

    expect(setHoveredId).not.toHaveBeenCalled()
  })
})

describe('createHoverLeaveHandler', () => {
  test('鼠标离开应清除 hoveredId', () => {
    const setHoveredId = mock()

    const handler = createHoverLeaveHandler(setHoveredId)
    handler()

    expect(setHoveredId).toHaveBeenCalledWith(null)
  })
})
