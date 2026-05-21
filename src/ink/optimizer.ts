import type { Diff } from './frame.js'

/**
 * 在单次遍历中应用所有优化规则来优化 diff。
 * 这减少了需要写入终端的 patch 数量。
 *
 * 应用的规则：
 * - 移除空的 stdout patch
 * - 合并连续的 cursorMove patch
 * - 移除无意义的 cursorMove (0,0) patch
 * - 拼接相邻的样式 patch（transition diff — 两者都不能丢弃）
 * - 去重连续相同 URI 的 hyperlink
 * - 抵消 cursor hide/show 配对
 * - 移除 count 为 0 的 clear patch
 */
export function optimize(diff: Diff): Diff {
  if (diff.length <= 1) {
    return diff
  }

  const result: Diff = []
  let len = 0

  for (const patch of diff) {
    const type = patch.type

    // 跳过无操作
    if (type === 'stdout') {
      if (patch.content === '') {
        continue
      }
    } else if (type === 'cursorMove') {
      if (patch.x === 0 && patch.y === 0) {
        continue
      }
    } else if (type === 'clear') {
      if (patch.count === 0) {
        continue
      }
    }

    // 尝试与前一个 patch 合并
    if (len > 0) {
      const lastIdx = len - 1
      const last = result[lastIdx]!
      const lastType = last.type

      // 合并连续的 cursorMove
      if (type === 'cursorMove' && lastType === 'cursorMove') {
        result[lastIdx] = {
          type: 'cursorMove',
          x: last.x + patch.x,
          y: last.y + patch.y,
        }
        continue
      }

      // 折叠连续的 cursorTo（只有最后一个有效）
      if (type === 'cursorTo' && lastType === 'cursorTo') {
        result[lastIdx] = patch
        continue
      }

      // 拼接相邻的样式 patch。styleStr 是 transition diff
      //（由 diffAnsiCodes(from, to) 计算），不是 setter —— 仅当
      // 第一个 patch 的撤销码是第二个的子集时才能安全丢弃第一个，
      // 但这并不保证。例如 [\e[49m, \e[2m]：丢弃背景重置
      // 会通过 BCE 泄漏到下一个 \e[2J/\e[2K。
      if (type === 'styleStr' && lastType === 'styleStr') {
        result[lastIdx] = { type: 'styleStr', str: last.str + patch.str }
        continue
      }

      // 去重 hyperlink
      if (type === 'hyperlink' && lastType === 'hyperlink' && patch.uri === last.uri) {
        continue
      }

      // 抵消 cursor hide/show 配对
      if (
        (type === 'cursorShow' && lastType === 'cursorHide') ||
        (type === 'cursorHide' && lastType === 'cursorShow')
      ) {
        result.pop()
        len--
        continue
      }
    }

    result.push(patch)
    len++
  }

  return result
}
