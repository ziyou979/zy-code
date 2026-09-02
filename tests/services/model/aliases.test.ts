import { describe, expect, test } from 'bun:test'
import { isKnownModelAlias } from '../../../src/services/model/aliases.js'

describe('isKnownModelAlias', () => {
  test('规范化大小写与首尾空白后识别档位别名', () => {
    expect(isKnownModelAlias(' Advanced ')).toBe(true)
    expect(isKnownModelAlias('STANDARD')).toBe(true)
  })

  test('不把普通模型名识别成档位别名', () => {
    expect(isKnownModelAlias('gpt-5.6')).toBe(false)
  })
})
