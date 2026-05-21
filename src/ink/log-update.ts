import { type AnsiCode, ansiCodesToString, diffAnsiCodes } from '@alcalzone/ansi-tokenize'
import { logForDebugging } from '../utils/debug.js'
import type { Diff, FlickerReason, Frame } from './frame.js'
import type { Point } from './layout/geometry.js'
import {
  type Cell,
  CellWidth,
  cellAt,
  charInCellAt,
  diffEach,
  type Hyperlink,
  isEmptyCellAt,
  type Screen,
  type StylePool,
  shiftRows,
  visibleCellAtIndex,
} from './screen.js'
import {
  CURSOR_HOME,
  scrollDown as csiScrollDown,
  scrollUp as csiScrollUp,
  RESET_SCROLL_REGION,
  setScrollRegion,
} from './termio/csi.js'
import { LINK_END, link as oscLink } from './termio/osc.js'

type State = {
  previousOutput: string
}

type Options = {
  isTTY: boolean
  stylePool: StylePool
}

const CARRIAGE_RETURN = { type: 'carriageReturn' } as const
const NEWLINE = { type: 'stdout', content: '\n' } as const

export class LogUpdate {
  private state: State

  constructor(private readonly options: Options) {
    this.state = {
      previousOutput: '',
    }
  }

  renderPreviousOutput_DEPRECATED(prevFrame: Frame): Diff {
    if (!this.options.isTTY) {
      // 非 TTY 输出不再支持（字符串输出已被移除）
      return [NEWLINE]
    }
    return this.getRenderOpsForDone(prevFrame)
  }

  // 进程从挂起状态恢复（SIGCONT）时调用，防止覆盖终端内容
  reset(): void {
    this.state.previousOutput = ''
  }

  private renderFullFrame(frame: Frame): Diff {
    const { screen } = frame
    const lines: string[] = []
    let currentStyles: AnsiCode[] = []
    let currentHyperlink: Hyperlink
    for (let y = 0; y < screen.height; y++) {
      let line = ''
      for (let x = 0; x < screen.width; x++) {
        const cell = cellAt(screen, x, y)
        if (cell && cell.width !== CellWidth.SpacerTail) {
          // 处理超链接状态切换
          if (cell.hyperlink !== currentHyperlink) {
            if (currentHyperlink !== undefined) {
              line += LINK_END
            }
            if (cell.hyperlink !== undefined) {
              line += oscLink(cell.hyperlink)
            }
            currentHyperlink = cell.hyperlink
          }
          const cellStyles = this.options.stylePool.get(cell.styleId)
          const styleDiff = diffAnsiCodes(currentStyles, cellStyles)
          if (styleDiff.length > 0) {
            line += ansiCodesToString(styleDiff)
            currentStyles = cellStyles
          }
          line += cell.char
        }
      }
      // 在重置样式前关闭所有打开的超链接
      if (currentHyperlink !== undefined) {
        line += LINK_END
        currentHyperlink = undefined
      }
      // 在行尾重置样式，防止 trimEnd 残留控制码
      const resetCodes = diffAnsiCodes(currentStyles, [])
      if (resetCodes.length > 0) {
        line += ansiCodesToString(resetCodes)
        currentStyles = []
      }
      lines.push(line.trimEnd())
    }

    if (lines.length === 0) {
      return []
    }
    return [{ type: 'stdout', content: lines.join('\n') }]
  }

  private getRenderOpsForDone(prev: Frame): Diff {
    this.state.previousOutput = ''

    if (!prev.cursor.visible) {
      return [{ type: 'cursorShow' }]
    }
    return []
  }

