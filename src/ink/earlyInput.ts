import { INITIAL_STATE, type KeyParseState, parseMultipleKeypresses } from './parseKeypress.js'
import { lastGrapheme } from '../utils/intl.js'

let earlyInputBuffer = ''
let isCapturing = false
let wasRaw = false
let stdinHandle: typeof process.stdin | null = null
let keyParseState: KeyParseState = INITIAL_STATE

function onStdinReadable(): void {
  if (!isCapturing || !stdinHandle) {
    return
  }
  let chunk: Buffer | string | null
  while ((chunk = stdinHandle.read()) !== null) {
    // 复用 Ink 的流式解析器，避免分块响应的尾部或终端控制序列混入提示词。
    const [items, nextState] = parseMultipleKeypresses(keyParseState, chunk)
    keyParseState = nextState
    for (const item of items) {
      if (item.kind === 'key' && (item.isPasted || !item.sequence?.includes('\x1b'))) {
        earlyInputBuffer += (item.sequence ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      }
    }
  }
}

export function startCapturingEarlyInput(): void {
  if (isCapturing) {
    return
  }
  isCapturing = true
  keyParseState = { ...INITIAL_STATE }
  stdinHandle = process.stdin
  if (stdinHandle && stdinHandle.isTTY) {
    wasRaw = stdinHandle.isRaw
    try {
      stdinHandle.setRawMode(true)
    } catch {
      // 不是 TTY
    }
    // 与 Ink 使用同一流解码器，UTF-8 字节跨交接分块时也不会被截断。
    stdinHandle.setEncoding('utf8')
    stdinHandle.on('readable', onStdinReadable)
    onStdinReadable()
  }
}

export function consumeEarlyInput(): string {
  const result = earlyInputBuffer
  earlyInputBuffer = ''
  return result
}

export function stopCapturingEarlyInput(): void {
  isCapturing = false
  cleanupStdin(false)
  keyParseState = INITIAL_STATE
}

export function handoffEarlyInput(stdin: NodeJS.ReadStream): KeyParseState | undefined {
  // 自定义输入流不能接管另一个终端的捕获器，也不能取走其解析状态。
  if (stdin !== stdinHandle) {
    return undefined
  }
  isCapturing = false
  cleanupStdin(true)
  // 将跨交接边界的不完整响应/粘贴一并移交，防止尾部泄漏为普通按键。
  const state = keyParseState
  keyParseState = INITIAL_STATE
  return state === INITIAL_STATE ? undefined : state
}

function cleanupStdin(preserveRawMode: boolean): void {
  if (stdinHandle) {
    stdinHandle.removeListener('readable', onStdinReadable)
    if (!preserveRawMode && !wasRaw) {
      try {
        stdinHandle.setRawMode(false)
      } catch {
        // 忽略读取错误
      }
    }
    stdinHandle = null
  }
}

export function getBufferedEarlyInputLength(): number {
  return earlyInputBuffer.length
}

export function hasBufferedEarlyInput(): boolean {
  return earlyInputBuffer.length > 0
}

export function getLastGraphemeFromBuffer(): string | undefined {
  if (earlyInputBuffer.length === 0) {
    return undefined
  }
  return lastGrapheme(earlyInputBuffer)
}

export function hasEarlyInput(): boolean {
  return earlyInputBuffer.trim().length > 0
}

export function seedEarlyInput(text: string): void {
  earlyInputBuffer = text
}

export function isCapturingEarlyInput(): boolean {
  return isCapturing
}
