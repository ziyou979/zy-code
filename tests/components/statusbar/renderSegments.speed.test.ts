/**
 * statusline speed 模块：ttftSymbol 配置（TTFT 前缀符号，默认 '' 不显示，
 * 「首token」文案已自解释，符号为可选装饰）。tok/s 部分不受该字段影响。
 */
import { describe, expect, test } from 'bun:test'
import {
  renderStatusbarSegments,
  type StatusbarContext,
} from '../../../src/components/statusbar/renderSegments.js'
import type { ModuleConfig } from '../../../src/components/statusbar/statusbarModuleDefaults.js'
import { TAU } from '../../../src/constants/figures.js'
import { tSync } from '../../../src/i18n/index.js'

const TTFT_LABEL = tSync('statusline.ttft')

function speedModule(overrides?: Partial<ModuleConfig>): ModuleConfig {
  return { id: 'speed', visible: true, icon: '', color: 'text', ...overrides }
}

function ctxOf(overrides?: Partial<StatusbarContext>): StatusbarContext {
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

function renderText(module: ModuleConfig, ctx: StatusbarContext): string {
  const segs = renderStatusbarSegments([module], ctx)
  if (segs.length !== 1) {
    throw new Error(`expected exactly 1 segment, got ${segs.length}`)
  }
  return segs[0]!.text
}

describe('statusline speed segment ttftSymbol', () => {
  test('默认不显示符号（<10s 保留一位小数）', () => {
    expect(renderText(speedModule(), ctxOf({ avgTTFTMs: 800 }))).toBe(`${TTFT_LABEL} 0.8s`)
  })

  test("ttftSymbol:'τ' 显式选择时显示前缀", () => {
    expect(renderText(speedModule({ ttftSymbol: TAU }), ctxOf({ avgTTFTMs: 800 }))).toBe(
      `${TAU} ${TTFT_LABEL} 0.8s`,
    )
  })

  test("ttftSymbol:'→' 时替换前缀", () => {
    expect(renderText(speedModule({ ttftSymbol: '→' }), ctxOf({ avgTTFTMs: 800 }))).toBe(
      `→ ${TTFT_LABEL} 0.8s`,
    )
  })

  test("ttftSymbol:'' 时不显示符号", () => {
    expect(renderText(speedModule({ ttftSymbol: '' }), ctxOf({ avgTTFTMs: 800 }))).toBe(
      `${TTFT_LABEL} 0.8s`,
    )
  })

  test('≥10s 回退整秒显示', () => {
    expect(renderText(speedModule({ ttftSymbol: TAU }), ctxOf({ avgTTFTMs: 12_345 }))).toBe(
      `${TAU} ${TTFT_LABEL} 12s`,
    )
  })

  test('tok/s 部分不受 ttftSymbol 影响', () => {
    expect(renderText(speedModule({ ttftSymbol: '' }), ctxOf({ tokensPerSecond: 42 }))).toBe(
      '» 42 tok/s',
    )
  })

  test('两者齐全时用双空格拼接', () => {
    expect(
      renderText(speedModule({ ttftSymbol: 't' }), ctxOf({ tokensPerSecond: 42, avgTTFTMs: 800 })),
    ).toBe(`» 42 tok/s  t ${TTFT_LABEL} 0.8s`)
  })

  test('无数据时整段不显示', () => {
    const segs = renderStatusbarSegments([speedModule()], ctxOf())
    expect(segs).toHaveLength(0)
  })
})
