import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  clearExternalToolState,
  hasExternalToolOverride,
  reloadExternalTools,
} from '../../src/tools/externalToolLoader.js'
import { getAllBaseTools } from '../../src/tools.js'

/**
 * 在临时目录下创建可加载的外部工具 .ts 文件。
 * 返回 { tmpDir, toolsDir, cleanup }。
 */
function setupTempTool(
  toolName: string,
  toolCode?: string,
): { tmpDir: string; toolsDir: string; cleanup: () => void } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ext-tools-test-'))
  const toolsDir = join(tmpDir, '.zy', 'tools')
  mkdirSync(toolsDir, { recursive: true })

  const code =
    toolCode ??
    `
export default {
  name: '${toolName}',
  description: 'Temp test tool for reload verification',
  inputSchema: { type: 'object', properties: {}, required: [] },
  call: async () => 'ok',
}
`
  writeFileSync(join(toolsDir, `${toolName}.ts`), code)

  return {
    tmpDir,
    toolsDir,
    cleanup: () => {
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
    },
  }
}

describe('externalToolLoader', () => {
  describe('hasExternalToolOverride', () => {
    test('returns false for non-existent tool name', () => {
      expect(hasExternalToolOverride('NonExistentTool')).toBe(false)
    })

    test('returns false for WebSearch when no external tool is loaded', () => {
      // 在没有加载外部工具的测试环境中，应该返回 false
      expect(hasExternalToolOverride('WebSearch')).toBe(false)
    })

    test('is case-sensitive', () => {
      expect(hasExternalToolOverride('websearch')).toBe(false)
      expect(hasExternalToolOverride('WEBSEARCH')).toBe(false)
    })
  })

  describe('reload', () => {
    test('reload picks up tools from project .zy/tools/ directory', async () => {
      const env = setupTempTool('ReloadTestTool1')
      try {
        const result = await reloadExternalTools(env.tmpDir)
        expect(result.total).toBeGreaterThanOrEqual(1)
        expect(result.added).toContain('ReloadTestTool1')
        expect(result.removed).toHaveLength(0)

        // 工具在 getAllBaseTools() 中只出现一次
        const tools = getAllBaseTools().filter((t) => t.name === 'ReloadTestTool1')
        expect(tools).toHaveLength(1)
      } finally {
        env.cleanup()
      }
    })

    test('repeated reloads do not duplicate tools in registry', async () => {
      const env = setupTempTool('ReloadDupTest')
      try {
        // 第 1 次加载
        await reloadExternalTools(env.tmpDir)
        expect(getAllBaseTools().filter((t) => t.name === 'ReloadDupTest')).toHaveLength(1)

        // 第 2 次 reload
        const r2 = await reloadExternalTools(env.tmpDir)
        expect(r2.added).not.toContain('ReloadDupTest') // 未报告新增
        expect(r2.removed).not.toContain('ReloadDupTest') // 未报告移除
        expect(getAllBaseTools().filter((t) => t.name === 'ReloadDupTest')).toHaveLength(1)

        // 第 3 次 reload —— 仍然只有 1 个
        await reloadExternalTools(env.tmpDir)
        expect(getAllBaseTools().filter((t) => t.name === 'ReloadDupTest')).toHaveLength(1)

        // 第 4 次 reload —— 仍然只有 1 个（防膨胀验证）
        await reloadExternalTools(env.tmpDir)
        expect(getAllBaseTools().filter((t) => t.name === 'ReloadDupTest')).toHaveLength(1)
      } finally {
        env.cleanup()
      }
    })

    test('clearExternalToolState makes old tools inactive', async () => {
      const env = setupTempTool('ReloadInactiveTest')
      try {
        await reloadExternalTools(env.tmpDir)
        expect(hasExternalToolOverride('ReloadInactiveTest')).toBe(true)

        // 清空状态后，旧工具应失效
        clearExternalToolState()
        expect(hasExternalToolOverride('ReloadInactiveTest')).toBe(false)

        // getAllBaseTools 不应包含失效的外部工具
        const tools = getAllBaseTools().filter((t) => t.name === 'ReloadInactiveTest')
        expect(tools).toHaveLength(0)
      } finally {
        env.cleanup()
      }
    })

    test('adding tool between reloads is detected as added', async () => {
      const env = setupTempTool('ReloadAddTest_A')
      try {
        // 先加载只有 A 的版本
        await reloadExternalTools(env.tmpDir)
        expect(getAllBaseTools().filter((t) => t.name === 'ReloadAddTest_A')).toHaveLength(1)

        // 添加 B 工具文件
        writeFileSync(
          join(env.toolsDir, 'ReloadAddTest_B.ts'),
          `
export default {
  name: 'ReloadAddTest_B',
  description: 'Second test tool',
  inputSchema: { type: 'object', properties: {}, required: [] },
  call: async () => 'ok',
}
`,
        )

        const result = await reloadExternalTools(env.tmpDir)
        expect(result.added).toContain('ReloadAddTest_B')
        expect(result.removed).toHaveLength(0)

        expect(getAllBaseTools().filter((t) => t.name === 'ReloadAddTest_A')).toHaveLength(1)
        expect(getAllBaseTools().filter((t) => t.name === 'ReloadAddTest_B')).toHaveLength(1)
      } finally {
        env.cleanup()
      }
    })

    test('removing tool between reloads is detected as removed', async () => {
      const env = setupTempTool('ReloadRemoveTest')
      const toolFile = join(env.toolsDir, 'ReloadRemoveTest.ts')
      try {
        await reloadExternalTools(env.tmpDir)
        expect(hasExternalToolOverride('ReloadRemoveTest')).toBe(true)

        // 删除工具文件
        rmSync(toolFile)

        const result = await reloadExternalTools(env.tmpDir)
        expect(result.removed).toContain('ReloadRemoveTest')
        expect(result.added).toHaveLength(0)

        // 验证覆盖检测也更新了
        expect(hasExternalToolOverride('ReloadRemoveTest')).toBe(false)
      } finally {
        env.cleanup()
      }
    })
  })
})
