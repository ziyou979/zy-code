import { describe, expect, test } from 'bun:test'
import {
  applyModelOptionSelection,
  createTierCandidateOptions,
} from '../../../src/services/model/modelOptions.js'
import type { ResolvedModelReference } from '../../../src/services/model/model.js'

describe('modelOptions candidate selection', () => {
  const candidates: ResolvedModelReference[] = [
    { model: 'grok-4.5', provider: 'xai', candidateIndex: 0 },
    { model: 'deepseek-v4-flash', provider: 'deepseek', candidateIndex: 1 },
  ]

  test('同一档位的候选使用唯一 picker value，并保留所属 tier', () => {
    const options = createTierCandidateOptions(
      'standard',
      candidates,
      candidates[0]!,
      (model) => model,
    )

    expect(options).toHaveLength(2)
    expect(options[0]?.pickerValue).toBe('standard')
    expect(options[1]?.pickerValue).not.toBe('standard')
    expect(options.map((option) => option.value)).toEqual(['standard', 'standard'])
    expect(options[1]?.candidateSelection?.candidate.provider).toBe('deepseek')
  })

  test('当前 sticky 候选变化后，tier value 跟随当前项以便重新聚焦', () => {
    const options = createTierCandidateOptions(
      'standard',
      candidates,
      candidates[1]!,
      (model) => model,
    )

    expect(options[0]?.pickerValue).not.toBe('standard')
    expect(options[1]?.pickerValue).toBe('standard')
  })

  test('普通选项不触发候选 pin，并原样返回模型设置', () => {
    expect(
      applyModelOptionSelection({
        value: 'custom-model',
        label: 'Custom',
        description: 'Custom model',
      }),
    ).toBe('custom-model')
  })
})
