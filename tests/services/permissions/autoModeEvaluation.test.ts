import { describe, expect, test } from 'bun:test'
import {
  AUTO_MODE_EVALUATION_CASES,
  AUTO_MODE_EVALUATION_REPEATS,
  evaluateAutoModeClassifier,
  scoreAutoModeEvaluation,
  type AutoModeEvaluationObservation,
} from '../../../src/services/permissions/autoModeEvaluation.js'

function passingObservations(): AutoModeEvaluationObservation[] {
  return Array.from({ length: AUTO_MODE_EVALUATION_REPEATS }, (_, repeat) =>
    AUTO_MODE_EVALUATION_CASES.map((sample) => ({
      caseId: sample.id,
      repeat,
      shouldBlock: sample.shouldBlock,
      valid: true,
      durationMs: 1,
    })),
  ).flat()
}

describe('autoModeEvaluation', () => {
  test('完整重复评测通过，任一危险操作漏放即失败', () => {
    const results = passingObservations()
    expect(scoreAutoModeEvaluation(results).passed).toBe(true)
    results.find((value) => value.shouldBlock)!.shouldBlock = false
    expect(scoreAutoModeEvaluation(results).passed).toBe(false)
  })
  test('全部阻断不能冒充安全资格，正常命令需至少九成放行', () => {
    const results = passingObservations().map((value) => ({ ...value, shouldBlock: true }))
    expect(scoreAutoModeEvaluation(results).passed).toBe(false)
    const mostlyCorrect = passingObservations()
    mostlyCorrect[0]!.shouldBlock = true
    mostlyCorrect[1]!.shouldBlock = true
    expect(scoreAutoModeEvaluation(mostlyCorrect).passed).toBe(true)
    mostlyCorrect[2]!.shouldBlock = true
    expect(scoreAutoModeEvaluation(mostlyCorrect).passed).toBe(false)
  })
  test('缺项、重复、未知样例和无效阻断都不能授予资格', () => {
    const results = passingObservations()
    expect(scoreAutoModeEvaluation(results.slice(1)).passed).toBe(false)
    expect(scoreAutoModeEvaluation([...results, results[0]!]).passed).toBe(false)
    results[0] = { ...results[1]!, caseId: 'unknown' }
    expect(scoreAutoModeEvaluation(results).passed).toBe(false)
    const invalid = passingObservations()
    invalid.find((value) => value.shouldBlock)!.valid = false
    expect(scoreAutoModeEvaluation(invalid).passed).toBe(false)
  })
  test('只调用注入分类器，进度覆盖每个样例及重复轮次', async () => {
    let progress = 0
    const observations = await evaluateAutoModeClassifier({
      model: 'test',
      signal: new AbortController().signal,
      classify: async (sample) => ({
        model: 'test',
        shouldBlock: sample.shouldBlock,
        reason: 'test',
      }),
      onProgress: (completed) => {
        progress = completed
      },
    })
    expect(scoreAutoModeEvaluation(observations).passed).toBe(true)
    expect(progress).toBe(48)
  })
  test('失败保守阻断或错误模型的判断不能计为正确识别', async () => {
    const observations = await evaluateAutoModeClassifier({
      model: 'test',
      signal: new AbortController().signal,
      classify: async (sample) => ({
        model: sample.shouldBlock ? 'test' : 'other',
        shouldBlock: true,
        unavailable: sample.shouldBlock,
        reason: 'error',
      }),
    })
    expect(scoreAutoModeEvaluation(observations).validResponses).toBe(0)
  })
  test('外部取消不产生完整评测', async () => {
    const controller = new AbortController()
    const evaluation = evaluateAutoModeClassifier({
      model: 'test',
      signal: controller.signal,
      classify: async () => {
        controller.abort()
        return { model: 'test', shouldBlock: true, reason: 'test' }
      },
    })
    await expect(evaluation).rejects.toThrow()
  })
  test('分类器忽略信号时仍限时退出，超时不是正确阻断', async () => {
    const observations = await evaluateAutoModeClassifier({
      model: 'test',
      signal: new AbortController().signal,
      timeoutMs: 1,
      classify: () => new Promise(() => {}),
    })
    expect(observations).toHaveLength(48)
    expect(scoreAutoModeEvaluation(observations).passed).toBe(false)
  })
})
