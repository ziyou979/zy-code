/**
 * ScrollBox 触底跟随决策（对齐 CC scrollHeightHwm / stickyScroll 语义）。
 * 从 render-node-to-output 抽出，便于回归测试，避免依赖完整 Yoga 布局。
 */

export type ScrollFollowInput = {
  /** 当前内容高度 */
  scrollHeight: number
  /** 上一帧内容高度 */
  prevScrollHeight: number
  /** 视口高度 */
  innerHeight: number
  /** 上一帧视口高度 */
  prevInnerHeight: number
  /** 当前 scrollTop（跟随前） */
  scrollTop: number
  /** sticky 标志或属性 */
  sticky: boolean
  /** 上一帧累计的高度高水位；undefined 表示尚无 */
  scrollHeightHwm?: number
  /** 待处理的滚动增量；负值表示上滚进行中 */
  pendingScrollDelta?: number
}

export type ScrollFollowResult = {
  /** 是否应将 scrollTop 钉到 maxScroll */
  atBottom: boolean
  /** 更新后的高度高水位 */
  scrollHeightHwm: number
  /** 内容是否视为在增长（含 HWM 容忍） */
  grew: boolean
  maxScroll: number
  /** 若 atBottom 且无上滚中，跟随后的 scrollTop */
  nextScrollTop: number
}

/**
 * 计算流式/增高内容下是否触底跟随，以及 HWM 更新。
 * 防止高度短暂回落时误判离底导致 transcript 回跳（CC 2.1.207）。
 */
export function computeScrollFollow(input: ScrollFollowInput): ScrollFollowResult {
  const {
    scrollHeight,
    prevScrollHeight,
    innerHeight,
    prevInnerHeight,
    scrollTop,
    sticky,
    pendingScrollDelta = 0,
  } = input

  const maxScroll = Math.max(0, scrollHeight - innerHeight)
  const prevMaxScroll = Math.max(0, prevScrollHeight - prevInnerHeight)

  let hwm = input.scrollHeightHwm ?? 0
  // 仅在 sticky 或已触底时推进高水位
  if (sticky || scrollTop >= prevMaxScroll) {
    hwm = Math.max(hwm, scrollHeight)
  }

  const grew =
    scrollHeight >= prevScrollHeight || (scrollTop >= prevMaxScroll && scrollHeight >= hwm * 0.9)

  const atBottom = sticky || (grew && scrollTop >= prevMaxScroll)

  let nextScrollTop = scrollTop
  if (atBottom && pendingScrollDelta >= 0) {
    nextScrollTop = maxScroll
  }
  // 始终钳位到合法范围
  nextScrollTop = Math.max(0, Math.min(nextScrollTop, maxScroll))

  return {
    atBottom,
    scrollHeightHwm: hwm,
    grew,
    maxScroll,
    nextScrollTop,
  }
}
