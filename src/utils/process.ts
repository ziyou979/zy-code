function handleEPIPE(stream: NodeJS.WriteStream): (err: NodeJS.ErrnoException) => void {
  return (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      stream.destroy()
    }
  }
}

// 防止管道断开时的内存泄漏（例如 `zy -p | head -1`）
export function registerProcessOutputErrorHandlers(): void {
  process.stdout.on('error', handleEPIPE(process.stdout))
  process.stderr.on('error', handleEPIPE(process.stderr))
}

function writeOut(stream: NodeJS.WriteStream, data: string): void {
  if (stream.destroyed) {
    return
  }

  // 注意：这里没有处理背压（write() 返回 false 的情况）。
  //
  // 应该考虑处理回调以确保等待数据刷新完成。
  stream.write(data /* 此处应处理回调 */)
}

export function writeToStdout(data: string): void {
  writeOut(process.stdout, data)
}

export function writeToStderr(data: string): void {
  writeOut(process.stderr, data)
}

// 将错误写入 stderr 并以退出码 1 退出。整合了入口快速路径中
// console.error + process.exit(1) 的使用模式。
export function exitWithError(message: string): never {
  // biome-ignore lint/suspicious/noConsole:: 有意的控制台输出
  console.error(message)
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(1)
}

// 等待类似 stdin 的流关闭，但如果在 ms 毫秒内没有收到任何数据则放弃。
// 第一个数据块会取消超时——之后将无条件等待流结束
//（调用方的累加器需要所有数据块，而非仅第一个）。
// 超时返回 true，流结束返回 false。用于 -p 模式区分
// 真正的管道生产者和继承但空闲的父级 stdin。
export function peekForStdinData(stream: NodeJS.EventEmitter, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const done = (timedOut: boolean) => {
      clearTimeout(peek)
      stream.off('end', onEnd)
      stream.off('data', onFirstData)
      void resolve(timedOut)
    }
    let onEnd
    onEnd = () => done(false)
    let onFirstData
    onFirstData = () => clearTimeout(peek)
    // eslint-disable-next-line no-restricted-syntax -- 不是 sleep：将超时与流的 end/data 事件进行竞争
    let peek
    peek = setTimeout(done, ms, true)
    stream.once('end', onEnd)
    stream.once('data', onFirstData)
  })
}
