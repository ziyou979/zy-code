import { afterEach, describe, expect, test } from 'bun:test'
import {
  isDecstbmFastPathSupported,
  isSynchronizedOutputSupported,
} from '../../src/ink/terminal.js'

const originalTerminalEmulator = process.env.TERMINAL_EMULATOR
const originalTmux = process.env.TMUX
const originalTermProgram = process.env.TERM_PROGRAM

afterEach(() => {
  if (originalTerminalEmulator === undefined) {
    delete process.env.TERMINAL_EMULATOR
  } else {
    process.env.TERMINAL_EMULATOR = originalTerminalEmulator
  }

  if (originalTmux === undefined) {
    delete process.env.TMUX
  } else {
    process.env.TMUX = originalTmux
  }

  if (originalTermProgram === undefined) {
    delete process.env.TERM_PROGRAM
  } else {
    process.env.TERM_PROGRAM = originalTermProgram
  }
})

describe('终端同步输出能力', () => {
  test('JetBrains JediTerm 启用 DEC 2026 原子帧', () => {
    delete process.env.TMUX
    process.env.TERMINAL_EMULATOR = 'JetBrains-JediTerm'

    expect(isSynchronizedOutputSupported()).toBe(true)
    expect(isDecstbmFastPathSupported()).toBe(false)
  })

  test('tmux 仍优先禁用 DEC 2026', () => {
    process.env.TMUX = '/tmp/tmux-1000/default,1,0'
    process.env.TERMINAL_EMULATOR = 'JetBrains-JediTerm'

    expect(isSynchronizedOutputSupported()).toBe(false)
    expect(isDecstbmFastPathSupported()).toBe(false)
  })

  test('支持同步输出的 xterm.js 可以启用 DECSTBM 快速路径', () => {
    delete process.env.TMUX
    delete process.env.TERMINAL_EMULATOR
    process.env.TERM_PROGRAM = 'vscode'

    expect(isDecstbmFastPathSupported()).toBe(true)
  })
})
