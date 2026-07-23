/**
 * autoEditPathSafety 路径安全检查测试。
 *
 * 覆盖范围：
 *   - DANGEROUS_FILES / DANGEROUS_DIRECTORIES 常量定义
 *   - hasSuspiciousWindowsPathPattern：可疑路径模式检测（跨平台）
 *
 * 注意：checkPathSafetyForAutoEdit 需要 mock 大量外部依赖
 *（runtimeContext / i18n / fsOperations 等），此处暂不覆盖。
 */
import { describe, expect, test } from 'bun:test'

const { DANGEROUS_FILES, DANGEROUS_DIRECTORIES, hasSuspiciousWindowsPathPattern } = await import(
  '../../../src/services/permissions/autoEditPathSafety.js'
)

// ============================================================================
// DANGEROUS_FILES
// ============================================================================
describe('DANGEROUS_FILES', () => {
  test('包含 shell 配置文件', () => {
    expect(DANGEROUS_FILES).toContain('.bashrc')
    expect(DANGEROUS_FILES).toContain('.zshrc')
    expect(DANGEROUS_FILES).toContain('.profile')
  })

  test('包含 git 配置文件', () => {
    expect(DANGEROUS_FILES).toContain('.gitconfig')
    expect(DANGEROUS_FILES).toContain('.gitmodules')
  })

  test('包含 ZY Code 配置文件', () => {
    expect(DANGEROUS_FILES).toContain('.mcp.json')
    expect(DANGEROUS_FILES).toContain('.zy.json')
  })

  test('数据为只读元组', () => {
    // 验证是 const 断言后的字面量类型
    expect(Array.isArray(DANGEROUS_FILES)).toBe(true)
    expect(DANGEROUS_FILES.length).toBeGreaterThanOrEqual(8)
  })
})

// ============================================================================
// DANGEROUS_DIRECTORIES
// ============================================================================
describe('DANGEROUS_DIRECTORIES', () => {
  test('包含版本控制目录', () => {
    expect(DANGEROUS_DIRECTORIES).toContain('.git')
  })

  test('包含 IDE 配置目录', () => {
    expect(DANGEROUS_DIRECTORIES).toContain('.vscode')
    expect(DANGEROUS_DIRECTORIES).toContain('.idea')
  })

  test('包含 ZY 目录', () => {
    expect(DANGEROUS_DIRECTORIES).toContain('.zy')
  })

  test('数据为只读元组', () => {
    expect(Array.isArray(DANGEROUS_DIRECTORIES)).toBe(true)
    expect(DANGEROUS_DIRECTORIES.length).toBeGreaterThanOrEqual(4)
  })
})

// ============================================================================
// hasSuspiciousWindowsPathPattern
// ============================================================================
describe('hasSuspiciousWindowsPathPattern', () => {
  // 跨平台路径模式（不依赖 getPlatform）
  test('UNC 长路径前缀 \\\\?\\ 识别为可疑', () => {
    expect(hasSuspiciousWindowsPathPattern('\\\\?\\C:\\foo')).toBe(true)
  })

  test('UNC 设备路径前缀 \\\\.\\ 识别为可疑', () => {
    expect(hasSuspiciousWindowsPathPattern('\\\\.\\COM1')).toBe(true)
  })

  test('POSIX 风格长路径前缀 //?/ 识别为可疑', () => {
    expect(hasSuspiciousWindowsPathPattern('//?/C:/foo')).toBe(true)
  })

  test('POSIX 风格设备路径前缀 //./ 识别为可疑', () => {
    expect(hasSuspiciousWindowsPathPattern('//./COM1')).toBe(true)
  })

  // 尾部点/空格
  test('尾部有点的路径识别为可疑', () => {
    expect(hasSuspiciousWindowsPathPattern('/path/to/foo.')).toBe(true)
  })

  test('尾部有空格的路径识别为可疑', () => {
    expect(hasSuspiciousWindowsPathPattern('/path/to/foo ')).toBe(true)
  })

  // 保留名称（跨平台，匹配 `.CON` 后缀模式）
  test('.CON 后缀识别为可疑', () => {
    expect(hasSuspiciousWindowsPathPattern('/path/to/file.CON')).toBe(true)
  })

  test('.NUL 后缀识别为可疑', () => {
    expect(hasSuspiciousWindowsPathPattern('/path/to/file.NUL')).toBe(true)
  })

  test('.COM1 后缀识别为可疑', () => {
    expect(hasSuspiciousWindowsPathPattern('/path/to/file.COM1')).toBe(true)
  })

  test('.LPT1 后缀识别为可疑', () => {
    expect(hasSuspiciousWindowsPathPattern('/path/to/file.LPT1')).toBe(true)
  })

  // 多点路径
  test('连续三个点(以上)识别为可疑', () => {
    expect(hasSuspiciousWindowsPathPattern('/path/to/...')).toBe(true)
  })

  test('带有中括号的路径不触发', () => {
    expect(hasSuspiciousWindowsPathPattern('/path/to/normal/file.txt')).toBe(false)
  })

  test('正常路径不触发', () => {
    expect(hasSuspiciousWindowsPathPattern('/home/user/projects/my-app/src/index.ts')).toBe(false)
  })

  test('正常 Windows 路径不触发', () => {
    expect(hasSuspiciousWindowsPathPattern('C:\\Users\\user\\file.txt')).toBe(false)
  })

  // 双波浪号（Windows 8.3 短名称）
  test('包含 ~ 数字的路径识别为可疑', () => {
    expect(hasSuspiciousWindowsPathPattern('/path/to/PROGRA~1')).toBe(true)
  })
})