  render(prev: Frame, next: Frame, altScreen = false, decstbmSafe = true): Diff {
    if (!this.options.isTTY) {
      return this.renderFullFrame(next)
    }

    const startTime = performance.now()
    const stylePool = this.options.stylePool

    // 由于我们假设光标位于屏幕底部，因此仅在视口变矮（即光标位置偏移）
    // 或变窄（导致文本换行）时才需要清屏。我们本可以想办法避免在此重置，
    // 但这需要预测视口变化后的布局，意味着要计算文本换行。
    // 窗口大小调整是相对少见的操作，因此实际上不是大问题。
    if (
      next.viewport.height < prev.viewport.height ||
      (prev.viewport.width !== 0 && next.viewport.width !== prev.viewport.width)
    ) {
      return fullResetSequence_CAUSES_FLICKER(next, 'resize', stylePool)
    }

    // DECSTBM 滚动优化：当 ScrollBox 的 scrollTop 变化时，
    // 使用硬件滚动（CSI top;bot r + CSI n S/T）而非重写整个滚动区域来移动内容。
    // 对 prev.screen 执行 shiftRows 模拟内容移位，这样下方的 diff 循环
    // 自然会将仅新滚入的行识别为差异。prev.screen 即将成为 backFrame
    // （供下次渲染复用），因此直接修改是安全的。
    // RESET_SCROLL_REGION 后的 CURSOR_HOME 是防御性措施 —— 规范规定 DECSTBM
    // 重置会将光标归位，但各终端实现存在差异。
    //
    // decstbmSafe：当 DECSTBM→diff 序列无法保证原子性时调用方传入 false
    // （即没有 DEC 2026 / BSU/ESU）。缺乏原子性时，外部终端会渲染中间状态
    // —— 区域已滚动但边缘行尚未绘制 —— 导致每次 scrollTop 移动时出现可见的
    // 垂直跳动。回退到 diff 循环会写出所有移位的行：字节更多，但无中间状态。
    // render-node-to-output 的 blit+shift 生成的 next.screen 无论如何都是正确的。
    let scrollPatch: Diff = []
    if (altScreen && next.scrollHint && decstbmSafe) {
      const { top, bottom, delta } = next.scrollHint
      if (top >= 0 && bottom < prev.screen.height && bottom < next.screen.height) {
        shiftRows(prev.screen, top, bottom, delta)
        scrollPatch = [
          {
            type: 'stdout',
            content:
              setScrollRegion(top + 1, bottom + 1) +
              (delta > 0 ? csiScrollUp(delta) : csiScrollDown(-delta)) +
              RESET_SCROLL_REGION +
              CURSOR_HOME,
          },
        ]
      }
    }

    // 我们必须使用纯相对操作来操纵光标，因为我们不知道它的起始位置。
    //
    // 当内容高度 >= 视口高度 且光标位于底部时，
    // 上一帧末尾的光标恢复操作会导致终端滚动。
    // viewportY 告诉我们内容溢出后有多少行进入了回滚区。
    // 此外，光标恢复时的滚动还会再将 1 行推入回滚区。
    // 如果要对已进入回滚区的行做任何改动，就需要 fullReset。
    //
    // 这个早期的 full-reset 检查仅适用于"稳态"（非增长场景）。
    // 对于增长场景，下方的 viewportY 计算（含 cursorRestoreScroll）
    // 会在 diff 循环中捕捉到那些无法触及的回滚行。
    const cursorAtBottom = prev.cursor.y >= prev.screen.height
    const isGrowing = next.screen.height > prev.screen.height
    // 当内容恰好填满视口（height == viewport）且光标位于底部时，
    // 上一帧末尾的光标恢复 LF 已将 1 行滚动到回滚区。使用 >= 来覆盖此情况。
    const prevHadScrollback = cursorAtBottom && prev.screen.height >= prev.viewport.height
    const isShrinking = next.screen.height < prev.screen.height
    const nextFitsViewport = next.screen.height <= prev.viewport.height

    // 当从视口上方缩小到视口内或以下时，原本在回滚区的内容现在应该可见。
    // 终端清除操作无法将回滚区内容拉入可视区域，因此需要完整重置。
    // 使用 <=（而非 <）是因为即使下一个高度等于视口高度，
    // 前一次渲染的回滚深度与全新渲染也不同。
    if (prevHadScrollback && nextFitsViewport && isShrinking) {
      logForDebugging(
        `Full reset (shrink->below): prevHeight=${prev.screen.height}, nextHeight=${next.screen.height}, viewport=${prev.viewport.height}`,
      )
      return fullResetSequence_CAUSES_FLICKER(next, 'offscreen', stylePool)
    }

    if (
      prev.screen.height >= prev.viewport.height &&
      prev.screen.height > 0 &&
      cursorAtBottom &&
      !isGrowing
    ) {
      // viewportY = 内容溢出导致进入回滚区的行数
      // +1 是光标恢复滚动推入的那一行
      const viewportY = prev.screen.height - prev.viewport.height
      const scrollbackRows = viewportY + 1

      let scrollbackChangeY = -1
      diffEach(prev.screen, next.screen, (_x, y) => {
        if (y < scrollbackRows) {
          scrollbackChangeY = y
          return true // early exit
        }
      })
      if (scrollbackChangeY >= 0) {
        const prevLine = readLine(prev.screen, scrollbackChangeY)
        const nextLine = readLine(next.screen, scrollbackChangeY)
        return fullResetSequence_CAUSES_FLICKER(next, 'offscreen', stylePool, {
          triggerY: scrollbackChangeY,
          prevLine,
          nextLine,
        })
      }
    }

    const screen = new VirtualScreen(prev.cursor, next.viewport.width)

    // 将空屏幕视为高度 1，避免首次渲染时出现误调整
    const heightDelta = Math.max(next.screen.height, 1) - Math.max(prev.screen.height, 1)
    const shrinking = heightDelta < 0
    const growing = heightDelta > 0

    // 处理缩小：从底部清除行
    if (shrinking) {
      const linesToClear = prev.screen.height - next.screen.height

      // eraseLines 仅在视口内有效 —— 无法清除回滚区。
      // 如果需要清除的行数超出视口容量，说明有些行在回滚区中，需要完整重置。
      if (linesToClear > prev.viewport.height) {
        return fullResetSequence_CAUSES_FLICKER(next, 'offscreen', this.options.stylePool)
      }

      // eraseLines(n) 从当前光标位置向上擦除 n 行。diff 循环结束后光标可能
      // 位于任意位置（在最后一个被改动的单元格处）。如果光标不在底部行，
      // eraseLines 会清除错误的行 —— 导致光标与旧屏幕底部之间残留旧内容。
      // 这在流式响应缩小时表现为"下方旧内容 lingering"（例如被中断的 AI 输出）。
      //
      // 修复：在擦除前将光标移到 prevHeight-1（旧屏幕的底部行），
      // 确保 eraseLines 始终从实际底部开始清除。
      const prevHeight = prev.screen.height

      // 将光标移到旧屏幕的底部行
      screen.txn((prev) => {
        const dy = prevHeight - 1 - prev.y
        if (dy !== 0 || prev.x !== 0) {
          return [[CARRIAGE_RETURN, { type: 'cursorMove', x: 0, y: dy }], { dx: -prev.x, dy }]
        }
        return [[], { dx: 0, dy: 0 }]
      })

      // clear(N) 从光标位置向上擦除 N 行（光标上移 N-1）。
      // 擦除后，光标位于 (prevHeight-1) - (N-1) = nextHeight 行。
      // 然后再下移 1 行到达 nextHeight-1（新屏幕的底部）。
      screen.txn(() => [
        [
          { type: 'clear', count: linesToClear },
          { type: 'cursorMove', x: 0, y: -1 },
        ],
        { dx: 0, dy: -linesToClear },
      ])
    }

    // viewportY = 回滚区中的行数（终端上不可见）。
    // 对于缩小：取 max(prev, next)，因为终端清除操作不会引起滚动。
    // 对于增长：使用 prev 状态，因为新行还未将旧行滚动。
    // 当 prevHadScrollback 为 true 时，加 1 以计入上一帧末尾光标恢复 LF
    // 滚出可视区域的那一行。不加的话，diff 循环会将该行视为可达 —— 但光标
    // 会在视口顶部被截断，导致写入偏移 1 行，输出错乱。
    const cursorRestoreScroll = prevHadScrollback ? 1 : 0
    const viewportY = growing
      ? Math.max(0, prev.screen.height - prev.viewport.height + cursorRestoreScroll)
      : Math.max(prev.screen.height, next.screen.height) -
        next.viewport.height +
        cursorRestoreScroll

    let currentStyleId = stylePool.none
    let currentHyperlink: Hyperlink

    // 第一遍：渲染对已有行的改动（行号 < prev.screen.height）
    let needsFullReset = false
    let resetTriggerY = -1
    diffEach(prev.screen, next.screen, (x, y, removed, added) => {
      // 跳过新行 —— 稍后直接渲染
      if (growing && y >= prev.screen.height) {
        return
      }

      // 渲染时跳过占位符，因为终端在写入宽字符时会自动前进 2 列。
      // SpacerTail: 宽字符的第二个单元格
      // SpacerHead: 标记宽字符换行到下一行时的行末位置
      if (added && (added.width === CellWidth.SpacerTail || added.width === CellWidth.SpacerHead)) {
        return
      }

      if (
        removed &&
        (removed.width === CellWidth.SpacerTail || removed.width === CellWidth.SpacerHead) &&
        !added
      ) {
        return
      }

      // 跳过不需要覆盖已有内容的空白单元格。
      // 这避免了在屏幕边缘写入尾部空格导致不必要的换行。
      // 使用 isEmptyCellAt 检查 packed words 是否都为零（空白单元格）。
      if (added && isEmptyCellAt(next.screen, x, y) && !removed) {
        return
      }

      // 如果视口范围外的单元格发生了改动，需要重置，
      // 因为我们无法将光标移到那里去绘制。
      if (y < viewportY) {
        needsFullReset = true
        resetTriggerY = y
        return true // early exit
      }

      moveCursorTo(screen, x, y)

      if (added) {
        const targetHyperlink = added.hyperlink
        currentHyperlink = transitionHyperlink(screen.diff, currentHyperlink, targetHyperlink)
        const styleStr = stylePool.transition(currentStyleId, added.styleId)
        if (writeCellWithStyleStr(screen, added, styleStr)) {
          currentStyleId = added.styleId
        }
      } else if (removed) {
        // 单元格已被移除 —— 用空格清除
        // （用于处理内容缩小的情况）
        // 先重置活跃样式和超链接，避免泄漏到已清除的单元格
        const styleIdToReset = currentStyleId
        const hyperlinkToReset = currentHyperlink
        currentStyleId = stylePool.none
        currentHyperlink = undefined

        screen.txn(() => {
          const patches: Diff = []
          transitionStyle(patches, stylePool, styleIdToReset, stylePool.none)
          transitionHyperlink(patches, hyperlinkToReset, undefined)
          patches.push({ type: 'stdout', content: ' ' })
          return [patches, { dx: 1, dy: 0 }]
        })
      }
    })
    if (needsFullReset) {
      return fullResetSequence_CAUSES_FLICKER(next, 'offscreen', stylePool, {
        triggerY: resetTriggerY,
        prevLine: readLine(prev.screen, resetTriggerY),
        nextLine: readLine(next.screen, resetTriggerY),
      })
    }

    // 渲染新行前重置样式（新行会自行设置样式）
    currentStyleId = transitionStyle(screen.diff, stylePool, currentStyleId, stylePool.none)
    currentHyperlink = transitionHyperlink(screen.diff, currentHyperlink, undefined)

    // 处理增长：直接渲染新行（它们会自然引起终端滚动）
    if (growing) {
      renderFrameSlice(screen, next, prev.screen.height, next.screen.height, stylePool)
    }

    // 恢复光标。在 alt-screen 中跳过：光标是隐藏的，其位置
    // 仅作为下一帧相对移动的起点，而在 alt-screen 中下一帧总是以
    // CSI H 开头（见 ink.tsx onRender），无论当前在哪都会重置到 (0,0)。
    // 这样每帧节省一次 CR + cursorMove 往返（约 6-10 字节）。
    //
    // 主屏幕：如果光标需要在最后一行内容之后（常见情况：cursor.y = screen.height），
    // 则发出 \n 来创建该行，因为光标移动无法创建新行。
    if (altScreen) {
      // 无操作；下一帧的 CSI H 会锚定光标
    } else if (next.cursor.y >= next.screen.height) {
      // 移动到当前行的第 0 列，然后发出换行符到达目标行
      screen.txn((prev) => {
        const rowsToCreate = next.cursor.y - prev.y
        if (rowsToCreate > 0) {
          // 使用 CR 解决待处理的换行（如果有），而不会前进到下一行，
          // 然后用 LF 创建每个新行。
          const patches: Diff = new Array<Diff[number]>(1 + rowsToCreate)
          patches[0] = CARRIAGE_RETURN
          for (let i = 0; i < rowsToCreate; i++) {
            patches[1 + i] = NEWLINE
          }
          return [patches, { dx: -prev.x, dy: rowsToCreate }]
        }
        // 已在目标行或超过目标行 —— 需要将光标移到正确位置
        const dy = next.cursor.y - prev.y
        if (dy !== 0 || prev.x !== next.cursor.x) {
          // 使用 CR 清除待处理换行（如果有），然后移动光标
          const patches: Diff = [CARRIAGE_RETURN]
          patches.push({ type: 'cursorMove', x: next.cursor.x, y: dy })
          return [patches, { dx: next.cursor.x - prev.x, dy }]
        }
        return [[], { dx: 0, dy: 0 }]
      })
    } else {
      moveCursorTo(screen, next.cursor.x, next.cursor.y)
    }

    const elapsed = performance.now() - startTime
    if (elapsed > 50) {
      const damage = next.screen.damage
      const damageInfo = damage
        ? `${damage.width}x${damage.height} at (${damage.x},${damage.y})`
        : 'none'
      logForDebugging(
        `Slow render: ${elapsed.toFixed(1)}ms, screen: ${next.screen.height}x${next.screen.width}, damage: ${damageInfo}, changes: ${screen.diff.length}`,
      )
    }

    return scrollPatch.length > 0 ? [...scrollPatch, ...screen.diff] : screen.diff
  }
}

