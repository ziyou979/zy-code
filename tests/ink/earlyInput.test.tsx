import { describe, expect, test } from 'bun:test'
import { Readable, Writable } from 'node:stream'
import React from 'react'
import Text from '../../src/ink/components/Text.js'
import useInput from '../../src/ink/hooks/useInput.js'
import Ink from '../../src/ink/ink.js'
import { parseMultipleKeypresses } from '../../src/ink/parseKeypress.js'
import {
  consumeEarlyInput,
  handoffEarlyInput,
  isCapturingEarlyInput,
  seedEarlyInput,
  startCapturingEarlyInput,
  stopCapturingEarlyInput,
} from '../../src/ink/earlyInput.js'

class TtyInput extends Readable {
  isTTY = true
  isRaw = false
  rawChanges: boolean[] = []

  override _read(): void {}
  setRawMode(value: boolean): this {
    this.rawChanges.push(value)
    this.isRaw = value
    return this
  }
  ref(): this {
    return this
  }
  unref(): this {
    return this
  }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

async function withStdin(run: (stdin: TtyInput) => Promise<void>): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'stdin')!
  const stdin = new TtyInput()
  Object.defineProperty(process, 'stdin', { configurable: true, value: stdin })
  try {
    seedEarlyInput('')
    await run(stdin)
  } finally {
    stopCapturingEarlyInput()
    seedEarlyInput('')
    Object.defineProperty(process, 'stdin', descriptor)
    stdin.destroy()
  }
}

describe('earlyInput', () => {
  test('使用暂停读取模式，消费文本时保持 raw 模式，移交后仍可读取', () =>
    withStdin(async (stdin) => {
      startCapturingEarlyInput()
      startCapturingEarlyInput()
      expect(stdin.listenerCount('data')).toBe(0)
      expect(stdin.listenerCount('readable')).toBe(1)
      stdin.push('启动文本')
      await tick()
      expect(consumeEarlyInput()).toBe('启动文本')
      expect(stdin.rawChanges).toEqual([true])
      expect(isCapturingEarlyInput()).toBe(true)
      handoffEarlyInput(stdin as unknown as NodeJS.ReadStream)
      expect(stdin.listenerCount('readable')).toBe(0)
      stdin.push('后续输入')
      expect(stdin.read()).toBe('后续输入')
      expect(consumeEarlyInput()).toBe('')
    }))

  test('非交互停止恢复原始终端模式', () =>
    withStdin(async (stdin) => {
      startCapturingEarlyInput()
      stopCapturingEarlyInput()
      expect(stdin.rawChanges).toEqual([true, false])
      stdin.isRaw = true
      stdin.rawChanges = []
      startCapturingEarlyInput()
      stopCapturingEarlyInput()
      expect(stdin.rawChanges).toEqual([true])
    }))

  test('过滤分块终端响应和方向键，同时保留同块文本和粘贴', () =>
    withStdin(async (stdin) => {
      startCapturingEarlyInput()
      for (const chunk of [
        'hello\x1b[?',
        '1;2c世界\x1b[A\x1b]10;rgb:ffff/ffff/ffff',
        '\x1b\\!\x1bP>|terminal\x1b\\\x1b[I',
        '\x1b[200~多行\n粘贴\x1b[201~\x03',
      ]) {
        stdin.push(chunk)
        await tick()
      }
      expect(consumeEarlyInput()).toBe('hello世界!多行\n粘贴')
    }))

  test('未完成响应跨交接边界继续解析，不向 Ink 泄漏响应尾部', () =>
    withStdin(async (stdin) => {
      startCapturingEarlyInput()
      stdin.push('hello\x1b[?')
      await tick()
      expect(consumeEarlyInput()).toBe('hello')
      const state = handoffEarlyInput(stdin as unknown as NodeJS.ReadStream)
      expect(state).toBeDefined()
      const [items] = parseMultipleKeypresses(state!, '1;2cworld')
      expect(items.map((item) => item.kind)).toEqual(['response', 'key'])
      expect(items[1]?.sequence).toBe('world')
    }))

  test('UTF-8 字节在移交前后分块时仍由同一流解码', () =>
    withStdin(async (stdin) => {
      startCapturingEarlyInput()
      const bytes = Buffer.from('中')
      stdin.push(bytes.subarray(0, 1))
      await tick()
      expect(consumeEarlyInput()).toBe('')
      handoffEarlyInput(stdin as unknown as NodeJS.ReadStream)
      stdin.push(bytes.subarray(1))
      expect(stdin.read()).toBe('中')
    }))

  test('Ink 挂载后补读交接窗口中的输入，并可继续接收新按键', () =>
    withStdin(async (stdin) => {
      startCapturingEarlyInput()
      stdin.push('early')
      await tick()
      expect(consumeEarlyInput()).toBe('early')
      handoffEarlyInput(stdin as unknown as NodeJS.ReadStream)
      stdin.push('pending')
      // 模拟 readable 通知已被消耗，仅留下内部缓冲，不能等待下一次事件。
      await tick()
      const emit = stdin.emit.bind(stdin)
      stdin.emit = (event: string | symbol, ...args: unknown[]) =>
        event === 'readable' ? false : emit(event, ...args)
      const received: string[] = []
      function Target() {
        useInput((input) => received.push(input))
        return <Text>input</Text>
      }
      const stdout = new Writable({
        write(_chunk, _encoding, callback) {
          callback()
        },
      }) as unknown as NodeJS.WriteStream
      stdout.columns = 80
      stdout.rows = 24
      stdout.isTTY = true
      const ink = new Ink({
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout,
        stderr: stdout,
        exitOnCtrlC: false,
        patchConsole: false,
      })
      try {
        ink.render(<Target />)
        await tick()
        await tick()
        expect(received.join('')).toBe('pending')
        expect(stdin.rawChanges).not.toContain(false)
        stdin.emit = emit
        stdin.push('next')
        await tick()
        expect(received.join('')).toBe('pendingnext')
      } finally {
        ink.unmount()
      }
      expect(stdin.isRaw).toBe(false)
    }))

  test('消费文本不放弃终端所有权，未移交时停止仍恢复 raw 模式', () =>
    withStdin(async (stdin) => {
      startCapturingEarlyInput()
      consumeEarlyInput()
      stopCapturingEarlyInput()
      stopCapturingEarlyInput()
      expect(stdin.rawChanges).toEqual([true, false])
      expect(isCapturingEarlyInput()).toBe(false)
    }))

  test('其他输入流不能移交当前终端的捕获状态', () =>
    withStdin(async (stdin) => {
      startCapturingEarlyInput()
      const other = new TtyInput()
      expect(handoffEarlyInput(other as unknown as NodeJS.ReadStream)).toBeUndefined()
      expect(isCapturingEarlyInput()).toBe(true)
      expect(stdin.isRaw).toBe(true)
      other.destroy()
    }))
})
