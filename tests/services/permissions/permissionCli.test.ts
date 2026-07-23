/**
 * permissionCli CLI 参数解析测试。
 *
 * 覆盖范围：
 *   - parseToolListFromCLI：工具列表解析
 *   - parseBaseToolsFromCLI：基础工具规格解析（含预设处理）
 */
import { describe, expect, test } from 'bun:test'

const { parseToolListFromCLI, parseBaseToolsFromCLI } = await import(
  '../../../src/services/permissions/permissionCli.js'
)

// ============================================================================
// parseToolListFromCLI
// ============================================================================
describe('parseToolListFromCLI', () => {
  test('空数组返回空数组', () => {
    expect(parseToolListFromCLI([])).toEqual([])
  })

  test('单个工具名称', () => {
    expect(parseToolListFromCLI(['Bash'])).toEqual(['Bash'])
  })

  test('用空格分隔的多个工具', () => {
    expect(parseToolListFromCLI(['Bash Edit Read'])).toEqual(['Bash', 'Edit', 'Read'])
  })

  test('用逗号分隔的多个工具', () => {
    expect(parseToolListFromCLI(['Bash,Edit,Read'])).toEqual(['Bash', 'Edit', 'Read'])
  })

  test('忽略空字符串元素', () => {
    expect(parseToolListFromCLI(['Bash', '', 'Edit'])).toEqual(['Bash', 'Edit'])
  })

  test('括号内容保持不拆分', () => {
    expect(parseToolListFromCLI(['Bash(ls),Edit'])).toEqual(['Bash(ls)', 'Edit'])
  })

  test('括号内的逗号和空格不触发拆分', () => {
    const result = parseToolListFromCLI(['Bash(ls -la, find),Edit'])
    expect(result).toEqual(['Bash(ls -la, find)', 'Edit'])
  })

  test('混合处理空格和逗号', () => {
    expect(parseToolListFromCLI(['Bash,Edit Read'])).toEqual(['Bash', 'Edit', 'Read'])
  })
})

// ============================================================================
// parseBaseToolsFromCLI
// ============================================================================
describe('parseBaseToolsFromCLI', () => {
  test('default 预设返回默认工具列表', () => {
    const result = parseBaseToolsFromCLI(['default'])
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBeGreaterThan(0)
  })

  test('自定义工具列表作为工具名解析', () => {
    const result = parseBaseToolsFromCLI(['Bash', 'Edit'])
    expect(result).toEqual(['Bash', 'Edit'])
  })

  test('空数组返回空数组', () => {
    expect(parseBaseToolsFromCLI([])).toEqual([])
  })
})
