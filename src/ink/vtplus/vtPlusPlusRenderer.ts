import { type AnsiCode, ansiCodesToString, diffAnsiCodes } from '@alcalzone/ansi-tokenize'
import type { Writable } from 'stream'
import { CellWidth, cellAt, type Hyperlink, type Screen, type StylePool } from '../screen.js'
import { SYNC_OUTPUT_SUPPORTED } from '../terminal.js'
import {
  CURSOR_HOME,
  cursorPosition,
  ERASE_SCREEN,
  RESET_SCROLL_REGION,
  setScrollRegion,
} from '../termio/csi.js'
import { BSU, ESU, HIDE_CURSOR, SHOW_CURSOR } from '../termio/dec.js'
import { LINK_END, link as oscLink } from '../termio/osc.js'

const MAX_HISTORY = 10000
const MIN_BOTTOM_HEIGHT = 4
const PUMP_BATCH = 100
const SGR_RESET = '\x1B[0m'
const EL = '\x1B[K'
const EL2 = '\x1B[2K'

type Layout = {
  contentHeight: number
  bottomTop: number
  bottomLines: string[]
}

/**
 * VtPlusPlus 渲染器 — 对应 CC 的 OMq 类。
 *
 * 核心机制：
 * 1. DECSTBM 滚动区域：内容区使用终端原生滚动，底部区固定
 * 2. committedTop：精确跟踪已提交到终端的滚动位置
 * 3. nativeHistory：回滚缓冲（max 10000 行）
 * 4. tickPump：渐进式回放（100 行/帧）
 * 5. 行级 diff + 帧级去重（覆盖完整输出）
 * 6. BSU/ESU 原子更新
 *
 * 关键设计决策（来自 CC 逆向分析）：
 * - LF 滚动在 contentHeight 更新之前（使用上一帧的 DECSTBM）
 * - 帧级去重在 renderFrame 中（覆盖 syncViewport + drawBottom 完整输出）
 * - drawBottom 不做去重（避免误清 syncViewport 输出）
 */
export class VtPlusPlusRenderer {
  private out: Writable
  private cols: number
  private rows: number
  private buf = ''
  private lastFrame = ''
  private syncOpen = false
  private restored = false

  // 视口状态
  private onScreen: string[] = []
  private committedTop = 0
  private contentHeight: number
  private tailSlack = 0

  // 回滚缓冲
  private nativeHistory: string[] = []
  private pumpCursor = -1
  private replayPending = false

  // 间隙检测
  private _gapRange: { from: number; to: number } | null = null
  private _backfillNeeded = false

  constructor(out: Writable, cols: number, rows: number) {
    this.out = out
    this.cols = cols
    this.rows = rows
    this.contentHeight = Math.max(2, rows - MIN_BOTTOM_HEIGHT)
  }

  setup(): void {
    this.onScreen = []
    this.committedTop = 0
    this.tailSlack = 0
    this.nativeHistory = []
    this.pumpCursor = -1
    this.replayPending = false
    this.lastFrame = ''
    this.buf = HIDE_CURSOR
    this.commitImmediate()
  }

  restore(): void {
    if (this.restored) return
    this.restored = true
    this.buf = SHOW_CURSOR
    this.commitImmediate()
  }

