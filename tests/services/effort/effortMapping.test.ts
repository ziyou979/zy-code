import { describe, expect, test } from 'bun:test'
import { parseEffortMapping } from '../../../src/services/effort/effortMapping.js'

describe('effortMapping', () => {
  test('开关和明确 API 映射可分别保存', () => {
    expect(parseEffortMapping('["off","on"]')).toEqual({ levels: ['off', 'on'] })
    expect(
      parseEffortMapping(
        '{"levels":["off","quick","light"],"map":{"quick":"minimal","light":"low"}}',
      ),
    ).toEqual({ levels: ['off', 'quick', 'light'], map: { quick: 'minimal', light: 'low' } })
  })
  test('非法档位、重复、空映射、未映射强度及无效键均不静默保存', () => {
    for (const value of [
      '{}',
      '["medium"]',
      '[]',
      '["off","off"]',
      '["balanced"]',
      '{"levels":["light"],"map":{"light":""}}',
      '{"levels":["on"],"map":{"unknown":"high"}}',
    ]) {
      expect(parseEffortMapping(value)).toBeUndefined()
    }
  })
  test('ultra 复用 extreme，不接受伪造的独立平台强度', () => {
    expect(
      parseEffortMapping('{"levels":["extreme","ultra"],"map":{"extreme":"max"}}')?.map,
    ).toEqual({ extreme: 'max' })
    expect(parseEffortMapping('{"levels":["ultra"],"map":{"ultra":"max"}}')).toBeUndefined()
  })
  test('关闭走独立开关，映射值去掉意外空格后发送', () => {
    expect(parseEffortMapping('{"levels":["off"],"map":{"off":"none"}}')).toBeUndefined()
    expect(parseEffortMapping('{"levels":["light"],"map":{"light":" low "}}')?.map).toEqual({
      light: 'low',
    })
  })
})
