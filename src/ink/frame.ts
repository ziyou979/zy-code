// @ts-expect-error
import type { Cursor } from './cursor.js'
import type { Size } from './layout/geometry.js'
import type { ScrollHint } from './renderNodeToOutput.js'
import {
  type CharPool,
  createScreen,
  type HyperlinkPool,
  type Screen,
  type StylePool,
} from './screen.js'

export type Frame = {
  readonly screen: Screen
  readonly viewport: Size
  readonly cursor: Cursor
  /** DECSTBM 滚动优化提示（仅 alt-screen，否则为 null）。 */
  readonly scrollHint?: ScrollHint | null
  /** ScrollBox 还有剩余的 pendingScrollDelta —— 安排下一帧渲染。 */
  readonly scrollDrainPending?: boolean
}

export function emptyFrame(
  rows: number,
  columns: number,
  stylePool: StylePool,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool,
): Frame {
  return {
    screen: createScreen(0, 0, stylePool, charPool, hyperlinkPool),
    viewport: { width: columns, height: rows },
    cursor: { x: 0, y: 0, visible: true },
  }
}

export type FlickerReason = 'resize' | 'offscreen' | 'clear'

export type FrameEvent = {
  durationMs: number
  /** 各阶段耗时（毫秒）及 patch 数量。当 ink 实例
   *  启用了帧时间插桩（通过 onFrame 连接）时填充。 */
  phases?: {
    /** createRenderer 输出：DOM → yoga 布局 → 屏幕缓冲区 */
    renderer: number
    /** LogUpdate.render()：屏幕比对 → Patch[]（本次 PR 优化的热路径） */
    diff: number
    /** optimize()：patch 合并/去重 */
    optimize: number
    /** writeDiffToTerminal()：序列化 patches → ANSI → stdout */
    write: number
    /** 优化前的 patch 数量（表示本帧变更了多少内容） */
    patches: number
    /** yoga calculateLayout() 耗时（在 resetAfterCommit 中运行，onRender 之前） */
    yoga: number
    /** React 调和耗时：scrollMutated → resetAfterCommit。无 commit 时为 0。 */
    commit: number
    /** 本帧 layoutNode() 调用次数（递归，包含缓存命中返回） */
    yogaVisited: number
    /** measureFunc（文本换行/宽度）调用次数 —— 耗时部分 */
    yogaMeasured: number
    /** 通过 _hasL 单槽缓存的提前返回次数 */
    yogaCacheHits: number
    /** 存活的 yoga Node 实例总数（create - free）。增长 = 内存泄漏。 */
    yogaLive: number
  }
  flickers: Array<{
    desiredHeight: number
    availableHeight: number
    reason: FlickerReason
  }>
}

export type Patch =
  | { type: 'stdout'; content: string }
  | { type: 'clear'; count: number }
  | {
      type: 'clearTerminal'
      reason: FlickerReason
      // 当 scrollback diff 触发重置时由 log-update 填充。
      // ink.tsx 使用 triggerY 配合 findOwnerChainAtRow 将
      // 闪烁归因到其源 React 组件。
      debug?: { triggerY: number; prevLine: string; nextLine: string }
    }
  | { type: 'cursorHide' }
  | { type: 'cursorShow' }
  | { type: 'cursorMove'; x: number; y: number }
  | { type: 'cursorTo'; col: number }
  | { type: 'carriageReturn' }
  | { type: 'hyperlink'; uri: string }
  // 来自 StylePool.transition() 的预序列化样式转换字符串 ——
  // 按 (fromId, toId) 缓存，预热后零分配。
  | { type: 'styleStr'; str: string }

export type Diff = Patch[]

/**
 * 根据当前帧和上一帧判断是否需要清屏。
 * 返回清屏原因，不需要清屏时返回 undefined。
 *
 * 触发清屏的条件：
 * 1. 终端尺寸发生变化（视口维度改变） → 'resize'
 * 2. 当前帧屏幕高度超过终端可用行数 → 'offscreen'
 * 3. 上一帧屏幕高度超过终端可用行数 → 'offscreen'
 */
export function shouldClearScreen(prevFrame: Frame, frame: Frame): FlickerReason | undefined {
  const didResize =
    frame.viewport.height !== prevFrame.viewport.height ||
    frame.viewport.width !== prevFrame.viewport.width
  if (didResize) {
    return 'resize'
  }

  const currentFrameOverflows = frame.screen.height >= frame.viewport.height
  const previousFrameOverflowed = prevFrame.screen.height >= prevFrame.viewport.height
  if (currentFrameOverflows || previousFrameOverflowed) {
    return 'offscreen'
  }

  return undefined
}