  handleResize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    this.contentHeight = Math.max(2, rows - MIN_BOTTOM_HEIGHT)
    this.onScreen = []
    this.committedTop = 0
    this.nativeHistory = []
    this.pumpCursor = -1
    this.replayPending = false
    this.lastFrame = ''
    this.buf += ERASE_SCREEN + CURSOR_HOME
    this.commitImmediate()
  }

  reset(): void {
    this.onScreen = []
    this.committedTop = 0
    this.nativeHistory = []
    this.pumpCursor = -1
    this.replayPending = false
    this.lastFrame = ''
  }

  tickPump(): boolean {
    if (this.pumpCursor < 0) return false
    const history = this.nativeHistory
    this.buf += setScrollRegion(1, 2)
    const end = Math.min(this.pumpCursor + PUMP_BATCH, history.length)
    for (; this.pumpCursor < end; this.pumpCursor++) {
      this.buf += cursorPosition(1, 1) + history[this.pumpCursor] + SGR_RESET + EL
      this.buf += cursorPosition(2, 1) + '\n'
    }
    this.buf += setScrollRegion(1, Math.max(2, this.contentHeight))
    this.lastFrame = ''
    this.commitImmediate()
    if (this.pumpCursor >= history.length) this.pumpCursor = -1
    return this.pumpCursor >= 0
  }

  /**
   * 同步视口 — CC 的 syncViewport 精确复现。
   *
   * 顺序（CC 一致）：
   * 1. LF 滚动（使用上一帧的 this.contentHeight，匹配上一帧 drawBottom 设置的 DECSTBM）
   * 2. contentHeight 更新 + DECSTBM 设置（为下一帧准备）
   * 3. 行级 diff
   */
  syncViewport(
    lines: string[],
    scrollTop: number,
    scrollHeight: number,
    transcriptEnd: number,
    contentHeight: number,
  ): void {
    if (this.pumpCursor >= 0) return

    if (!this.syncOpen && SYNC_OUTPUT_SUPPORTED) {
      this.buf += BSU
      this.syncOpen = true
    }

    if (this.replayPending) {
      this.replayPending = false
      this.committedTop = Math.min(scrollTop, transcriptEnd)
    }

    const q = Math.min(scrollTop, transcriptEnd)
    const K = Math.max(0, q - this.committedTop)

    // 1. LF 滚动（CC 顺序：在 contentHeight 更新之前）
    if (K > 0) {
      const w = Math.min(K, this.onScreen.length)
      if (w > 0) {
        this.buf += cursorPosition(this.contentHeight, 1) + '\n'.repeat(w)
        for (let f = 0; f < w; f++) {
          this.nativeHistory.push(this.onScreen.shift()!)
        }
        if (this.nativeHistory.length > MAX_HISTORY) {
          this.nativeHistory.splice(0, this.nativeHistory.length - MAX_HISTORY)
        }
      }
      const newCommitted = this.committedTop + w
      this.committedTop = q
      if (newCommitted < q) {
        this._gapRange = { from: newCommitted, to: q }
      }
      if (this.nativeHistory.length === 0 && q > 0) {
        this._backfillNeeded = true
      }
    }

    // 向上滚动：committedTop > q 时重置（无 nativeHistory 回填，全量重写）
    if (this.committedTop > q) {
      this.committedTop = q
      this.onScreen = []
    }

    // 2. contentHeight 更新（CC 顺序：在 LF 滚动之后）
    if (contentHeight !== this.contentHeight) {
      this.contentHeight = contentHeight
      this.buf += setScrollRegion(1, Math.max(2, contentHeight))
    }

    // 3. 行级 diff
    const offset = Math.max(0, this.committedTop - scrollTop)
    const T = this.contentHeight
    const available = Math.min(lines.length, T)
    const writeCount = Math.max(0, available - offset)

    if (this.onScreen.length > T) this.onScreen.length = T
    while (this.onScreen.length < T) this.onScreen.push('')

    for (let w = 0; w < T; w++) {
      const line = w < writeCount ? lines[offset + w] : ''
      if (this.onScreen[w] === line) continue
      this.buf += cursorPosition(w + 1, 1) + line + SGR_RESET + EL
      this.onScreen[w] = line
    }
    this.tailSlack = Math.max(0, T - writeCount)
  }

  /**
   * 绘制底部区域 — CC 的 draw() 精简版。
   * 不做帧级去重（由 renderFrame 统一处理）。
   */
  drawBottom(layout: Layout): void {
    this.buf += RESET_SCROLL_REGION
    for (let y = layout.bottomTop; y < this.rows; y++) {
      this.buf += cursorPosition(y + 1, 1) + EL2
    }
    for (let i = 0; i < layout.bottomLines.length; i++) {
      this.buf +=
        cursorPosition(layout.bottomTop + i + 1, 1) + layout.bottomLines[i] + SGR_RESET + EL
    }
    this.buf += setScrollRegion(1, Math.max(2, this.contentHeight))
  }

  /**
   * 从 Ink frame 渲染一帧到终端。
   *
   * 使用全屏行级 diff（Phase 3 验证通过的路径）。
   *
   * Phase 4 的 syncViewport/drawBottom 内容/底部分割路径存在边界时序问题
   *（nodeCache contentHeight 与实际 ScrollBox 渲染高度在某些帧不一致，
   * 导致内容区最后一行被 drawBottom 的 EL2 覆盖）。
   * Phase 4 方法保留在类中供后续调试和修复。
   *
   * 详见 docs/future-plan/vtplus-migration-plan.md
   */
  renderFrame(screen: Screen, stylePool: StylePool): boolean {
    this.tickPump()

    if (!this.syncOpen && SYNC_OUTPUT_SUPPORTED) {
      this.buf += BSU
      this.syncOpen = true
    }

    const frameStart = this.buf.length

    // 全屏行级 diff
    const height = Math.min(screen.height, this.rows)
    for (let y = 0; y < height; y++) {
      const line = extractLine(screen, stylePool, y)
      while (this.onScreen.length <= y) this.onScreen.push('')
      if (this.onScreen[y] === line) continue
      this.buf += cursorPosition(y + 1, 1) + line + SGR_RESET + EL
      this.onScreen[y] = line
    }

    if (this.onScreen.length > height) {
      for (let y = height; y < this.onScreen.length; y++) {
        this.buf += cursorPosition(y + 1, 1) + EL2
      }
      this.onScreen.length = height
    }

    // 帧级去重
    const frameOutput = this.buf.slice(frameStart)
    if (!this.syncOpen && frameOutput === this.lastFrame) {
      this.buf = ''
      this.syncOpen = false
      return true
    }
    this.lastFrame = frameOutput

    if (SYNC_OUTPUT_SUPPORTED) this.buf += ESU
    this.syncOpen = false
    this.commitImmediate()
    return true
  }

  private commitImmediate(): void {
    if (this.buf.length === 0) return
    this.out.write(this.buf)
    this.buf = ''
  }
}

function extractLine(screen: Screen, stylePool: StylePool, y: number): string {
  let line = ''
  let currentStyles: AnsiCode[] = []
  let currentHyperlink: Hyperlink

  for (let x = 0; x < screen.width; x++) {
    const cell = cellAt(screen, x, y)
    if (!cell || cell.width === CellWidth.SpacerTail) continue

    if (cell.hyperlink !== currentHyperlink) {
      if (currentHyperlink !== undefined) line += LINK_END
      if (cell.hyperlink !== undefined) line += oscLink(cell.hyperlink)
      currentHyperlink = cell.hyperlink
    }

    const cellStyles = stylePool.get(cell.styleId)
    const styleDiff = diffAnsiCodes(currentStyles, cellStyles)
    if (styleDiff.length > 0) {
      line += ansiCodesToString(styleDiff)
      currentStyles = cellStyles
    }
    line += cell.char
  }

  if (currentHyperlink !== undefined) line += LINK_END
  const resetCodes = diffAnsiCodes(currentStyles, [])
  if (resetCodes.length > 0) line += ansiCodesToString(resetCodes)

  return line.trimEnd()
}
