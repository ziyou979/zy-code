import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getAllowedSettingSources,
  setAllowedSettingSources,
} from '../../src/bootstrap/runtime/runtimeContext.js'
import { tSync, warmI18n } from '../../src/i18n/index.js'
import { executeShellCommandsInPrompt } from '../../src/services/shell/promptShellExecution.js'
import { resetSettingsCache } from '../../src/services/settings/settingsCache.js'
import type { ToolUseContext } from '../../src/tools/tool.js'

// 守卫与纯文本分支不执行 shell，使用真实临时设置即可验证，无需替换整条依赖链。
describe('promptShellExecution', () => {
  let directory: string
  let previousDirectory: string | undefined
  let previousSources: ReturnType<typeof getAllowedSettingSources>
  beforeEach(async () => {
    previousDirectory = process.env.ZY_CONFIG_DIR
    previousSources = getAllowedSettingSources()
    directory = mkdtempSync(join(tmpdir(), 'zy-prompt-shell-'))
    process.env.ZY_CONFIG_DIR = directory
    setAllowedSettingSources(['userSettings'])
    resetSettingsCache()
    await warmI18n()
  })
  afterEach(() => {
    if (previousDirectory === undefined) {
      delete process.env.ZY_CONFIG_DIR
    } else {
      process.env.ZY_CONFIG_DIR = previousDirectory
    }
    setAllowedSettingSources(previousSources)
    resetSettingsCache()
    rmSync(directory, { recursive: true, force: true })
  })
  test('设置为 true 时，包含 shell 命令的文本被拒绝', async () => {
    writeFileSync(
      join(directory, 'settings.json'),
      JSON.stringify({ disableSkillShellExecution: true }),
    )
    resetSettingsCache()
    await expect(
      executeShellCommandsInPrompt('Hello !`ls -la` world', {} as ToolUseContext, 'test-skill'),
    ).rejects.toThrow(tSync('skillShell.disabledBySettings'))
  })
  for (const settings of [{}, { disableSkillShellExecution: false }]) {
    test(`设置为 ${String(settings.disableSkillShellExecution)} 时纯文本不变`, async () => {
      writeFileSync(join(directory, 'settings.json'), JSON.stringify(settings))
      resetSettingsCache()
      const text = 'Hello world, no shell commands here'
      expect(await executeShellCommandsInPrompt(text, {} as ToolUseContext, 'test-skill')).toBe(
        text,
      )
    })
  }
})
