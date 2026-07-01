/**
 * SelectMulti 鼠标点击测试
 *
 * 测试多选组件的鼠标点击逻辑
 */
import { describe, expect, test, mock } from 'bun:test'
import { handleOptionClick } from '../../../src/components/CustomSelect/select-mouse-actions.js'
import type { OptionWithDescription } from '../../../src/components/CustomSelect/select.js'

describe('SelectMulti 鼠标点击', () => {
  test('点击未选中选项应聚焦并 toggle', () => {
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

  test('点击 disabled 选项不应触发任何操作', () => {
    const focusOption = mock()
    const onToggle = mock()

    const option: OptionWithDescription<string> = {
      label: 'Option 1',
      value: '1',
      disabled: true,
    }

    handleOptionClick(option, {
      focusOption,
      onToggle,
      isMultiSelect: true,
    })

    expect(focusOption).not.toHaveBeenCalled()
    expect(onToggle).not.toHaveBeenCalled()
  })

  test('点击 input 选项应只聚焦，不 toggle', () => {
    const focusOption = mock()
    const onToggle = mock()

    const option: OptionWithDescription<string> = {
      label: 'Input Option',
      value: 'input-1',
      type: 'input',
      onChange: mock(),
    }

    handleOptionClick(option, {
      focusOption,
      onToggle,
      isMultiSelect: true,
    })

    expect(focusOption).toHaveBeenCalledWith('input-1')
    expect(onToggle).not.toHaveBeenCalled()
  })
})