function transitionHyperlink(diff: Diff, current: Hyperlink, target: Hyperlink): Hyperlink {
  if (current !== target) {
    diff.push({ type: 'hyperlink', uri: target ?? '' })
    return target
  }
  return current
}

function transitionStyle(
  diff: Diff,
  stylePool: StylePool,
  currentId: number,
  targetId: number,
): number {
  const str = stylePool.transition(currentId, targetId)
  if (str.length > 0) {
    diff.push({ type: 'styleStr', str })
  }
  return targetId
}

function readLine(screen: Screen, y: number): string {
  let line = ''
  for (let x = 0; x < screen.width; x++) {
    line += charInCellAt(screen, x, y) ?? ' '
  }
  return line.trimEnd()
}

function fullResetSequence_CAUSES_FLICKER(
  frame: Frame,
  reason: FlickerReason,
  stylePool: StylePool,
  debug?: { triggerY: number; prevLine: string; nextLine: string },
): Diff {
  // clearTerminal 之后，光标位于 (0, 0)
  const screen = new VirtualScreen({ x: 0, y: 0 }, frame.viewport.width)
  renderFrame(screen, frame, stylePool)
  return [{ type: 'clearTerminal', reason, debug }, ...screen.diff]
}

function renderFrame(screen: VirtualScreen, frame: Frame, stylePool: StylePool): void {
  renderFrameSlice(screen, frame, 0, frame.screen.height, stylePool)
}

