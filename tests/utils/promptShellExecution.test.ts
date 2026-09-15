/**
 * promptShellExecution 测试：Skill 内联 shell 执行控制。
 *
 * 重点关注：
 * - disableSkillShellExecution 设置为 true 时阻止执行
 * - 设置未定义或为 false 时不阻止
 */
import { describe, expect, mock, test } from 'bun:test'
import type { ToolUseContext } from '../../src/tools/tool.js'
// Bun 的 mock.module factory 内不能 import 被 mock 的目标模块（返回空对象，
// 透传失效甚至卡死加载链），真实导出必须在 factory 外顶层加载。
import * as settingsActual from '../../src/services/settings/settings.js'
import * as debugActual from '../../src/services/infra/debug.js'
import * as i18nActual from '../../src/i18n/index.js'
import * as permissionsActual from '../../src/services/permissions/permissions.js'
import * as toolResultStorageActual from '../../src/services/mcp/toolResultStorage.js'
import * as shellToolUtilsActual from '../../src/shell-eval/shared/shellToolUtils.js'

// mock.module 是进程级全局替换且 mock.restore() 不撤销它：此前窄面 mock
// （settings.js 只给 getInitialSettings）会丢失其余导出（如 getSettingsForSource），
// 泄漏给同 worker 后续文件造成 "Export named ... not found"；而"事后恢复"
// （afterAll/afterEach）在文件并发交错下赢不了受害者文件的 spread-real 重登记，
// 反而会把受害者 beforeEach 刚登记的桩覆盖回真实模块。统一改为
// **真实快照 spread + 仅覆盖所需导出**且不主动恢复：泄漏的只是无害的真实行为。
// BashTool / constructors / messages 不再 fake——spread-real 已保证导出完整，
// 且本测试路径不会真正触发 shell 调用（守卫先行抛错）。
const MOCK_PATHS = {
  settings: '../../src/services/settings/settings.js',
  debug: '../../src/services/infra/debug.js',
  i18n: '../../src/i18n/index.js',
  permissions: '../../src/services/permissions/permissions.js',
  toolResultStorage: '../../src/services/mcp/toolResultStorage.js',
  shellToolUtils: '../../src/shell-eval/shared/shellToolUtils.js',
} as const

/**
 * 统一注册所有传递依赖模块的 mock，阻断重依赖链加载。
 * getInitialSettings 由调用方通过参数注入，其余导出透传真实模块。
 */
function setupMocks(settingsOverride: Record<string, unknown> = {}) {
  mock.module(MOCK_PATHS.settings, () => ({
    ...settingsActual,
    getInitialSettings: () => settingsOverride,
  }))
  mock.module(MOCK_PATHS.debug, () => ({ ...debugActual, logForDebugging: () => {} }))
  mock.module(MOCK_PATHS.i18n, () => ({
    ...i18nActual,
    tSync: (key: string) => `[i18n:${key}]`,
    t: (key: string) => `[i18n:${key}]`,
    getUiLanguage: () => 'en',
    warmI18n: async () => {},
    SUPPORTED_UI_LANGUAGES: ['en', 'zh'],
  }))
  mock.module(MOCK_PATHS.permissions, () => ({
    ...permissionsActual,
    hasPermissionsToUseTool: async () => ({ behavior: 'allow' }),
  }))
  mock.module(MOCK_PATHS.toolResultStorage, () => ({
    ...toolResultStorageActual,
    processToolResultBlock: async () => ({ content: '' }),
  }))
  mock.module(MOCK_PATHS.shellToolUtils, () => ({
    ...shellToolUtilsActual,
    isPowerShellToolEnabled: () => false,
  }))
}

describe('promptShellExecution', () => {
  describe('disableSkillShellExecution 守卫', () => {
    test('设置为 true 时，包含 shell 命令的文本抛出 MalformedCommandError', async () => {
      setupMocks({ disableSkillShellExecution: true })

      const { executeShellCommandsInPrompt } = await import(
        '../../src/services/shell/promptShellExecution.js'
      )

      const textWithShell = 'Hello !`ls -la` world'
      const fakeContext = {} as unknown as ToolUseContext

      await expect(
        executeShellCommandsInPrompt(textWithShell, fakeContext, 'test-skill'),
      ).rejects.toThrow('[i18n:skillShell.disabledBySettings]')
    })

    test('设置未定义时，纯文本正常返回（守卫不触发）', async () => {
      setupMocks({})

      const { executeShellCommandsInPrompt } = await import(
        '../../src/services/shell/promptShellExecution.js'
      )

      const plainText = 'Hello world, no shell commands here'
      const fakeContext = {} as unknown as ToolUseContext

      const result = await executeShellCommandsInPrompt(plainText, fakeContext, 'test-skill')
      expect(result).toBe(plainText)
    })

    test('设置为 false 时，纯文本正常返回（守卫不触发）', async () => {
      setupMocks({ disableSkillShellExecution: false })

      const { executeShellCommandsInPrompt } = await import(
        '../../src/services/shell/promptShellExecution.js'
      )

      const plainText = 'Just some regular text'
      const fakeContext = {} as unknown as ToolUseContext

      const result = await executeShellCommandsInPrompt(plainText, fakeContext, 'test-skill')
      expect(result).toBe(plainText)
    })
  })
})
