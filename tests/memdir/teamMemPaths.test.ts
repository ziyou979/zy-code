import { afterEach, describe, expect, mock, test } from 'bun:test'
import { lstat as lstatCallback, realpath as realpathCallback } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const realLstat = promisify(lstatCallback)
const realRealpath = promisify(realpathCallback)
const deniedMarker = 'permission-denied-memory'

mock.module('node:fs/promises', () => ({
  lstat: async (path: string) => {
    if (path.includes(deniedMarker)) {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    }
    return realLstat(path)
  },
  realpath: async (path: string) => {
    if (path.includes(deniedMarker)) {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    }
    return realRealpath(path)
  },
}))

const { getAutoMemPath } = await import('../../src/memdir/paths.js')
const { isTeamMemPath, PathTraversalError, validateTeamMemWritePath } = await import(
  '../../src/memdir/teamMemPaths.js'
)

const originalOverride = process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE

afterEach(() => {
  if (originalOverride === undefined) {
    delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  } else {
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = originalOverride
  }
  getAutoMemPath.cache.clear?.()
})

describe('teamMemPaths', () => {
  test('拒绝 team 目录的前缀碰撞路径', () => {
    const memoryRoot = join(process.cwd(), 'tmp', 'memory')
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = memoryRoot
    getAutoMemPath.cache.clear?.()

    expect(isTeamMemPath(join(memoryRoot, 'team', 'MEMORY.md'))).toBe(true)
    expect(isTeamMemPath(join(memoryRoot, 'team-evil', 'MEMORY.md'))).toBe(false)
  })

  test('Windows 下 team 路径大小写不影响包含关系', () => {
    if (process.platform !== 'win32') {
      return
    }
    const memoryRoot = join(process.cwd(), 'tmp', 'TeamMemory')
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = memoryRoot
    getAutoMemPath.cache.clear?.()

    expect(isTeamMemPath(join(memoryRoot.toUpperCase(), 'TEAM', 'MEMORY.md'))).toBe(true)
  })

  test('无法访问最深现有路径时关闭失败', async () => {
    const memoryRoot = join(process.cwd(), 'tmp', deniedMarker)
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = memoryRoot
    getAutoMemPath.cache.clear?.()

    await expect(
      validateTeamMemWritePath(join(memoryRoot, 'team', 'MEMORY.md')),
    ).rejects.toBeInstanceOf(PathTraversalError)
  })
})