/**
 * 渲染帧屏幕的行切片。
 * 每行渲染后跟随一个换行符。光标最终位于 (0, endY)。
 */
function renderFrameSlice(
  screen: VirtualScreen,
  frame: Frame,
  startY: number,
  endY: number,
  stylePool: StylePool,
): VirtualScreen {
  let currentStyleId = stylePool.none
  let currentHyperlink: Hyperlink
  // 跟踪此行上最后一个已渲染单元格的 styleId（-1 表示无）。
  // 传给 visibleCellAtIndex 以启用仅前景色的空格优化。
  let lastRenderedStyleId = -1

  const { width: screenWidth, cells, charPool, hyperlinkPool } = frame.screen

  let index = startY * screenWidth
  for (let y = startY; y < endY; y += 1) {
    // 使用 LF（而非 CSI CUD / 光标下移）将光标推进到这一行。
    // CSI CUD 会在视口底部边距处停止且无法滚动，
    // 但 LF 会滚动视口来创建新行。如果不这样做，
    // 当光标位于视口底部时，moveCursorTo 的光标下移会静默失败，
    // 导致虚拟光标与真实终端光标之间产生永久的一行偏差。
    if (screen.cursor.y < y) {
      const rowsToAdvance = y - screen.cursor.y
      screen.txn((prev) => {
        const patches: Diff = new Array<Diff[number]>(1 + rowsToAdvance)
        patches[0] = CARRIAGE_RETURN
        for (let i = 0; i < rowsToAdvance; i++) {
          patches[1 + i] = NEWLINE
        }
        return [patches, { dx: -prev.x, dy: rowsToAdvance }]
      })
    }
    // 每行开始时重置 —— 尚未渲染任何单元格
    lastRenderedStyleId = -1

    for (let x = 0; x < screenWidth; x += 1, index += 1) {
      // 跳过占位符、无样式的空白单元格，以及仅含前景色且样式
      // 与上一个已渲染单元格匹配的空格（因为光标前进会产生相同的
      // 视觉效果）。visibleCellAtIndex 内部处理此优化，避免为跳过的
      // 单元格分配 Cell 对象。
      const cell = visibleCellAtIndex(cells, charPool, hyperlinkPool, index, lastRenderedStyleId)
      if (!cell) {
        continue
      }

      moveCursorTo(screen, x, y)

      // 处理超链接
      const targetHyperlink = cell.hyperlink
      currentHyperlink = transitionHyperlink(screen.diff, currentHyperlink, targetHyperlink)

      // 样式切换 —— 缓存的字符串，预热后零分配
      const styleStr = stylePool.transition(currentStyleId, cell.styleId)
      if (writeCellWithStyleStr(screen, cell, styleStr)) {
        currentStyleId = cell.styleId
        lastRenderedStyleId = cell.styleId
      }
    }
    // 换行前重置样式和超链接，防止背景色在终端滚动时泄漏到下一行。
    // 旧代码通过写入尾部无样式空格隐式重置；现在我们跳过空白单元格，
    // 必须显式重置。
    currentStyleId = transitionStyle(screen.diff, stylePool, currentStyleId, stylePool.none)
    currentHyperlink = transitionHyperlink(screen.diff, currentHyperlink, undefined)
    // 行尾 CR+LF —— \r 回到第 0 列，\n 移动到下一行。
    // 不加 \r 时，终端光标会停留在内容结束处的列（由于我们跳过了
    // 尾部空格，可能停在行中位置）。
    screen.txn((prev) => [[CARRIAGE_RETURN, NEWLINE], { dx: -prev.x, dy: 1 }])
  }

  // 在切片末尾重置所有打开的样式和超链接
  transitionStyle(screen.diff, stylePool, currentStyleId, stylePool.none)
  transitionHyperlink(screen.diff, currentHyperlink, undefined)

  return screen
}

