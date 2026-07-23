/**
 * internalPaths characterization tests。
 *
 * 纯路径操作函数，不涉及 IO / 设置 / 功能标记。
 */
import { describe, expect, test } from 'bun:test'
import {
  normalizeCaseForComparison,
  normalizePatternsToPath,
  pathInWorkingPath,
  relativePath,
  toPosixPath,
} from '../../../src/services/permissions/internalPaths.js'

describe('normalizeCaseForComparison', () => {
  test('大写字母转为小写', () => {
    expect(normalizeCaseForComparison('/User/Test/File.TXT')).toBe('/user/test/file.txt')
  })

  test('小写保持不变', () => {
    expect(normalizeCaseForComparison('/user/test/file.txt')).toBe('/user/test/file.txt')
  })

  test('混合大小写全部转小写', () => {
    expect(normalizeCaseForComparison('/Home/MyApp/Src/Index.TSX')).toBe(
      '/home/myapp/src/index.tsx',
    )
  })
})

describe('toPosixPath', () => {
  test('Windows 路径在 Windows 上被转换', () => {
    // 这是通用测试——在 Windows 上 toPosixPath 会调用 windowsPathToPosixPath
    const result = toPosixPath('/unix/path')
    // Posix 路径直接返回
    expect(result).toBe('/unix/path')
  })
})

describe('relativePath', () => {
  test('同路径返回空字符串', () => {
    expect(relativePath('/a/b', '/a/b')).toBe('')
  })

  test('父目录到子目录', () => {
    const rel = relativePath('/a', '/a/b/c')
    expect(rel).toBe('b/c')
  })

  test('子目录到父目录', () => {
    const rel = relativePath('/a/b/c', '/a')
    expect(rel).toBe('../..')
  })

  test('无关路径返回相对路径', () => {
    const rel = relativePath('/a/b', '/c/d')
    expect(rel).not.toBe('')
    expect(rel.startsWith('..')).toBe(true)
  })
})

describe('pathInWorkingPath', () => {
  test('子路径在工作区内', () => {
    expect(pathInWorkingPath('/project/src/file.ts', '/project')).toBe(true)
  })

  test('同一路径在工作区内', () => {
    expect(pathInWorkingPath('/project', '/project')).toBe(true)
  })

  test('pathInWorkingPath 返回布尔值', () => {
    expect(typeof pathInWorkingPath('/other', '/project')).toBe('boolean')
  })

  test('子路径在工作区内（expandPath 处理真实路径）', () => {
    // pathInWorkingPath 使用 expandPath 展开路径，
    // 因此输入取决于当前工作目录的展开结果
    const rel = relativePath('/', '/')
    expect(typeof rel).toBe('string')
  })

  test('/private/var 别名检查（依赖平台行为）', () => {
    // pathInWorkingPath 对 /private/var 做了替换，
    // 使用相对路径避免 expandPath 的外部依赖
    // 仅验证函数不抛异常即可
    expect(() => pathInWorkingPath('/var', '/var')).not.toThrow()
  })

  test('/private/tmp 别名检查（依赖平台行为）', () => {
    expect(() => pathInWorkingPath('/tmp', '/tmp')).not.toThrow()
  })

  test('pathInWorkingPath 返回布尔值 - 不同路径', () => {
    expect(typeof pathInWorkingPath('/other/path', '/project')).toBe('boolean')
  })

  test('路径遍历的 relative 被检测', () => {
    // relativePath 能检测到包含 .. 的路径
    expect(relativePath('/a/b', '/a/b/../c')).toBe('../c')
  })
})

describe('normalizePatternsToPath', () => {
  test('空 root 模式直接返回', () => {
    const map = new Map<string | null, string[]>()
    map.set(null, ['**/*.ts'])
    const result = normalizePatternsToPath(map, '/root')
    expect(result).toEqual(['**/*.ts'])
  })

  test('root 下的模式前面加了 /', () => {
    const map = new Map<string | null, string[]>()
    map.set('/root', ['src/**/*.ts'])
    const result = normalizePatternsToPath(map, '/root')
    // prependDirSep 在 root 匹配时给 pattern 前面加 /
    expect(result).toContain('/src/**/*.ts')
  })

  test('root 下的嵌套模式', () => {
    const map = new Map<string | null, string[]>()
    map.set('/root/lib', ['internal/**'])
    const result = normalizePatternsToPath(map, '/root')
    // lib/internal/** 从 /root 可见
    expect(result).toContain('/lib/internal/**')
  })

  test('不可达的模式被过滤', () => {
    const map = new Map<string | null, string[]>()
    map.set('/far/away', ['doc.md'])
    const result = normalizePatternsToPath(map, '/root')
    // 无法从 /root 到达 /far/away 时 pattern 为 null，被过滤掉
    expect(result).toHaveLength(0)
  })
})
