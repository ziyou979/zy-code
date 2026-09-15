/**
 * 文件建议纯函数与签名单元测试
 */
import { describe, expect, test } from 'bun:test'
import {
  findLongestCommonPrefix,
  selectIndexedFiles,
  getDirectoryNames,
  pathListSignature,
} from '../../src/hooks/fileSuggestions.js'

describe('fileSuggestions', () => {
  test('findLongestCommonPrefix 应正确提取公共前缀', () => {
    const suggestions = [
      { id: '1', displayText: 'src/utils/file.ts' },
      { id: '2', displayText: 'src/utils/path.ts' },
    ]
    expect(findLongestCommonPrefix(suggestions)).toBe('src/utils/')
  })

  test('pathListSignature 对不同列表能生成不同签名', () => {
    const list1 = ['src/a.ts', 'src/b.ts']
    const list2 = ['src/a.ts', 'src/c.ts']
    const sig1 = pathListSignature(list1)
    const sig2 = pathListSignature(list2)
    expect(sig1).not.toBe(sig2)
  })

  test('getDirectoryNames 应正确提取唯一父目录', () => {
    const files = ['src/index.ts', 'src/utils/math.ts']
    const dirs = getDirectoryNames(files)
    expect(dirs).toContain(`src${require('node:path').sep}`)
  })
})

test('初次构建与后台合并均限制文件数且优先保留配置文件', () => {
  const tracked = Array.from({ length: 60000 }, (_, i) => `src/${i}.ts`)
  const config = ['.zy/config.md']
  const initial = selectIndexedFiles(config, tracked)
  const merged = selectIndexedFiles(config, tracked, ['new.ts'])
  expect(initial).toHaveLength(50000)
  expect(merged).toEqual(initial)
  expect(merged[0]).toBe(config[0])
  expect(selectIndexedFiles(['a'], ['a', 'b'])).toEqual(['a', 'b'])
})