type Delta = { dx: number; dy: number }

/**
 * 使用预序列化的样式切换字符串（来自 StylePool.transition）写入单元格。
 * 内联了 txn 逻辑，避免每个单元格都产生闭包/元组/delta 分配。
 *
 * 返回 true 表示单元格已写入，false 表示被跳过（视口边缘的宽字符）。
 * 调用者必须以返回值作为 currentStyleId 更新的条件 —— 跳过时，
 * styleStr 不会被推送，终端的样式状态也不会改变。如果仍更新虚拟追踪器，
 * 会导致其与终端状态不同步，下一次切换会基于幽灵状态计算。
 */
function writeCellWithStyleStr(screen: VirtualScreen, cell: Cell, styleStr: string): boolean {
  const cellWidth = cell.width === CellWidth.Wide ? 2 : 1
  const px = screen.cursor.x
  const vw = screen.viewportWidth

  // 不要写入会跨越视口边缘的宽字符。
  // 单码点字符（CJK）在 vw-2 处是安全的；多码点字形（国旗、ZWJ emoji）
  // 需要更严格的阈值。
  if (cellWidth === 2 && px < vw) {
    const threshold = cell.char.length > 2 ? vw : vw + 1
    if (px + 2 >= threshold) {
      return false
    }
  }

  const diff = screen.diff
  if (styleStr.length > 0) {
    diff.push({ type: 'styleStr', str: styleStr })
  }

  const needsCompensation = cellWidth === 2 && needsWidthCompensation(cell.char)

  // 在 wcwidth 表较旧的终端上，补偿后的 emoji 只会将光标前进 1 列，
  // 因此下面的 CHA 会跳过第 x+1 列而不绘制它。先在那里写一个带样式的
  // 空格 —— 在正确的终端上，emoji 字形（宽度 2）会无害地覆盖它；
  // 在旧终端上，它会用 emoji 的背景色填充缝隙。同时清除 x+1 处的残留内容。
  // CHA 是 1 基的，所以第 px+1 列（0 基）对应的 CHA 目标是 px+2。
  if (needsCompensation && px + 1 < vw) {
    diff.push({ type: 'cursorTo', col: px + 2 })
    diff.push({ type: 'stdout', content: ' ' })
    diff.push({ type: 'cursorTo', col: px + 1 })
  }

  diff.push({ type: 'stdout', content: cell.char })

  // 在 emoji 之后强制终端光标到达正确列。
  if (needsCompensation) {
    diff.push({ type: 'cursorTo', col: px + cellWidth + 1 })
  }

  // 更新光标 —— 原地修改以避免 Point 分配
  if (px >= vw) {
    screen.cursor.x = cellWidth
    screen.cursor.y++
  } else {
    screen.cursor.x = px + cellWidth
  }
  return true
}

