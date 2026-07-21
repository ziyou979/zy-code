import { lastGrapheme } from '../../utils/intl.js'

let earlyInputBuffer = ''
let isCapturing = false
let wasRaw = false
let stdinHandle: typeof process.stdin | null = null

function onStdinData(data: Buffer): void {
  if (isCapturing) {
    earlyInputBuffer += data.toString('utf-8')
  }
}

export function startCapturingEarlyInput(): void {
  if (isCapturing) {
    return
  }
  isCapturing = true
  stdinHandle = process.stdin
  if (stdinHandle && stdinHandle.isTTY) {
    wasRaw = stdinHandle.isRaw
    try {
      stdinHandle.setRawMode(true)
    } catch {
      // Not a TTY
    }
    stdinHandle.on('data', onStdinData)
  }
}

export function consumeEarlyInput(): string {
  isCapturing = false
  const result = earlyInputBuffer
  earlyInputBuffer = ''
  cleanupStdin()
  return result
}

export function stopCapturingEarlyInput(): void {
  isCapturing = false
  cleanupStdin()
}

function cleanupStdin(): void {
  if (stdinHandle) {
    stdinHandle.removeListener('data', onStdinData)
    if (!wasRaw) {
      try {
        stdinHandle.setRawMode(false)
      } catch {
        // ignore
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
