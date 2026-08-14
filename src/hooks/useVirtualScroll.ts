import type { RefObject } from 'react'
import {
  useCallback,
  useDeferredValue,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import type { DOMElement } from '../ink/dom.js'

/**
 * 尚未测量 item 的估算高度（行数），有意取较低值。
 * 高估会产生空白：过早停止挂载，viewport 底部显示空 spacer；
 * 低估只会在 overscan 中多挂载少量 item。由于这种不对称，宁可低估。
 */
const DEFAULT_ESTIMATE = 3
/**
 * viewport 上下额外渲染的行数。取值较宽裕，因为长 tool result 的实际高度
 * 可能达到估算值的 10 倍。
 */
const OVERSCAN_ROWS = 80
/** ScrollBox 完成布局前（viewportHeight=0）渲染的 item 数量。 */
const COLD_START_COUNT = 30
/**
 * useSyncExternalStore snapshot 的 scrollTop 量化步长。若不量化，每格滚轮产生的
 * 3-5 个 tick 都会触发完整 React commit、Yoga calculateLayout() 和 Ink diff，造成 CPU 峰值。
 * 视觉滚动不受影响：每次 scrollBy 都会触发 ScrollBox.forceRender，Ink 从 DOM node
 * 读取真实 scrollTop。React 只需在挂载范围需要移动时重渲染；OVERSCAN_ROWS 的一半
 * 是最小安全分箱，可保证切换范围前至少还剩 40 行 overscan。
 */
const SCROLL_QUANTUM = OVERSCAN_ROWS >> 1
/**
 * 计算覆盖范围时为未测量 item 假定的最坏高度。MessageRow 最小可为 1 行
 *（单行 tool call）。此处使用 1，可保证无论 item 实际多小，挂载区间都能覆盖
 * viewport 底部；item 较大时会多挂载，但可由 overscan 吸收。
 */
const PESSIMISTIC_HEIGHT = 1
/** 挂载 item 数量上限，即使在退化情况下也限制 fiber 分配。 */
const MAX_MOUNTED_ITEMS = 300
/**
 * 单次 commit 最多挂载的新 item 数。PESSIMISTIC_HEIGHT=1 时滚入新范围会一次挂载
 * 194 个 item，每个新 MessageRow 约耗时 1.5ms，总计约 290ms 同步阻塞。
 * 通过多次 commit 将范围滑向目标，可限制单次挂载成本；render 阶段的
 * scrollClampMin/Max 会将 viewport 固定在已挂载内容边缘，追赶期间不会出现空白。
 */
const SLIDE_STEP = 25

const NOOP_UNSUB = () => {}

export type VirtualScrollResult = {
  /** 要渲染的 item 半开区间 [startIndex, endIndex)。 */
  range: readonly [number, number]
  /** 首个渲染 item 之前 spacer 的高度（行数）。 */
  topSpacer: number
  /** 最后一个渲染 item 之后 spacer 的高度（行数）。 */
  bottomSpacer: number
  /**
   * callback ref factory。将 `measureRef(itemKey)` 绑定到每个渲染 item 的根 Box；
   * Yoga 布局后缓存计算高度。
   */
  measureRef: (key: string) => (el: DOMElement | null) => void
  /**
   * 绑定到 topSpacer Box。其 Yoga computedTop 就是 listOrigin：它是虚拟区域首个 child，
   * top 等于 ScrollBox 中列表前全部内容的累计高度。无需减 offset，也不依赖渲染间
   * 可能因 tmux resize 改变的 item 高度，因此不会漂移。
   */
  spacerRef: RefObject<DOMElement | null>
  /**
   * 每个 item 在 list-wrapper 坐标中的累计 y-offset，而非 scrollbox 坐标；
   * 列表前的 logo/sibling 会移动原点。offsets[i] 是 item i 上方行数，
   * offsets[n] 是总高度。每次渲染重新计算，不按 identity 缓存。
   */
  offsets: ArrayLike<number>
  /**
   * 读取指定索引 item 的 Yoga computedTop；item 未挂载或未布局时返回 -1。
   * item Box 是 ScrollBox content wrapper 的直接 Yoga child，因此返回值相对 content wrapper，
   * 与 scrollTop 处于同一坐标系。Yoga 布局与滚动无关，位置可跨滚动保持有效。
   * StickyTracker 用它逐个 scroll tick 查找 viewport 边界，精度高于此 hook 的 40 行重渲染步长。
   */
  getItemTop: (index: number) => number
  /**
   * 获取指定索引已挂载的 DOMElement，否则返回 null。供 ScrollBox.scrollToElement 使用；
   * 以 element ref 锚定会将 Yoga 位置读取延迟到 render 阶段，结果确定且无 throttle 竞态。
   */
  getItemElement: (index: number) => DOMElement | null
  /** 测得的 Yoga 高度。undefined 表示尚未测量，0 表示未渲染内容。 */
  getItemHeight: (index: number) => number | undefined
  /**
   * 滚动使 item `i` 进入挂载范围，并设置 scrollTop = offsets[i] + listOrigin。
   * 范围逻辑与滚动使用同一 offsets 值，因此无论估算位置是否精确都能保持一致并挂载 item。
   * 屏幕位置可能有几十行估算漂移，但 item 已进入 DOM；随后用 getItemTop(i) 获取精确位置。
   */
  scrollToIndex: (i: number) => void
}

/**
 * ScrollBox 内 item 的 React 层虚拟化。
 *
 * ScrollBox 已在 Ink 输出层进行 viewport 剔除：render-node-to-output.ts:617
 * 会跳过可见窗口外的 child，但仍会分配所有 React fiber 和 Yoga node。
 * 每个 MessageRow 约占 250 KB RSS，1000 条消息的会话会消耗约 250 MB
 * 只增不减的内存；Ink screen buffer、WASM linear memory 和 JSC page retention
 * 都只会增长。
 *
 * 此 hook 只挂载 viewport + overscan 中的 item，其余部分由 spacer box
 * 保持滚动高度，每个 spacer 的 fiber 成本为 O(1)。
 *
 * 高度估算：未测量 item 使用固定 DEFAULT_ESTIMATE，首次布局后替换为真实 Yoga 高度。
 * 不做滚动锚定，由 overscan 吸收估算误差；若实际漂移明显，可在 topSpacer 变化时
 * scrollBy(delta) 实现锚定。
 *
 * stickyScroll 注意事项：render-node-to-output.ts:450 会在 Ink render 阶段设置
 * scrollTop=maxScroll，但不会触发 ScrollBox.subscribe。下方 at-bottom 检查会处理：
 * 固定到底部时，无论 scrollTop 值如何都渲染最后 N 个 item。
 */
export function useVirtualScroll(
  scrollRef: RefObject<ScrollBoxHandle | null>,
  itemKeys: readonly string[],
  /**
   * 终端列数。变化时文本会重新换行，缓存高度已过期，但按 oldCols/newCols 缩放而非清空。
   * 清空会让悲观覆盖回溯挂载约 190 个 item，每个新挂载约 3ms，长会话首次 resize
   * 会造成约 600ms reconcile。缩放可保留近似真实高度并维持紧凑挂载范围，
   * 下一次 useLayoutEffect 再用真实 Yoga 高度覆盖。
   *
   * 缩放高度足够接近真实值，可避免拓宽时旧 offsets 超过新 scrollTop、end 循环提前停止
   * 导致黑屏。拓宽时 ratio<1 会向下缩放，使 offsets 与 resize 后 Yoga 大致对齐。
   */
  columns: number,
): VirtualScrollResult {
  const heightCache = useRef(new Map<string, number>())
  // heightCache 每次变化时递增，使 offsets 下次读取时重建。使用 ref 而非 state，
  // 在 render 阶段检查，不增加 commit。
  const offsetVersionRef = useRef(0)
  // 上次 commit 时的 scrollTop，用于检测快速滚动模式（slide cap gate）。
  const lastScrollTopRef = useRef(0)
  const offsetsRef = useRef<{ arr: Float64Array; version: number; n: number }>({
    arr: new Float64Array(0),
    version: -1,
    n: -1,
  })
  const itemRefs = useRef(new Map<string, DOMElement>())
  const refCache = useRef(new Map<string, (el: DOMElement | null) => void>())
  // 内联比较 ref，必须在下方计算 offsets 前运行。skip flag 防止 useLayoutEffect
  // 用 resize 前的 Yoga 高度重新填充 heightCache；该 effect 读取的是本次
  // calculateLayout 前、仍使用旧宽度的帧。下一次渲染的 effect 才会读取 resize 后高度。
  const prevColumns = useRef(columns)
  const skipMeasurementRef = useRef(false)
  // resize 稳定期间冻结挂载范围。已挂载 item 的 useMemo 已预热；按缩放或悲观估算
  // 重算范围会造成 mount/unmount 抖动，每个新挂载约 3ms，总计约 150ms 的二次闪烁。
  // 冻结两次渲染：第 1 次跳过测量，第 2 次 effect 写入 resize 后 Yoga 高度，
  // 第 3 次已有准确高度，再恢复正常重算。
  const prevRangeRef = useRef<readonly [number, number] | null>(null)
  const freezeRendersRef = useRef(0)
  if (prevColumns.current !== columns) {
    // 宽度变化时清空 heightCache：旧高度在新宽度下不正确
    //（由窄到宽时旧高度偏大 → topSpacer 过大 → 内容被推到视口下方 → 空行）。
    // 清空后所有项目用 PESSIMISTIC_HEIGHT=1，topSpacer=0，内容从顶部开始。
    // useDeferredValue 将大量 fresh mount 延迟到后台渲染（非阻塞）。
    // skipMeasurement 跳过第一帧测量（Yoga 仍是旧宽度的布局）。
    prevColumns.current = columns
    heightCache.current.clear()
    offsetVersionRef.current++
    skipMeasurementRef.current = true
    // 冻结挂载范围 2 帧：第 1 帧 skipMeasurement（Yoga 仍是旧宽度布局），
    // 第 2 帧 useLayoutEffect 读取新宽度下的 Yoga 高度写入 heightCache，
    // 第 3 帧用准确高度正常重算。不冻结则所有项目用 PESSIMISTIC_HEIGHT=1，
    // 范围跳变导致大量 mount/unmount（每个 ~3ms）→ 可见闪烁 + 空行。
    freezeRendersRef.current = 2
  }
  const frozenRange = freezeRendersRef.current > 0 ? prevRangeRef.current : null
  // listOrigin 使用 content-wrapper 坐标；scrollTop 相对 content wrapper，offsets[] 则相对列表。
  // ScrollBox 中位于列表前的 Logo、StatusNotices 和截断 divider 会按累计高度移动 item。
  // 从虚拟区域首个 child topSpacer 的 Yoga computedTop 读取 listOrigin，可避免 sticky 断开时
  // effLo/effHi 被抬高并越过可见 item，也避免 tmux resize 后按旧 item 样本相减造成漂移和黑屏。
  // 与 heightCache 一样会滞后一帧。
  const listOriginRef = useRef(0)
  const spacerRef = useRef<DOMElement | null>(null)

  // useSyncExternalStore 将重渲染绑定到命令式滚动。snapshot 把 scrollTop 量化到
  // SCROLL_QUANTUM 分箱，小幅滚动时 Object.is 不变，React 会跳过 commit + Yoga + Ink
  // 周期，直到累计 delta 跨箱。sticky 通过符号位并入 snapshot，使 sticky→broken
  // 也能触发；NaN sentinel 表示 ref 尚未绑定。
  const subscribe = useCallback(
    (listener: () => void) => scrollRef.current?.subscribe(listener) ?? NOOP_UNSUB,
    [scrollRef],
  )
  useSyncExternalStore(subscribe, () => {
    const s = scrollRef.current
    if (!s) {
      return NaN
    }
    // snapshot 使用目标值 scrollTop + pendingDelta，而非已 commit 的 scrollTop。
    // scrollBy 只修改 pendingDelta，renderer 会跨帧排空，因此 commit 值滞后。
    // 使用目标值可让 notify() 真正改变 snapshot，使 React 在 Ink drain 帧需要前
    // 就为目标位置重新挂载 child。
    const target = s.getScrollTop() + s.getPendingDelta()
    const bin = Math.floor(target / SCROLL_QUANTUM)
    return s.isSticky() ? ~bin : bin
  })
  // 范围计算读取真实已 commit 的 scrollTop；量化只用于重渲染门控，不代表位置。
  const scrollTop = scrollRef.current?.getScrollTop() ?? -1
  // 范围必须同时覆盖已 commit 的 scrollTop 和 pending 将排空到的目标位置。
  // drain 期间的中间帧会在两者之间渲染；若只为目标挂载，中间帧会找不到 child 而留白。
  const pendingDelta = scrollRef.current?.getPendingDelta() ?? 0
  const viewportH = scrollRef.current?.getViewportHeight() ?? 0
  // true 表示 ScrollBox 固定到底部，这是唯一稳定的“位于底部”信号。
  // scrollTop/scrollHeight 都反映前一帧且依赖本次渲染范围，会形成反馈循环。
  // stickyScroll 由用户操作、初始属性或 render-node-to-output 的位置跟随设置；renderer
  // 只会在已位于底部时将 false 改为 true，因此不会产生反馈。默认 true，使 ref 绑定前
  // 先假定在底部，首次 Ink render 会实际固定到底部。
  const isSticky = scrollRef.current?.isSticky() ?? true

  // GC 过期 cache entry（compaction、/clear、screenToggleId 递增）。
  // 仅在 itemKeys identity 变化时运行，滚动不会触碰 key；itemRefs 卸载时通过 ref(null) 自清理。
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable
  useMemo(() => {
    const live = new Set(itemKeys)
    let dirty = false
    for (const k of heightCache.current.keys()) {
      if (!live.has(k)) {
        heightCache.current.delete(k)
        dirty = true
      }
    }
    for (const k of refCache.current.keys()) {
      if (!live.has(k)) {
        refCache.current.delete(k)
      }
    }
    if (dirty) {
      offsetVersionRef.current++
    }
  }, [itemKeys])

  // offsets 跨渲染缓存，通过递增 offsetVersion ref 失效。旧方案每次渲染分配
  // Array(n+1) 并执行 n 次 Map.get；n≈27k、每秒约 11 次 commit 时会达到每秒 30 万次
  // lookup，造成 GC 抖动并增加约 2ms/render。heightCache writer 负责递增版本；
  // 不使用 setState，而是在 render 阶段按 ref 版本惰性重建，同一 commit 内完成且不额外调度。
  const n = itemKeys.length
  if (offsetsRef.current.version !== offsetVersionRef.current || offsetsRef.current.n !== n) {
    const arr =
      offsetsRef.current.arr.length >= n + 1 ? offsetsRef.current.arr : new Float64Array(n + 1)
    arr[0] = 0
    for (let i = 0; i < n; i++) {
      arr[i + 1] = arr[i]! + (heightCache.current.get(itemKeys[i]!) ?? DEFAULT_ESTIMATE)
    }
    offsetsRef.current = { arr, version: offsetVersionRef.current, n }
  }
  const offsets = offsetsRef.current.arr
  const totalHeight = offsets[n]!

  let start: number
  let end: number

  if (frozenRange) {
    // column 刚变化时保留 resize 前范围，避免挂载抖动；若消息被 /clear 或 compaction
    // 移除，则将范围钳制到 n。
    ;[start, end] = frozenRange
    start = Math.min(start, n)
    end = Math.min(end, n)
  } else if (viewportH === 0 || scrollTop < 0) {
    // 冷启动时 ScrollBox 尚未布局，先渲染尾部。首次 Ink render 会通过 sticky scroll
    // 固定到底部，这些正是用户会看到的 item；之后上滚会触发 scrollBy → subscribe，
    // 再用真实值重渲染。
    start = Math.max(0, n - COLD_START_COUNT)
    end = n
  } else {
    if (isSticky) {
      // sticky-scroll fallback。render-node-to-output 可能移动 scrollTop 却未通知，
      // 因此优先信任“位于底部”而非旧 snapshot；从尾部向前遍历直到覆盖 viewport + overscan。
      //
      const budget = viewportH + OVERSCAN_ROWS
      start = n
      while (start > 0 && totalHeight - offsets[start - 1]! < budget) {
        start--
      }
      end = n
      // 远距离 jump-to-bottom：丢弃上半区 prevRange，并中和 scrollVelocity，
      // 否则 SLIDE_STEP 仍以上半区为基座滑动，尾部挂不齐 → 视口空白。
      // clamp 由下方 useLayoutEffect（isSticky 分支）与 scrollToBottom 同步清除。
      prevRangeRef.current = null
      lastScrollTopRef.current = scrollTop
    } else {
      // 用户已上滚。根据估算 offsets 计算 start；低估只会稍早开始挂载。
      // 再按累计的最佳已知高度而非估算 offsets 扩展 end。不变量为：
      //   topSpacer + sum(real_heights[start..end]) >= scrollTop + viewportH + overscan
      // 因为 topSpacer = offsets[start] ≤ scrollTop - overscan，所以需要：
      //   sum(real_heights) >= viewportH + 2*overscan
      // 未测量 item 按最小可能值 PESSIMISTIC_HEIGHT=1 计算；item 较大时会多挂载，
      // 但快速滚过未测区域时绝不会让 viewport 显示空 spacer。下一帧缓存真实高度后范围会收紧。
      // 仅当 item K 未挂载，或已挂载且高度已缓存时，才可将其折入 topSpacer 并推进 start，
      // 两种情况都不会改变现有布局。已挂载但未缓存的 item 需多保留一帧，让 effect 完成测量。
      // 挂载范围覆盖 [committed, target]，确保每个 drain 帧都有内容。将目标下限钳为 0，
      // 防止自由滚轮使 pendingDelta 远低于零并把范围拉宽到 MAX_MOUNTED_ITEMS 无法覆盖。
      // 比较 offsets[] 前用 listOrigin 将 content-wrapper 坐标转为列表局部坐标，
      // 避免列表前 sibling 的高度抬高 scrollTop，导致 start 过度前移并吃掉 overscan/可见行。
      const listOrigin = listOriginRef.current
      // 限制 [committed..target] 跨度，阻止输入快于渲染时 pendingDelta 无界增长、
      // 单次挂载 194 个新 MessageRow 并同步阻塞数秒的恶性循环。
      // setClampBounds 在追赶期间显示已挂载边缘，滚动会跨数帧到达目标而不留白。
      const MAX_SPAN_ROWS = viewportH * 3
      const rawLo = Math.min(scrollTop, scrollTop + pendingDelta)
      const rawHi = Math.max(scrollTop, scrollTop + pendingDelta)
      const span = rawHi - rawLo
      const clampedLo =
        span > MAX_SPAN_ROWS
          ? pendingDelta < 0
            ? rawHi - MAX_SPAN_ROWS // scrolling up: keep near target (low end)
            : rawLo // scrolling down: keep near committed
          : rawLo
      const clampedHi = clampedLo + Math.min(span, MAX_SPAN_ROWS)
      const effLo = Math.max(0, clampedLo - listOrigin)
      const effHi = clampedHi - listOrigin
      const lo = effLo - OVERSCAN_ROWS
      // offsets 单调递增，使用二分查找 start。27k 消息会话中线性扫描每帧约 27k 次，
      // 此处降为 O(log n)。
      {
        let l = 0
        let r = n
        while (l < r) {
          const m = (l + r) >> 1
          if (offsets[m + 1]! <= lo) {
            l = m + 1
          } else {
            r = m
          }
        }
        start = l
      }
      // 不越过已挂载但未测量的 item。挂载到 useLayoutEffect 测量之间有一帧窗口；
      // 此时卸载会让 topSpacer 使用与真实跨度不符的 DEFAULT_ESTIMATE，造成闪烁。
      // 只扫描已挂载范围 [prevStart, prevEnd)，而非全部 n 个 item。
      {
        const p = prevRangeRef.current
        if (p && p[0] < start) {
          for (let i = p[0]; i < Math.min(start, p[1]); i++) {
            const k = itemKeys[i]!
            if (itemRefs.current.has(k) && !heightCache.current.has(k)) {
              start = i
              break
            }
          }
        }
      }

      const needed = viewportH + 2 * OVERSCAN_ROWS
      const maxEnd = Math.min(n, start + MAX_MOUNTED_ITEMS)
      let coverage = 0
      end = start
      while (
        end < maxEnd &&
        (coverage < needed || offsets[end]! < effHi + viewportH + OVERSCAN_ROWS)
      ) {
        coverage += heightCache.current.get(itemKeys[end]!) ?? PESSIMISTIC_HEIGHT
        end++
      }
    }
    // atBottom 路径也保证同样覆盖；它按估算 offsets 回退 start，item 较小时可能低估。
    const needed = viewportH + 2 * OVERSCAN_ROWS
    const minStart = Math.max(0, end - MAX_MOUNTED_ITEMS)
    let coverage = 0
    for (let i = start; i < end; i++) {
      coverage += heightCache.current.get(itemKeys[i]!) ?? PESSIMISTIC_HEIGHT
    }
    while (start > minStart && coverage < needed) {
      start--
      coverage += heightCache.current.get(itemKeys[start]!) ?? PESSIMISTIC_HEIGHT
    }
    // slide cap 限制本次 commit 新挂载的 item 数，否则新范围在 PESSIMISTIC_HEIGHT=1
    // 下会挂载 194 个 item，阻塞 React 约 290ms。仅在滚动速度超过 2×viewportH 时启用，
    // 同时覆盖 scrollBy 和 scrollTo；普通单次 PageUp 或 sticky-break 跳转不启用。
    // 追赶期间 setClampBounds 将 viewport 固定在已挂载边缘；只限制范围增长，不限制收缩。
    const prev = prevRangeRef.current
    const scrollVelocity = Math.abs(scrollTop - lastScrollTopRef.current) + Math.abs(pendingDelta)
    if (prev && scrollVelocity > viewportH * 2) {
      const [pS, pE] = prev
      if (start < pS - SLIDE_STEP) {
        start = pS - SLIDE_STEP
      }
      if (end > pE + SLIDE_STEP) {
        end = pE + SLIDE_STEP
      }
      // 大幅前跳可能使 start 越过受限 end；从新 start 挂载 SLIDE_STEP 个 item，
      // 避免追赶期间 viewport 留白。
      if (start > end) {
        end = Math.min(start + SLIDE_STEP, n)
      }
    }
    lastScrollTopRef.current = scrollTop
  }

  // 计算范围后再递减 freeze。冻结期间不更新 prevRangeRef，使两次冻结渲染都复用
  // resize 前的原始范围，而非消息变化时钳制到 n 的版本。
  if (freezeRendersRef.current > 0) {
    freezeRendersRef.current--
  } else {
    prevRangeRef.current = [start, end]
  }
  // useDeferredValue 让 React 先用旧范围低成本渲染，再过渡到包含新挂载的高成本新范围。
  // 紧急渲染维持 Ink 输入帧率，新挂载在可中断的后台渲染中完成；setClampBounds
  // 已负责固定 viewport，因此 deferred 范围短暂落后于 scrollTop 不会产生视觉伪影。
  //
  // 只延迟范围增长，因为增长会新增挂载；收缩只移除 fiber、无需解析，成本较低。
  // 延迟收缩会让旧 overscan 多挂载一个 tick，虽无害但会破坏测量收紧后检查精确范围的测试。
  const dStart = useDeferredValue(start)
  const dEnd = useDeferredValue(end)
  let effStart = start < dStart ? dStart : start
  let effEnd = end > dEnd ? dEnd : end
  // 大幅跳转可能使 effStart > effEnd，此时跳过延迟以避免反向范围。sticky 时也跳过，
  // 因为 scrollToBottom 必须立即挂载尾部，使 scrollTop=maxScroll 落在内容而非 bottomSpacer。
  // sticky snap 只有一帧，不会受益于 time-slicing。
  if (effStart > effEnd || isSticky) {
    effStart = start
    effEnd = end
  }
  // 向下滚动时绕过 effEnd 延迟并立即挂载尾部，否则基于 effEnd 的 clamp 会让 scrollTop
  // 停在真实底部之前，表现为卡住。effStart 仍保持延迟，使高成本的向上滚动继续 time-slicing。
  if (pendingDelta > 0) {
    effEnd = end
  }
  // 最终强制 O(viewport)。中间上限虽约束 [start,end]，deferred 与 bypass 组合仍可能
  // 让 [effStart,effEnd] 漂宽；10K 行恢复会话连续 PageUp 时曾额外占用 270MB RSS。
  // 按 viewport 位置裁剪远端，使 fiber 数量不受 deferred 调度影响，始终为 O(viewport)。
  if (effEnd - effStart > MAX_MOUNTED_ITEMS) {
    // 根据 viewport 位置而非 pendingDelta 方向决定裁剪侧。pendingDelta 会在帧间归零，
    // 而 dStart/dEnd 在 concurrent 调度下滞后；按方向裁剪会在稳定途中翻转，拉动 scrollTop
    // 并使 scrollback 消失。按位置则保留 viewport 更接近的一端。
    const mid = (offsets[effStart]! + offsets[effEnd]!) / 2
    if (scrollTop - listOriginRef.current < mid) {
      effEnd = effStart + MAX_MOUNTED_ITEMS
    } else {
      effStart = effEnd - MAX_MOUNTED_ITEMS
    }
  }

  // 在 layout effect 中写入 render 阶段 clamp 边界；不能在 render 中修改 DOM。
  // render-node-to-output 将 scrollTop 钳在该范围，使快于 React 异步重渲染的连续
  // scrollTo 调用显示已挂载内容边缘，而不是空 spacer。
  //
  // clamp 必须使用实际的 deferred 范围，而非即时范围。快速滚动时即时范围可能已覆盖
  // 新 scrollTop，但 child 仍按旧 deferred 范围渲染；若使用即时边界，drain 会越过
  // 已渲染 child 落入 spacer，造成白闪。effStart/effEnd 与实际挂载内容保持同步。
  //
  // sticky 时跳过 clamp，由 render-node-to-output 权威设置 scrollTop=maxScroll。
  // 冷启动/加载期间 clamp 会因估算 offsets 与下一帧真实高度不一致而调整 scrollTop，造成闪烁。
  const listOrigin = listOriginRef.current
  const effTopSpacer = offsets[effStart]!
  // effStart=0 时上方没有未挂载内容，必须允许越过 listOrigin 查看 ScrollBox 中列表外的
  // logo/header；只有 topSpacer 非零、确有未挂载 item 时才钳制。
  const clampMin = effStart === 0 ? 0 : effTopSpacer + listOrigin
  // effEnd=n 时没有 bottomSpacer，无需防止越界。不能使用滞后 Yoga 一帧的 offsets[n]：
  // 尾部 item 流式增长时缓存高度落后，会在 sticky-break 后把 scrollTop 钳在真实最大值下方，
  // 使流式文本移出 viewport。用 Infinity 表示不设上限，交给 render-node-to-output 自行约束。
  const clampMax =
    effEnd === n ? Infinity : Math.max(effTopSpacer, offsets[effEnd]! - viewportH) + listOrigin
  useLayoutEffect(() => {
    if (isSticky) {
      scrollRef.current?.setClampBounds(undefined, undefined)
    } else {
      scrollRef.current?.setClampBounds(clampMin, clampMax)
    }
  })

  // 从前一次 Ink render 测量高度。每次 commit 都运行，因为 Yoga 会在 React 不知情时重算布局。
  // 已挂载至少一帧的 yogaNode 高度有效；全新 item 要到此 effect 之后的
  // resetAfterCommit → onRender 才会布局。
  //
  // 用 getComputedWidth() > 0 区分“Yoga 尚未运行导致 h=0”和“MessageRow 渲染 null 导致 h=0”。
  // column 中 Box 的容器宽度始终非零，因此宽度已设置就证明布局完成；此时高度为 0
  // 表示 item 确实为空，应缓存 0，避免 start 推进门控永久阻塞并冻结范围。
  //
  // 此处不调用 setState，否则会按变化后的 offsets 调度第二次 commit；Ink 每次 commit
  // 都写 stdout，两次不同 spacer 高度的写入会造成可见闪烁。高度在下一次自然渲染时
  // 传播到 offsets，一帧延迟由 overscan 吸收。
  useLayoutEffect(() => {
    const spacerYoga = spacerRef.current?.yogaNode
    if (spacerYoga && spacerYoga.getComputedWidth() > 0) {
      listOriginRef.current = spacerYoga.getComputedTop()
    }
    if (skipMeasurementRef.current) {
      skipMeasurementRef.current = false
      return
    }
    let anyChanged = false
    for (const [key, el] of itemRefs.current) {
      const yoga = el.yogaNode
      if (!yoga) {
        continue
      }
      const h = yoga.getComputedHeight()
      const prev = heightCache.current.get(key)
      if (h > 0) {
        if (prev !== h) {
          heightCache.current.set(key, h)
          anyChanged = true
        }
      } else if (yoga.getComputedWidth() > 0 && prev !== 0) {
        heightCache.current.set(key, 0)
        anyChanged = true
      }
    }
    if (anyChanged) {
      offsetVersionRef.current++
    }
  })

  // 每个 key 使用 identity 稳定的 callback ref，使 React 的 ref 交换不会造成 itemRefs
  // 每帧抖动，并与 heightCache 一起 GC。ref(null) 路径还会在卸载时捕获最终高度；
  // reconciler 会先调用 ref(null)，再 removeChild → freeRecursive，此时 yogaNode 仍有效。
  const measureRef = useCallback((key: string) => {
    let fn = refCache.current.get(key)
    if (!fn) {
      fn = (el: DOMElement | null) => {
        if (el) {
          itemRefs.current.set(key, el)
        } else {
          const yoga = itemRefs.current.get(key)?.yogaNode
          if (yoga && !skipMeasurementRef.current) {
            const h = yoga.getComputedHeight()
            if ((h > 0 || yoga.getComputedWidth() > 0) && heightCache.current.get(key) !== h) {
              heightCache.current.set(key, h)
              offsetVersionRef.current++
            }
          }
          itemRefs.current.delete(key)
        }
      }
      refCache.current.set(key, fn)
    }
    return fn
  }, [])

  const getItemTop = useCallback(
    (index: number) => {
      const yoga = itemRefs.current.get(itemKeys[index]!)?.yogaNode
      if (!yoga || yoga.getComputedWidth() === 0) {
        return -1
      }
      return yoga.getComputedTop()
    },
    [itemKeys],
  )

  const getItemElement = useCallback(
    (index: number) => itemRefs.current.get(itemKeys[index]!) ?? null,
    [itemKeys],
  )
  const getItemHeight = useCallback(
    (index: number) => heightCache.current.get(itemKeys[index]!),
    [itemKeys],
  )
  const scrollToIndex = useCallback(
    (i: number) => {
      // offsetsRef.current 保存最新缓存 offsets；event handler 在渲染之间运行，
      // render 阶段 closure 会过期。
      const o = offsetsRef.current
      if (i < 0 || i >= o.n) {
        return
      }
      scrollRef.current?.scrollTo(o.arr[i]! + listOriginRef.current)
    },
    [scrollRef],
  )

  const effBottomSpacer = totalHeight - offsets[effEnd]!

  return {
    range: [effStart, effEnd],
    topSpacer: effTopSpacer,
    bottomSpacer: effBottomSpacer,
    measureRef,
    spacerRef,
    offsets,
    getItemTop,
    getItemElement,
    getItemHeight,
    scrollToIndex,
  }
}