function moveCursorTo(screen: VirtualScreen, targetX: number, targetY: number) {
  screen.txn((prev) => {
    const dx = targetX - prev.x
    const dy = targetY - prev.y
    const inPendingWrap = prev.x >= screen.viewportWidth

    // 如果处于待换行状态（cursor.x >= width），使用 CR
    // 回到当前行的第 0 列而不前进到下一行，然后执行光标移动。
    if (inPendingWrap) {
      return [[CARRIAGE_RETURN, { type: 'cursorMove', x: targetX, y: dy }], { dx, dy }]
    }

    // 移动到不同行时，先用回车符（\r）回到第 0 列，再移动光标。
    if (dy !== 0) {
      return [[CARRIAGE_RETURN, { type: 'cursorMove', x: targetX, y: dy }], { dx, dy }]
    }

    // 同行标准光标移动
    return [[{ type: 'cursorMove', x: dx, y: dy }], { dx, dy }]
  })
}

/**
 * 识别终端 wcwidth 可能与 Unicode 不一致的 emoji。
 * 在使用正确表的终端上，我们发出的 CHA 是无害的无操作。
 *
 * 两类情况：
 * 1. 较新的 emoji（Unicode 12.0+），终端 wcwidth 表中缺失。
 * 2. 默认为文本显示的 emoji + VS16（U+FE0F）：基础码点在 wcwidth
 *    中宽度为 1，但 VS16 触发 emoji 显示使其宽度变为 2。
 *    例如：⚔️（U+2694）、☠️（U+2620）、❤️（U+2764）。
 */
