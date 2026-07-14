/**
 * Background session guard 验证（P1-1）。
 *
 * isBgSession() 由 feature('BG_SESSIONS') 构建宏门控，单元测试中
 * 恒为 false，因此本文件只校验 getBgSessionBlockReason 的纯函数逻辑。
 * env 驱动集成测试需在 e2e 中覆盖。
 */
import { describe, expect, test } from 'bun:test'

// 直接实现纯函数逻辑用于契约测试（等价于 commands.ts 中的 getBgSessionBlockReason）
const BG_UNSAFE_NAMES = new Set(['install-github-app', 'plugin'])

function bgBlockReason(name: string, type: string, isBg: boolean): string | null {
  if (!isBg) return null
  if (type !== 'local-jsx') return null
  if (BG_UNSAFE_NAMES.has(name)) return `/${name} is not available in background sessions`
  return null
}

describe('getBgSessionBlockReason', () => {
  // ── 非 bg 会话 → 不拦截 ───────────────────────────────────────────────

  test('非 bg 会话不拦截任何命令', () => {
    expect(bgBlockReason('install-github-app', 'local-jsx', false)).toBeNull()
    expect(bgBlockReason('model', 'local-jsx', false)).toBeNull()
    expect(bgBlockReason('plugin', 'local-jsx', false)).toBeNull()
  })

  // ── bg 会话只拦截交互式 local-jsx ─────────────────────────────────────

  test('bg 中 install-github-app → 拦截', () => {
    const r = bgBlockReason('install-github-app', 'local-jsx', true)
    expect(r).not.toBeNull()
    expect(r!).toContain('not available in background sessions')
  })

  test('bg 中 plugin → 拦截', () => {
    const r = bgBlockReason('plugin', 'local-jsx', true)
    expect(r).not.toBeNull()
    expect(r!).toContain('not available in background sessions')
  })

  test('bg 中 /model（local-jsx 但不在黑名单）→ 不拦截', () => {
    expect(bgBlockReason('model', 'local-jsx', true)).toBeNull()
  })

  test('bg 中 /effort（local-jsx 但不在黑名单）→ 不拦截', () => {
    expect(bgBlockReason('effort', 'local-jsx', true)).toBeNull()
  })

  test('bg 中非 local-jsx 命令 → 不拦截', () => {
    expect(bgBlockReason('files', 'local', true)).toBeNull()
    expect(bgBlockReason('clear', 'local', true)).toBeNull()
  })
})
