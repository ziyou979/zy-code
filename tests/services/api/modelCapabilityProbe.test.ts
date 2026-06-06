import { describe, test, expect, beforeEach } from 'bun:test'
import {
  probeThinkingFromError,
  probedModelSupportsThinking,
  probedModelSupportsAdaptiveThinking,
  _resetForTesting,
} from 'src/services/api/modelCapabilityProbe.js'

describe('modelCapabilityProbe', () => {
  beforeEach(() => {
    _resetForTesting()
  })

  test('未探测过的模型返回 undefined', () => {
    expect(probedModelSupportsThinking('unknown-model')).toBeUndefined()
    expect(probedModelSupportsAdaptiveThinking('unknown-model')).toBeUndefined()
  })

  test('探测到 thinking 不支持时降级 thinking 和 adaptive', () => {
    probeThinkingFromError('test-model', 'thinking.type: enabled is not supported on this model')
    expect(probedModelSupportsThinking('test-model')).toBe(false)
    expect(probedModelSupportsAdaptiveThinking('test-model')).toBe(false)
  })

  test('探测到 adaptive thinking 不支持时仅降级 adaptive', () => {
    probeThinkingFromError('test-model', 'thinking.type: adaptive is not supported on this model')
    expect(probedModelSupportsThinking('test-model')).toBe(true)
    expect(probedModelSupportsAdaptiveThinking('test-model')).toBe(false)
  })

  test('匹配 "adaptive thinking is not supported" 错误消息', () => {
    probeThinkingFromError('test-model', 'adaptive thinking is not supported')
    expect(probedModelSupportsThinking('test-model')).toBe(true)
    expect(probedModelSupportsAdaptiveThinking('test-model')).toBe(false)
  })

  test('不匹配无关错误消息', () => {
    probeThinkingFromError('test-model', 'rate limit exceeded')
    expect(probedModelSupportsThinking('test-model')).toBeUndefined()
    expect(probedModelSupportsAdaptiveThinking('test-model')).toBeUndefined()
  })

  test('不同模型独立跟踪', () => {
    probeThinkingFromError('model-a', 'adaptive thinking is not supported')
    probeThinkingFromError('model-b', 'thinking.type: enabled is not supported on this model')
    expect(probedModelSupportsThinking('model-a')).toBe(true)
    expect(probedModelSupportsAdaptiveThinking('model-a')).toBe(false)
    expect(probedModelSupportsThinking('model-b')).toBe(false)
    expect(probedModelSupportsAdaptiveThinking('model-b')).toBe(false)
  })

  test('重置后清除所有探测记录', () => {
    probeThinkingFromError('test-model', 'adaptive thinking is not supported')
    expect(probedModelSupportsAdaptiveThinking('test-model')).toBe(false)
    _resetForTesting()
    expect(probedModelSupportsAdaptiveThinking('test-model')).toBeUndefined()
  })
})
