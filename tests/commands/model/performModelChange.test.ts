import { describe, it, expect, beforeEach, vi } from 'bun:test'
import {
  resolveModelChange,
  renderModelLabel,
  describeCurrentModel,
} from '../../../src/commands/model/performModelChange.js'
import { COMMON_INFO_ARGS, COMMON_HELP_ARGS } from '../../../src/constants/xml.js'

// Mock i18n
vi.mock('../../../src/i18n/index.js', () => ({
  tSync: (key: string, params?: Record<string, string>) => {
    const map: Record<string, string> = {
      'modelCommand.help':
        'Run /model to open the model selection menu, or /model [modelName] to set the model.',
      'modelCommand.current': 'Current model: {model}',
      'modelCommand.currentSessionOverride':
        'Current model: {model} (session override from plan mode)\nBase model: {base}{effort}',
      'modelCommand.set': 'Set model to {model}',
      'modelCommand.setWithEffort': 'Set model to {model} with {effort} effort',
      'modelCommand.notAvailable':
        "Model '{model}' is not available. Your organization restricts model selection.",
      'modelCommand.notFound': "Model '{model}' not found",
      'modelCommand.validateFailed': 'Failed to validate model: {error}',
      'modelCommand.default': ' (default)',
    }
    let msg = map[key] || key
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        msg = msg.replace(`{${k}}`, v)
      }
    }
    return msg
  },
}))

// Mock model services
const mockGetDefaultMainLoopModelSetting = vi.fn(() => 'default-model')
const mockGetMainLoopModel = vi.fn(() => 'current-model')
const mockRenderDefaultModelSetting = vi.fn((model: string) => model)
// 注意：mock 实现必须与真实行为一致（小写 + trim 后匹配档位别名）。
// bun 全量并行复用 worker 时 vi.mock 会跨文件泄漏，实现偏离真实行为
// 会污染同 worker 的 aliases.test.ts（已实际发生，勿改回 sonnet/opus/haiku 列表）。
const mockIsKnownModelAlias = vi.fn((model: string) =>
  ['advanced', 'standard', 'compact'].includes(model.toLowerCase().trim()),
)
const mockIsModelAllowed = vi.fn(() => true)
const mockValidateModel = vi.fn().mockResolvedValue({ valid: true, error: null })

vi.mock('../../../src/services/model/model.js', () => ({
  getDefaultMainLoopModelSetting: mockGetDefaultMainLoopModelSetting,
  getMainLoopModel: mockGetMainLoopModel,
  renderDefaultModelSetting: mockRenderDefaultModelSetting,
}))

vi.mock('../../../src/services/model/aliases.js', () => ({
  isKnownModelAlias: mockIsKnownModelAlias,
}))

vi.mock('../../../src/services/model/modelAllowlist.js', () => ({
  isModelAllowed: mockIsModelAllowed,
}))

vi.mock('../../../src/services/model/validateModel.js', () => ({
  validateModel: mockValidateModel,
}))

