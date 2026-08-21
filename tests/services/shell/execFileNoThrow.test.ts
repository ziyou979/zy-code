import { describe, expect, test } from 'bun:test'
import { execFileNoThrowWithCwd } from '../../../src/services/shell/execFileNoThrow.js'

describe('execFileNoThrowWithCwd', () => {
  test('应通过 Execa 的 cancelSignal 传递取消信号', async () => {
    const controller = new AbortController()
    const execution = execFileNoThrowWithCwd(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 10_000)'],
      {
        abortSignal: controller.signal,
      },
    )

    // 先启动一个不会立即退出的跨平台 Bun 子进程，再触发取消，避免与正常退出竞争。
    controller.abort()
    const result = await execution

    expect(result.code).not.toBe(0)
    expect(result.error).toBeDefined()
  })
})
