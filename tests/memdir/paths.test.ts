import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { getAutoMemPath, isAutoMemPath } from '../../src/memdir/paths.js'

const originalOverride = process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE

afterEach(() => {
  if (originalOverride === undefined) {
    delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  } else {
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = originalOverride
  }
  getAutoMemPath.cache.clear?.()
})

describe('isAutoMemPath', () => {
  test('拒绝仅共享目录名前缀的相邻路径', () => {
    const root = join(process.cwd(), 'tmp', 'memory')
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = root
    getAutoMemPath.cache.clear?.()

    expect(isAutoMemPath(join(root, 'MEMORY.md'))).toBe(true)
    expect(isAutoMemPath(join(`${root}-evil`, 'MEMORY.md'))).toBe(false)
  })

  test('Windows 下路径大小写不影响包含关系', () => {
    if (process.platform !== 'win32') {
      return
    }
    const root = join(process.cwd(), 'tmp', 'MemoryRoot')
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = root
    getAutoMemPath.cache.clear?.()

    expect(isAutoMemPath(join(root.toUpperCase(), 'MEMORY.md'))).toBe(true)
  })
})
