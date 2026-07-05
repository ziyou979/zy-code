import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  getClipboardPath,
  PS_SET_CLIPBOARD_UTF8_CMD,
  tmuxLoadBuffer,
} from '../../../src/ink/termio/osc.js'

describe('osc clipboard', () => {
  const ORIG_ENV = process.env

  beforeEach(() => {
    process.env = { ...ORIG_ENV }
  })

  afterAll(() => {
    process.env = ORIG_ENV
  })

  test('PS_SET_CLIPBOARD_UTF8_CMD 应设置 InputEncoding 为 UTF-8 并调用 Set-Clipboard', () => {
    expect(PS_SET_CLIPBOARD_UTF8_CMD).toBe(
      '[Console]::InputEncoding = [Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())',
    )
  })

  test('getClipboardPath 无 SSH/TMUX 时非 macOS 应返回 osc52', () => {
    delete process.env.SSH_CONNECTION
    delete process.env.TMUX
    // macOS 以外平台：nativeAvailable = false
    const path = getClipboardPath()
    expect(path).toBe('osc52')
  })

  test('getClipboardPath 有 TMUX 时应返回 tmux-buffer', () => {
    delete process.env.SSH_CONNECTION
    process.env.TMUX = '/tmp/tmux-xxx/default'
    const path = getClipboardPath()
    expect(path).toBe('tmux-buffer')
  })

  test('tmuxLoadBuffer 无 TMUX 环境变量时应返回 false', async () => {
    delete process.env.TMUX
    const result = await tmuxLoadBuffer('test text')
    expect(result).toBe(false)
  })
})
