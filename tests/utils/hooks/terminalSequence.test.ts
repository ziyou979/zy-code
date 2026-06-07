/**
 * 4.5 terminalSequence 白名单校验。
 *
 * 放行：BEL、OSC 0（标题）、OSC 9（通知/进度 9;4）。拒绝：CSI（光标/清屏/SGR）、
 * 其他 OSC（如 8 超链接）、裸文本、含任何非白名单片段的混合串。
 */
import { describe, expect, test } from 'bun:test'
import { validateTerminalSequence } from '../../../src/services/hooks/terminalSequence.js'

const BEL = '\x07'
const ESC = '\x1b'
const ST = '\x1b\\'

describe('4.5 validateTerminalSequence', () => {
  test('放行：BEL 响铃', () => {
    expect(validateTerminalSequence(BEL)).toBe(BEL)
  })

  test('放行：OSC 9 桌面通知（BEL 结尾）', () => {
    const seq = `${ESC}]9;Build finished${BEL}`
    expect(validateTerminalSequence(seq)).toBe(seq)
  })

  test('放行：OSC 0 窗口标题', () => {
    const seq = `${ESC}]0;my project${BEL}`
    expect(validateTerminalSequence(seq)).toBe(seq)
  })

  test('放行：OSC 9;4 进度条', () => {
    const seq = `${ESC}]9;4;50${BEL}`
    expect(validateTerminalSequence(seq)).toBe(seq)
  })

  test('放行：ST 结尾的 OSC', () => {
    const seq = `${ESC}]9;hi${ST}`
    expect(validateTerminalSequence(seq)).toBe(seq)
  })

  test('放行：多个允许 token 拼接', () => {
    const seq = `${ESC}]0;title${BEL}${BEL}`
    expect(validateTerminalSequence(seq)).toBe(seq)
  })

  test('拒绝：CSI 清屏', () => {
    expect(validateTerminalSequence(`${ESC}[2J`)).toBeUndefined()
  })

  test('拒绝：CSI 光标移动', () => {
    expect(validateTerminalSequence(`${ESC}[1;1H`)).toBeUndefined()
  })

  test('拒绝：OSC 8 超链接（非 0/9）', () => {
    expect(validateTerminalSequence(`${ESC}]8;;http://x${BEL}`)).toBeUndefined()
  })

  test('拒绝：裸文本', () => {
    expect(validateTerminalSequence('hello')).toBeUndefined()
  })

  test('拒绝：允许序列后夹带 CSI', () => {
    expect(validateTerminalSequence(`${ESC}]9;hi${BEL}${ESC}[2J`)).toBeUndefined()
  })

  test('拒绝：OSC 文本里夹带 ESC（无法走私 CSI）', () => {
    expect(validateTerminalSequence(`${ESC}]9;${ESC}[2J${BEL}`)).toBeUndefined()
  })

  test('空 / undefined → undefined', () => {
    expect(validateTerminalSequence('')).toBeUndefined()
    expect(validateTerminalSequence(undefined)).toBeUndefined()
  })
})
