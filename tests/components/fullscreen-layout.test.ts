import { describe, expect, test } from 'bun:test'
import { shouldShowNewMessagesPill } from '../../src/components/FullscreenLayout.js'

describe('FullscreenLayout 跳到底部按钮', () => {
  test('已经处于 sticky 底部时隐藏', () => {
    expect(
      shouldShowNewMessagesPill({
        isSticky: true,
        scrollTop: 80,
        pendingDelta: 0,
        viewportHeight: 20,
        scrollHeight: 100,
        dividerY: 120,
      }),
    ).toBeFalse()
  })

  test('内容高度回落后已到实际底部时忽略过期 divider 快照', () => {
    expect(
      shouldShowNewMessagesPill({
        isSticky: false,
        scrollTop: 80,
        pendingDelta: 0,
        viewportHeight: 20,
        scrollHeight: 100,
        dividerY: 120,
      }),
    ).toBeFalse()
  })

  test('确实位于当前底部和未读分割线之前时显示', () => {
    expect(
      shouldShowNewMessagesPill({
        isSticky: false,
        scrollTop: 50,
        pendingDelta: 0,
        viewportHeight: 20,
        scrollHeight: 120,
        dividerY: 100,
      }),
    ).toBeTrue()
  })

  test('视口已经越过未读分割线时隐藏', () => {
    expect(
      shouldShowNewMessagesPill({
        isSticky: false,
        scrollTop: 85,
        pendingDelta: 0,
        viewportHeight: 20,
        scrollHeight: 120,
        dividerY: 100,
      }),
    ).toBeFalse()
  })
})
