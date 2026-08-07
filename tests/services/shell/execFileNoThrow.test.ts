import { describe, expect, test } from 'bun:test'
import { execFileNoThrowWithCwd } from '../../../src/services/shell/execFileNoThrow.js'

describe('execFileNoThrowWithCwd', () => {
  test('应通过 Execa 的 cancelSignal 传递取消信号', async () => {
    const result = await execFileNoThrowWithCwd(process.execPath, ['--version'], {
      abortSignal: AbortSignal.abort(),
    })

    expect(result.code).not.toBe(0)
  })
})
