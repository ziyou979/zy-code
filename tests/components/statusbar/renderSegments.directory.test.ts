/**
 * statusline directory 模块：pathMode 配置（'name' 项目名 / 'full' 全路径）。
 * 默认 'name' 与历史行为一致；'full' 显示 getCwd() 原样路径。
 */
import { describe, expect, test } from 'bun:test'
import {
  renderStatusbarSegments,
  type StatusbarContext,
} from '../../../src/components/statusbar/renderSegments.js'
import type { ModuleConfig } from '../../../src/components/statusbar/statusbarModuleDefaults.js'
import { runWithCwdOverride } from '../../../src/services/environment/cwd.js'
import { FORK_GLYPH } from '../../../src/constants/figures.js'

const FIXED_CWD = '/proj/root/my-app'

function directoryModule(overrides?: Partial<ModuleConfig>): ModuleConfig {
  return { id: 'directory', visible: true, icon: '▸', color: 'text', ...overrides }
}

function baseCtx(overrides?: Partial<StatusbarContext>): StatusbarContext {
  return {
    messages: [],
    mainLoopModel: 'claude-sonnet-4-5' as never,
    effortValue: undefined,
    thinkingEnabled: false,
    branch: null,
    gitClean: null,
    memoryRss: 0,
    tokensPerSecond: null,
    avgTTFTMs: null,
    ...overrides,
  }
}

/** 在钉死的 cwd 下渲染并返回段文本。 */
function renderText(module: ModuleConfig, ctx?: StatusbarContext): string {
  return runWithCwdOverride(FIXED_CWD, () => {
    const segs = renderStatusbarSegments([module], ctx ?? baseCtx())
    if (segs.length !== 1) {
      throw new Error(`expected exactly 1 segment, got ${segs.length}`)
    }
    return segs[0]!.text
  })
}

describe('statusline directory segment', () => {
  test('默认（无 pathMode 字段）显示项目名', () => {
    expect(renderText(directoryModule())).toBe('▸ my-app')
  })

  test("pathMode:'name' 显式指定时同样显示项目名", () => {
    expect(renderText(directoryModule({ pathMode: 'name' }))).toBe('▸ my-app')
  })

  test("pathMode:'full' 显示 cwd 全路径", () => {
    expect(renderText(directoryModule({ pathMode: 'full' }))).toBe(`▸ ${FIXED_CWD}`)
  })

  test('git 分支后缀在两种模式下拼接一致', () => {
    const ctx = baseCtx({ branch: 'main', gitClean: true })
    expect(renderText(directoryModule({ pathMode: 'name' }), ctx)).toBe(
      `▸ my-app · ${FORK_GLYPH} main ✓`,
    )
    expect(renderText(directoryModule({ pathMode: 'full' }), ctx)).toBe(
      `▸ ${FIXED_CWD} · ${FORK_GLYPH} main ✓`,
    )
  })

  test('无 icon 时不显示前缀（与既有 withIcon 行为一致）', () => {
    expect(renderText(directoryModule({ icon: '', pathMode: 'full' }))).toBe(FIXED_CWD)
  })
})
