import { expect, test } from 'bun:test'
import {
  isModelInputModality,
  acceptsModelInput,
} from '../../../src/services/model/modelInputTypes.js'
import { parseModelCapabilityEntry } from '../../../src/services/settings/localModelCapabilities.js'

test('原生配置及渠道覆盖保留 MIME 并拒绝无效类型', () => {
  const entry = {
    pattern: 'mime-test',
    capabilities: { input: ['text', 'image/jpeg', 'application/pdf'] },
    providerOverrides: { generic: { capabilities: { input: ['image/png'] } } },
  }
  expect(parseModelCapabilityEntry(entry)?.capabilities.input).toEqual([
    'text',
    'image/jpeg',
    'application/pdf',
  ])
  expect(parseModelCapabilityEntry(entry)?.providerOverrides?.generic.capabilities?.input).toEqual([
    'image/png',
  ])
  for (const input of [
    'image/*',
    'application/pdf; charset=utf-8',
    '/pdf',
    'image/',
    'image jpeg',
  ]) {
    expect(isModelInputModality(input)).toBe(false)
    expect(
      parseModelCapabilityEntry({ pattern: 'invalid', capabilities: { input: [input] } }),
    ).toBeUndefined()
  }
  expect(acceptsModelInput(['IMAGE/JPEG'], 'image/jpeg')).toBe(true)
  expect(acceptsModelInput(['document'], 'application/octet-stream')).toBe(false)
})
