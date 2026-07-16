/**
 * promptShellExecution 测试：Skill 内联 shell 执行控制。
 *
 * 重点关注：
 * - disableSkillShellExecution 设置为 true 时阻止执行
 * - 设置未定义或为 false 时不阻止
 */
import { afterEach, describe, expect, test } from 'bun:test'
import type { ToolUseContext } from '../../src/tools/Tool.js'

/**
 * 统一注册所有传递依赖模块的 mock，阻断重依赖链加载。
 * getInitialSettings 由调用方通过参数注入，其余返回空桩。
 */
function setupMocks(
  mock: typeof import('bun:test').mock,
  settingsOverride: Record<string, unknown> = {},
) {
  // 直接依赖
  mock.module('../../src/services/settings/settings.js', () => ({
    getInitialSettings: () => settingsOverride,
  }))
  mock.module('../../src/utils/debug.js', () => ({
    logForDebugging: () => {},
  }))
  mock.module('../../src/i18n/index.js', () => ({
    tSync: (key: string) => `[i18n:${key}]`,
    t: (key: string) => `[i18n:${key}]`,
    getUiLanguage: () => 'en',
    warmI18n: async () => {},
    SUPPORTED_UI_LANGUAGES: ['en', 'zh'],
  }))

  // 重传递依赖：BashTool、permissions、messages、toolResultStorage、shell utils
  mock.module('../../src/tools/BashTool/BashTool.js', () => ({
    BashTool: { call: async () => ({ data: { stdout: '', stderr: '', interrupted: false } }) },
  }))
  mock.module('../../src/services/permissions/permissions.js', () => ({
    hasPermissionsToUseTool: async () => ({ behavior: 'allow' }),
  }))
  mock.module('../../src/services/messages/constructors.js', () => ({
    createAssistantMessage: () => ({ content: [] }),
  }))
  mock.module('../../src/utils/toolResultStorage.js', () => ({
    processToolResultBlock: async () => ({ content: '' }),
  }))
  mock.module('../../src/utils/shell/shellToolUtils.js', () => ({
    isPowerShellToolEnabled: () => false,
  }))
}

describe('promptShellExecution', () => {
  afterEach(async () => {
    const { mock } = await import('bun:test')
    mock.restore()
  })

  describe('disableSkillShellExecution 守卫', () => {
    test('设置为 true 时，包含 shell 命令的文本抛出 MalformedCommandError', async () => {
      const { mock } = await import('bun:test')
      setupMocks(mock, { disableSkillShellExecution: true })

      const { executeShellCommandsInPrompt } = await import(
        '../../src/utils/promptShellExecution.js'
      )

      const textWithShell = 'Hello !`ls -la` world'
      const fakeContext = {} as unknown as ToolUseContext

      await expect(
        executeShellCommandsInPrompt(textWithShell, fakeContext, 'test-skill'),
      ).rejects.toThrow('[i18n:skillShell.disabledBySettings]')
    })

    test('设置未定义时，纯文本正常返回（守卫不触发）', async () => {
      const { mock } = await import('bun:test')
      setupMocks(mock, {})

      const { executeShellCommandsInPrompt } = await import(
        '../../src/utils/promptShellExecution.js'
      )

      const plainText = 'Hello world, no shell commands here'
      const fakeContext = {} as unknown as ToolUseContext

      const result = await executeShellCommandsInPrompt(plainText, fakeContext, 'test-skill')
      expect(result).toBe(plainText)
    })

    test('设置为 false 时，纯文本正常返回（守卫不触发）', async () => {
      const { mock } = await import('bun:test')
      setupMocks(mock, { disableSkillShellExecution: false })

      const { executeShellCommandsInPrompt } = await import(
        '../../src/utils/promptShellExecution.js'
      )

      const plainText = 'Just some regular text'
      const fakeContext = {} as unknown as ToolUseContext

      const result = await executeShellCommandsInPrompt(plainText, fakeContext, 'test-skill')
      expect(result).toBe(plainText)
    })
  })
})