function needsWidthCompensation(char: string): boolean {
  const cp = char.codePointAt(0)
  if (cp === undefined) {
    return false
  }
  // U+1FA70-U+1FAFF：Symbols and Pictographs Extended-A（Unicode 12.0-15.0）
  // U+1FB00-U+1FBFF：Symbols for Legacy Computing（Unicode 13.0）
  if ((cp >= 0x1fa70 && cp <= 0x1faff) || (cp >= 0x1fb00 && cp <= 0x1fbff)) {
    return true
  }
  // 带 VS16 的默认为文本显示的 emoji：在多码点字形中扫描 U+FE0F。
  // 单个 BMP 字符（长度 1）和不带 VS16 的代理对跳过此检查。
  // VS16（0xFE0F）不会与代理对（0xD800-0xDFFF）冲突。
  if (char.length >= 2) {
    for (let i = 0; i < char.length; i++) {
      if (char.charCodeAt(i) === 0xfe0f) {
        return true
      }
    }
  }
  return false
}

class VirtualScreen {
  // writeCellWithStyleStr 直接公开修改（避免 txn 开销）。
  // 文件私有类 —— 不暴露到 log-update.ts 外部。
  cursor: Point
  diff: Diff = []

  constructor(
    origin: Point,
    readonly viewportWidth: number,
  ) {
    this.cursor = { ...origin }
  }

  txn(fn: (prev: Point) => [patches: Diff, next: Delta]): void {
    const [patches, next] = fn(this.cursor)
    for (const patch of patches) {
      this.diff.push(patch)
    }
    this.cursor.x += next.dx
    this.cursor.y += next.dy
  }
}
