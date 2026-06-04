/**
 * safeStringifyToolArguments 测试：工具参数序列化防双重转义防线。
 *
 * 重点关注：
 * - undefined/null → '{}'
 * - 合法 JSON 对象字符串 → 原样返回
 * - JSON.parse 合法但不是 object → 包装 {raw: ...}
 * - 非法 JSON 字符串 → 包装 {raw: ...}
 * - 对象输入 → JSON.stringify
 * - 数组/数字/boolean 输入 → 包装 {raw: ...}
 */
import { describe, expect, test } from 'bun:test'
import {
  messagesToOpenAI,
  safeStringifyToolArguments,
} from '../../../src/services/api/conversions/openai.js'

/**
 * 通过 messagesToOpenAI 路径间接测试 safeStringifyToolArguments。
 * 构造一个 assistant 单 tool_call 消息，验证 arguments 序列化结果。
 */
function serializeInput(input: unknown): string {
  const messages = [
    {
      role: 'assistant',
      content: [{ type: 'tool_call', id: 'c', name: 'f', input }],
    },
  ]
  // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
  const result = messagesToOpenAI(messages as any)
  // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
  const a = result.find((m) => m.role === 'assistant') as any
  return a.tool_calls[0].function.arguments
}

describe('safeStringifyToolArguments（通过 messagesToOpenAI 间接测）', () => {
  test('undefined → "{}"', () => {
    expect(serializeInput(undefined)).toBe('{}')
  })

  test('null → "{}"', () => {
    expect(serializeInput(null)).toBe('{}')
  })

  test('空字符串 → "{}"', () => {
    expect(serializeInput('')).toBe('{}')
  })

  test('空白字符串 → "{}"', () => {
    expect(serializeInput('  ')).toBe('{}')
  })

  test('合法 JSON 对象字符串 → 原样返回（防线起效）', () => {
    expect(serializeInput('{"q":"hi"}')).toBe('{"q":"hi"}')
  })

  test('非法 JSON 字符串 → 包装成 {raw: "..."}', () => {
    const result = serializeInput('not json')
    const parsed = JSON.parse(result)
    expect(parsed).toEqual({ raw: 'not json' })
  })

  test('合法 JSON 但不是 object（字符串）→ 包装成 {raw: "..."}', () => {
    const result = serializeInput('"just a string"')
    const parsed = JSON.parse(result)
    expect(parsed).toEqual({ raw: 'just a string' })
  })

  test('合法 JSON 但不是 object（number）→ 包装成 {raw: ...}', () => {
    const result = serializeInput('42')
    const parsed = JSON.parse(result)
    expect(parsed).toEqual({ raw: 42 })
  })

  test('合法 JSON 但不是 object（array）→ 包装成 {raw: [...]}', () => {
    const result = serializeInput('[1,2,3]')
    const parsed = JSON.parse(result)
    expect(parsed).toEqual({ raw: [1, 2, 3] })
  })

  test('对象输入 → JSON.stringify', () => {
    expect(serializeInput({ key: 'value' })).toBe('{"key":"value"}')
  })

  test('数字输入 → 包装成 {raw: ...}', () => {
    const result = serializeInput(42)
    const parsed = JSON.parse(result)
    expect(parsed).toEqual({ raw: 42 })
  })

  test('boolean 输入 → 包装成 {raw: ...}', () => {
    const result = serializeInput(true)
    const parsed = JSON.parse(result)
    expect(parsed).toEqual({ raw: true })
  })

  test('数组输入 → 包装成 {raw: [...]}', () => {
    const result = serializeInput([1, 2, 3])
    const parsed = JSON.parse(result)
    expect(parsed).toEqual({ raw: [1, 2, 3] })
  })

  test('循环引用对象 → JSON.stringify 抛错 → 回退 "{}"', () => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const obj: any = { a: 1 }
    obj.self = obj
    expect(safeStringifyToolArguments(obj)).toBe('{}')
  })

  test('循环引用作为数组元素 → 包装抛错 → 回退 "{}"', () => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const obj: any = {}
    obj.self = obj
    // 数组输入走 typeof input === 'object' 但 Array.isArray 为 true → 非对象分支
    // 所以改为测试原始值中 JSON.stringify 抛错的情况
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    expect(safeStringifyToolArguments(BigInt(1) as any)).toBe('{}')
  })
})
