import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isFileWithinReadSizeLimit } from '../../../src/services/infra/file.js'

describe('isFileWithinReadSizeLimit', () => {
  test('异步检查大小边界和不存在文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zy-size-check-'))
    const file = join(dir, 'sample.txt')
    try {
      await writeFile(file, '1234')
      const pending = isFileWithinReadSizeLimit(file, 4)
      expect(pending).toBeInstanceOf(Promise)
      expect(await pending).toBe(true)
      expect(await isFileWithinReadSizeLimit(file, 3)).toBe(false)
      expect(await isFileWithinReadSizeLimit(join(dir, 'missing'), 4)).toBe(false)
    } finally {
      await unlink(file).catch(() => {})
      await rmdir(dir)
    }
  })
})
