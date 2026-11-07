import { Readable, Writable } from 'node:stream'

export class TtyInput extends Readable {
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

export function createTerminalStreams() {
  const input = new TtyInput()
  const writes: string[] = []
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(String(chunk))
      callback()
    },
  }) as unknown as NodeJS.WriteStream
  stdout.columns = 80
  stdout.rows = 24
  // 测试输出不是真实终端，避免 Ink 的进程退出清理写入宿主控制台。
  stdout.isTTY = false
  return { input, stdin: input as unknown as NodeJS.ReadStream, stdout, writes }
}
