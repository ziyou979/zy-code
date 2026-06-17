/**
 * 3.4 hook 输出超阈值落盘 —— maybeSpillHookOutput。
 *
 * 超过 inline 阈值时写盘并返回三段式提示（大小+路径+预览）；不超过时原样 inline。
 * ZY_CODE_HOOK_OUTPUT_INLINE_LIMIT 覆盖默认 50000。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tmpRoot: string

// spread 真实模块再覆盖单个导出：避免与并发运行的其他测试文件共享 mock 注册表时
// 因部分 mock 缺失导出而触发 "export not found"（参见 queryEngineHarness 的同款做法）。
async function setupMocks() {
  const state = await import('../../../src/bootstrap/state.js')
  mock.module('../../../src/bootstrap/state.js', () => ({
    ...state,
    getSessionId: () => 'sess-test',
  }))
  const envUtils = await import('../../../src/utils/envUtils.js')
  mock.module('../../../src/utils/envUtils.js', () => ({
    ...envUtils,
    getZyConfigHomeDir: () => tmpRoot,
  }))
}

describe('3.4 maybeSpillHookOutput', () => {
  beforeEach(async () => {
    delete process.env.ZY_CODE_HOOK_OUTPUT_INLINE_LIMIT
    tmpRoot = mkdtempSync(join(tmpdir(), 'zy-spill-'))
    await setupMocks()
  })
  afterEach(() => {
    mock.restore()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  test('未超阈值：全部 inline，不落盘', async () => {
    const { maybeSpillHookOutput } = await import('../../../src/utils/hooks/spillOutput.js')
    const out = maybeSpillHookOutput('PreToolUse:Bash', 'x'.repeat(50_000))
    expect(out.spillPath).toBeUndefined()
    expect(out.inline.length).toBe(50_000)
    expect(existsSync(join(tmpRoot, 'hook-outputs', 'sess-test'))).toBe(false)
  })

  test('超阈值：落盘 + inline 只剩预览和路径', async () => {
    const { maybeSpillHookOutput } = await import('../../../src/utils/hooks/spillOutput.js')
    const big = 'y'.repeat(50_001)
    const out = maybeSpillHookOutput('PreToolUse:Bash', big)
    expect(out.spillPath).toBeDefined()
    expect(existsSync(out.spillPath!)).toBe(true)
    // 落盘文件含完整内容
    expect(readFileSync(out.spillPath!, 'utf8').length).toBe(50_001)
    // inline 远小于原始，含大小与路径
    expect(out.inline.length).toBeLessThan(3_000)
    expect(out.inline).toContain('Output too large (50001 chars)')
    expect(out.inline).toContain(out.spillPath!)
    expect(out.inline).toContain('Preview (first 2000 chars)')
    // hookName 的 ':' 被清洗为安全文件名片段
    expect(out.spillPath!).toContain('PreToolUse_Bash-')
  })

  test('ZY_CODE_HOOK_OUTPUT_INLINE_LIMIT 覆盖阈值', async () => {
    process.env.ZY_CODE_HOOK_OUTPUT_INLINE_LIMIT = '10'
    const { maybeSpillHookOutput } = await import('../../../src/utils/hooks/spillOutput.js')
    const out = maybeSpillHookOutput('Stop', 'z'.repeat(11))
    expect(out.spillPath).toBeDefined()
    expect(existsSync(out.spillPath!)).toBe(true)
  })
})