describe('performModelChange - 收敛点测试', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetDefaultMainLoopModelSetting.mockReturnValue('default-model')
    mockGetMainLoopModel.mockReturnValue('current-model')
    mockRenderDefaultModelSetting.mockImplementation((model: string) => model)
    mockIsKnownModelAlias.mockImplementation((model: string) =>
      ['advanced', 'standard', 'compact'].includes(model.toLowerCase().trim()),
    )
    mockIsModelAllowed.mockReturnValue(true)
    mockValidateModel.mockResolvedValue({ valid: true, error: null })
  })

  describe('COMMON_INFO_ARGS 与 constants/xml.ts 保持一致', () => {
    it('应包含 xml.ts 定义的所有 13 个 info 参数', () => {
      expect(COMMON_INFO_ARGS).toEqual([
        'list',
        'show',
        'display',
        'current',
        'view',
        'get',
        'check',
        'describe',
        'print',
        'version',
        'about',
        'status',
        '?',
      ])
    })

    it('每个 info 参数都应被识别为 info 类型', async () => {
      for (const arg of COMMON_INFO_ARGS) {
        const result = await resolveModelChange(arg)
        expect(result.kind).toBe('info')
        if (result.kind === 'info') {
          expect(result.message).toContain('Current model:')
        }
      }
    })
  })

  describe('COMMON_HELP_ARGS 与 constants/xml.ts 保持一致', () => {
    it('应包含 xml.ts 定义的所有 3 个 help 参数', () => {
      expect(COMMON_HELP_ARGS).toEqual(['help', '-h', '--help'])
    })

    it('每个 help 参数都应返回帮助文案', async () => {
      for (const arg of COMMON_HELP_ARGS) {
        const result = await resolveModelChange(arg)
        expect(result.kind).toBe('info')
        if (result.kind === 'info') {
          expect(result.message).toContain('Run /model to open the model selection menu')
        }
      }
    })
  })

  describe('renderModelLabel - 与 jsx 端一致', () => {
    it('非 null 模型返回原名', () => {
      expect(renderModelLabel('sonnet')).toBe('sonnet')
    })

    it('null 模型返回默认模型 + "(default)" 后缀', () => {
      expect(renderModelLabel(null)).toBe('default-model (default)')
    })
  })

  describe('describeCurrentModel - 使用 i18n key', () => {
    it('无 session override 时使用 modelCommand.current', () => {
      const result = describeCurrentModel('model-a', undefined, undefined)
      expect(result).toBe('Current model: model-a')
    })

    it('有 session override 时使用 modelCommand.currentSessionOverride', () => {
      const result = describeCurrentModel('base-model', 'session-model', 'high')
      expect(result).toContain('Current model: session-model (session override from plan mode)')
      expect(result).toContain('Base model: base-model')
      expect(result).toContain('(effort: high)')
    })

    it('effortValue 为 undefined 时不包含 effort 信息', () => {
      const result = describeCurrentModel('model-a', 'session-model', undefined)
      expect(result).not.toContain('effort:')
    })
  })

  describe('resolveModelChange - 文案全部走 i18n', () => {
    it('已知别名返回 modelCommand.set', async () => {
      const result = await resolveModelChange('advanced')
      expect(result.kind).toBe('apply')
      if (result.kind === 'apply') {
        expect(result.model).toBe('advanced')
        expect(result.message).toBe('Set model to advanced')
      }
    })

    it('default 关键字返回 modelCommand.set (null model)', async () => {
      const result = await resolveModelChange('default')
      expect(result.kind).toBe('apply')
      if (result.kind === 'apply') {
        expect(result.model).toBeNull()
        expect(result.message).toBe('Set model to default-model (default)')
      }
    })

    it('自定义模型校验通过返回 modelCommand.set', async () => {
      const result = await resolveModelChange('custom-model')
      expect(result.kind).toBe('apply')
      if (result.kind === 'apply') {
        expect(result.model).toBe('custom-model')
        expect(result.message).toBe('Set model to custom-model')
      }
    })

    it('模型不在允许列表返回 modelCommand.notAvailable', async () => {
      mockIsModelAllowed.mockReturnValue(false)
      const result = await resolveModelChange('restricted-model')
      expect(result.kind).toBe('reject')
      if (result.kind === 'reject') {
        expect(result.message).toContain("Model 'restricted-model' is not available")
      }
    })

    it('校验失败返回 error 信息（优先于 i18n）', async () => {
      mockValidateModel.mockResolvedValue({
        valid: false,
        error: 'Model not found',
      })
      const result = await resolveModelChange('invalid-model')
      expect(result.kind).toBe('reject')
      if (result.kind === 'reject') {
        expect(result.message).toBe('Model not found')
      }
    })

    it('校验失败且无 error 时返回 modelCommand.notFound', async () => {
      mockValidateModel.mockResolvedValue({
        valid: false,
        error: null,
      })
      const result = await resolveModelChange('invalid-model')
      expect(result.kind).toBe('reject')
      if (result.kind === 'reject') {
        expect(result.message).toBe("Model 'invalid-model' not found")
      }
    })

    it('校验抛异常返回 modelCommand.validateFailed', async () => {
      mockValidateModel.mockRejectedValue(new Error('Network error'))
      const result = await resolveModelChange('error-model')
      expect(result.kind).toBe('reject')
      if (result.kind === 'reject') {
        expect(result.message).toBe('Failed to validate model: Network error')
      }
    })
  })

  describe('空参数返回 picker', () => {
    it('空字符串返回 picker', async () => {
      const result = await resolveModelChange('')
      expect(result.kind).toBe('picker')
    })

    it('纯空格返回 picker', async () => {
      const result = await resolveModelChange('   ')
      expect(result.kind).toBe('picker')
    })
  })
})
