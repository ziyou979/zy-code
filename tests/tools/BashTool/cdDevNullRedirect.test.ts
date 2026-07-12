/**
 * cd + 仅 /dev/null 重定向不要求审批（CC 2.1.207）
 *
 * 通过复制 validateOutputRedirections 的决策逻辑做契约测试：
 * compoundCommandHasCd 且 redirections 全为 /dev/null → 不拦截。
 */
import { describe, expect, test } from 'bun:test'

function shouldAskForCdWithRedirections(
  compoundCommandHasCd: boolean,
  redirections: Array<{ target: string }>,
): boolean {
  if (!compoundCommandHasCd || redirections.length === 0) {
    return false
  }
  const onlyDevNull = redirections.every((r) => r.target === '/dev/null')
  return !onlyDevNull
}

describe('cd + redirect 审批策略', () => {
  test('仅 /dev/null 不要求审批', () => {
    expect(
      shouldAskForCdWithRedirections(true, [{ target: '/dev/null' }, { target: '/dev/null' }]),
    ).toBe(false)
  })

  test('写真实文件仍要求审批', () => {
    expect(
      shouldAskForCdWithRedirections(true, [{ target: '/dev/null' }, { target: 'out.txt' }]),
    ).toBe(true)
  })

  test('无 cd 不因 redirect 触发本守卫', () => {
    expect(shouldAskForCdWithRedirections(false, [{ target: 'out.txt' }])).toBe(false)
  })
})
