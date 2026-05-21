import type { RefObject } from 'react'
import * as React from 'react'
import {
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useVirtualScroll } from '../hooks/useVirtualScroll.js'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import type { DOMElement } from '../ink/dom.js'
import type { MatchPosition } from '../ink/render-to-screen.js'
import { Box } from '../ink.js'
import type { RenderableMessage } from '../types/message.js'
import { TextHoverColorContext } from './design-system/ThemedText.js'
import { ScrollChromeContext } from './FullscreenLayout.js'

// scrollTo 时目标上方留出的空间行数。
const HEADROOM = 3

import { logForDebugging } from '../utils/debug.js'
import { sleep } from '../utils/sleep.js'
import { renderableSearchText } from '../utils/transcriptSearch.js'
import {
  isNavigableMessage,
  type MessageActionsNav,
  type MessageActionsState,
  type NavigableMessage,
  stripSystemReminders,
  toolCallOf,
} from './messageActions.js'

// 后备提取器：在此处降低并缓存，供没有 Messages.tsx 工具查找路径的调用者使用
//（测试、静态上下文）。Messages.tsx 提供自己的降低缓存，还处理 tool extractSearchText。
const fallbackLowerCache = new WeakMap<RenderableMessage, string>()
function defaultExtractSearchText(msg: RenderableMessage): string {
  const cached = fallbackLowerCache.get(msg)
  if (cached !== undefined) {
    return cached
  }
  const lowered = renderableSearchText(msg)
  fallbackLowerCache.set(msg, lowered)
  return lowered
}
export type StickyPrompt =
  | {
      text: string
      scrollTo: () => void
    }
  // 点击设置此值——头部隐藏但 padding 保持折叠（0），这样内容 ❯ 落在屏幕第 0 行而非第 1 行。
  // 下次 sticky-prompt 计算时清除（用户再次滚动）。
  | 'clicked'

/** 超大粘贴提示（cat file | zy）可能达 MB 级。头部通过 overflow:hidden 换行为
 *  2 行——这仅限制 React 属性大小。*/
const STICKY_TEXT_CAP = 500

/** 转录导航的命令式句柄。方法在此计算匹配项（renderableMessages 索引仅在此组件内有效——
 *  Messages.tsx 过滤并重新排序，REPL 无法在外部计算）。*/
export type JumpHandle = {
  jumpToIndex: (i: number) => void
  setSearchQuery: (q: string) => void
  nextMatch: () => void
  prevMatch: () => void
  /** 捕获当前 scrollTop 作为 incsearch 锚点。输入时预览会跳动；
   *  0 匹配时回到此处。Enter/n/N 从不恢复（它们不调用空字符串的 setSearchQuery）。
   *  下次 / 调用会覆盖。*/
  setAnchor: () => void
  /** 预热搜索文本缓存，提取每条消息的文本。返回耗时 ms，
   *  或 0 如果已预热（同一转录会话中的后续 /）。
   *  工作前 yield 以便调用者先绘制 "indexing…"。调用者在 resolve 后显示 "indexed in Xms"。*/
  warmSearchIndex: () => Promise<number>
  /** 手动滚动（j/k/PgUp/滚轮）退出了搜索上下文。清除位置
   *  （黄色标记消失，反向高亮保留）。下次 n/N 通过 step()→jump() 重新建立。
   *  从 ScrollKeybindingHandler 的 onScroll 连接——仅对键盘/滚轮触发，不对编程式 scrollTo 触发。*/
  disarmSearch: () => void
}
type Props = {
  messages: RenderableMessage[]
  scrollRef: RefObject<ScrollBoxHandle | null>
  /** 更改时使 heightCache 失效——来自不同宽度的缓存高度是错误的
   *  （文本重新换行→放大后向上滚动时黑屏）。*/
  columns: number
  itemKey: (msg: RenderableMessage) => string
  renderItem: (msg: RenderableMessage, index: number) => React.ReactNode
  /** Fires when a message Box is clicked (toggle per-message verbose). */
  onItemClick?: (msg: RenderableMessage) => void
  /** Per-item filter — suppress hover/click for messages where the verbose
   *  toggle does nothing (text, file edits, etc). Defaults to all-clickable. */
  isItemClickable?: (msg: RenderableMessage) => boolean
  /** Expanded items get a persistent grey bg (not just on hover). */
  isItemExpanded?: (msg: RenderableMessage) => boolean
  /** PRE-LOWERED search text. Messages.tsx caches the lowered result
   *  once at warm time so setSearchQuery's per-keystroke loop does
   *  only indexOf (zero toLowerCase alloc). Falls back to a lowering
   *  wrapper on renderableSearchText for callers without the cache. */
  extractSearchText?: (msg: RenderableMessage) => string
  /** Enable the sticky-prompt tracker. StickyTracker writes via
   *  ScrollChromeContext (not a callback prop) so state lives in
   *  FullscreenLayout instead of REPL. */
  trackStickyPrompt?: boolean
  selectedIndex?: number
  /** 导航句柄放在这里因为高度测量在这里。*/
  cursorNavRef?: React.Ref<MessageActionsNav>
  setCursor?: (c: MessageActionsState | null) => void
  jumpRef?: RefObject<JumpHandle | null>
  /** 搜索匹配变化时触发（查询编辑、n/N）。current 是 1 基的用于 "3/47" 显示；
   *  0 表示没有匹配项。*/
  onSearchMatchesChange?: (count: number, current: number) => void
  /** 将现有 DOM 子树绘制到新的 Screen 并扫描。来自主树的元素（包含所有 provider）。
   *  消息相对的位置（row 0 = 元素顶部）。适用于任何高度——填补高消息的间隙。*/
  scanElement?: (el: DOMElement) => MatchPosition[]
  /** 基于位置的 CURRENT 高亮。位置预先已知（来自 scanElement），
   *  导航 = 索引算术 + scrollTo。rowOffset = 消息当前屏幕顶部；位置保持稳定。*/
  setPositions?: (
    state: {
      positions: MatchPosition[]
      rowOffset: number
      currentIdx: number
    } | null,
  ) => void
}

/**
 * 返回真实用户提示的文本，其他情况返回 null。
 * "Real" = 人类输入的内容：不是工具结果，不是 XML 包装的负载
 *（<bash-stdout>、<command-message>、<teammate-message> 等），不是元数据。
 *
 * 两种形状会到这里：NormalizedUserMessage（正常提示）和
 * AttachmentMessage（type==='queued_command'，在工具执行期间发送的提示——
 * 它们在下个回合作为附件被排出，参见 query.ts:1410）。两者在 UI 中都渲染为
 * ❯ 前缀的 UserTextMessage，所以两者都应该粘住。
 *
 * 检查前会剥离开头的 <system-reminder> 块——它们为 Zy 的上下文（记忆更新、自动
 * 模式提醒）被添加到存储的文本中，但不是用户输入的内容。不剥离的话，任何恰好
 * 获得提醒的提示都会被 startsWith('<') 检查拒绝。出现在 `cc -c` 恢复时，
 * 记忆更新提醒很密集。
 */
const promptTextCache = new WeakMap<RenderableMessage, string | null>()
function stickyPromptText(msg: RenderableMessage): string | null {
  // 以消息对象为键的缓存——消息是追加的且不会突变，
  // 所以 WeakMap 命中始终有效。walk（StickyTracker，每次滚动 tick）
  // 每个 tick 用相同的消息调用此函数 5-50+ 次；系统提醒剥离每次
  // 解析都分配新字符串。WeakMap 在压缩/清除时自动 GC（messages[] 被替换）。
  const cached = promptTextCache.get(msg)
  if (cached !== undefined) {
    return cached
  }
  const result = computeStickyPromptText(msg)
  promptTextCache.set(msg, result)
  return result
}
function computeStickyPromptText(msg: RenderableMessage): string | null {
  let raw: string | null = null
  if (msg.type === 'user') {
    if (msg.isMeta || msg.isVisibleInTranscriptOnly) {
      return null
    }
    const block = msg.message.content[0] as any
    if (block?.type !== 'text') {
      return null
    }
    raw = block.text
  } else if (
    (msg as any).type === 'attachment' &&
    (msg as any).attachment.type === 'queued_command' &&
    (msg as any).attachment.commandMode !== 'task-notification' &&
    !(msg as any).attachment.isMeta
  ) {
    const p = (msg as any).attachment.prompt
    raw =
      typeof p === 'string'
        ? p
        : p.flatMap((b: any) => (b.type === 'text' ? [b.text] : [])).join('\n')
  }
  if (raw === null) {
    return null
  }
  const t = stripSystemReminders(raw)
  if (t.startsWith('<') || t === '') {
    return null
  }
  return t
}

/**
 * 全屏模式下的虚拟化消息列表。从 Messages.tsx 拆分出来，以便
 * useVirtualScroll 被无条件调用（hooks 规则）——Messages.tsx
 * 有条件地渲染此组件或普通的 .map()。
 *
 * 包装的 <Box ref> 是测量锚点——MessageRow 不接受 ref。
 * 单子元素 column Box 将 Yoga height 原样传递。
 */
type VirtualItemProps = {
  itemKey: string
  msg: RenderableMessage
  idx: number
  measureRef: (key: string) => (el: DOMElement | null) => void
  expanded: boolean | undefined
  hovered: boolean
  clickable: boolean
  onClickK: (msg: RenderableMessage, cellIsBlank: boolean) => void
  onEnterK: (k: string) => void
  onLeaveK: (k: string) => void
  renderItem: (msg: RenderableMessage, idx: number) => React.ReactNode
}

// 具有稳定点击句柄的项目包装器。每个项目的闭包是
// `operationNewArrowFunction` 叶节点 → `FunctionExecutable::finalizeUnconditionally`
// GC 清理（快速滚动期间 16% 的 GC 时间）。3 个闭包 × 60 个挂载项 ×
// 10 次提交/秒 = 1800 个闭包/秒。通过 itemKey 传递稳定的
// onClickK/onEnterK/onLeaveK 后，此处的闭包是每个项目每个渲染的，但很便宜
//（仅用绑定的 k 包装稳定回调），且不闭合 msg/idx，
// 这使 JIT 可以内联它们。更大的收益在内部：MessageRow.memo
// 对未更改的消息 bail，跳过 marked.lexer + formatToken。
//
// 不使用 React.memo——renderItem 捕获变化的状态（光标、selectedIdx、
// verbose）。使用忽略 renderItem 的比较器进行 memo 会在 bail 时使用
// 过时的闭包（错误的选中标记、过时的 verbose）。在比较器中包含
// renderItem 会使 memo 失效，因为它每次渲染都是新的。
function VirtualItem({
  itemKey: k,
  msg,
  idx,
  measureRef,
  expanded,
  hovered,
  clickable,
  onClickK,
  onEnterK,
  onLeaveK,
  renderItem,
}: VirtualItemProps) {
  const measureCallback = measureRef(k)
  const renderedItem = renderItem(msg, idx)
  return (
    <Box
      ref={measureCallback}
      flexDirection="column"
      backgroundColor={expanded ? 'userMessageBackgroundHover' : undefined}
      paddingBottom={expanded ? 1 : undefined}
      onClick={clickable ? (e) => onClickK(msg, e.cellIsBlank) : undefined}
      onMouseEnter={clickable ? () => onEnterK(k) : undefined}
      onMouseLeave={clickable ? () => onLeaveK(k) : undefined}
    >
      {
        <TextHoverColorContext.Provider value={hovered && !expanded ? 'text' : undefined}>
          {renderedItem}
        </TextHoverColorContext.Provider>
      }
    </Box>
  )
}
export function VirtualMessageList({
  messages,
  scrollRef,
  columns,
  itemKey,
  renderItem,
  onItemClick,
  isItemClickable,
  isItemExpanded,
  extractSearchText = defaultExtractSearchText,
  trackStickyPrompt,
  selectedIndex,
  cursorNavRef,
  setCursor,
  jumpRef,
  onSearchMatchesChange,
  scanElement,
  setPositions,
}: Props): React.ReactNode {
  // 增量 key 数组。流式追加每次一条消息；每次提交重建
  // 完整字符串数组会为每条消息分配 O(n)（27k 消息时约 1MB  churn）。
  // 前缀匹配时仅追加增量 push；在压缩、/clear 或 itemKey 更改时回退到完整重建。
  const keysRef = useRef<string[]>([])
  const prevMessagesRef = useRef<typeof messages>(messages)
  const prevItemKeyRef = useRef(itemKey)
  if (
    prevItemKeyRef.current !== itemKey ||
    messages.length < keysRef.current.length ||
    messages[0] !== prevMessagesRef.current[0]
  ) {
    keysRef.current = messages.map((m) => itemKey(m))
  } else {
    for (let i = keysRef.current.length; i < messages.length; i++) {
      keysRef.current.push(itemKey(messages[i]!))
    }
  }
  prevMessagesRef.current = messages
  prevItemKeyRef.current = itemKey
  const keys = keysRef.current
  const {
    range,
    topSpacer,
    bottomSpacer,
    measureRef,
    spacerRef,
    offsets,
    getItemTop,
    getItemElement,
    getItemHeight,
    scrollToIndex,
  } = useVirtualScroll(scrollRef, keys, columns)
  const [start, end] = range

  // 未测量（高度 undefined）的穿过——假设可见。
  const isVisible = useCallback(
    (i: number) => {
      const h = getItemHeight(i)
      if (h === 0) {
        return false
      }
      return isNavigableMessage(messages[i]!)
    },
    [getItemHeight, messages],
  )
  useImperativeHandle(cursorNavRef, (): MessageActionsNav => {
    const select = (m: NavigableMessage) =>
      setCursor?.({
        uuid: m.uuid,
        msgType: m.type as any,
        expanded: false,
        toolName: toolCallOf(m)?.name,
      })
    const selIdx = selectedIndex ?? -1
    const scan = (from: number, dir: 1 | -1, pred: (i: number) => boolean = isVisible) => {
      for (let i = from; i >= 0 && i < messages.length; i += dir) {
        if (pred(i)) {
          select(messages[i]!)
          return true
        }
      }
      return false
    }
    const isUser = (i: number) => isVisible(i) && messages[i]!.type === 'user'
    return {
      // 通过 shift+↑ 进入 = 与光标内 shift+↑ 相同语义（prevUser）。
      enterCursor: () => scan(messages.length - 1, -1, isUser),
      navigatePrev: () => scan(selIdx - 1, -1),
      navigateNext: () => {
        if (scan(selIdx + 1, 1)) {
          return
        }
        // 超过最后可见项 → 退出并重新固定。最后消息的顶部在视口
        // 顶部（选择滚动效果）；其底部可能在视口下方。
        scrollRef.current?.scrollToBottom()
        setCursor?.(null)
      },
      // type:'user' only — queued_command attachments look like prompts but have no raw UserMessage to rewind to.
      navigatePrevUser: () => scan(selIdx - 1, -1, isUser),
      navigateNextUser: () => scan(selIdx + 1, 1, isUser),
      navigateTop: () => scan(0, 1),
      navigateBottom: () => scan(messages.length - 1, -1),
      getSelected: () => (selIdx >= 0 ? (messages[selIdx] ?? null) : null),
    }
  }, [
    messages,
    selectedIndex,
    setCursor,
    isVisible, // 超过最后可见项 → 退出并重新固定。最后消息的顶部在视口
    // 顶部（选择滚动效果）；其底部可能在视口下方。
    scrollRef.current?.scrollToBottom,
  ])
  // 两阶段跳转 + 搜索引擎。通过 ref 读取以保持句柄在渲染间稳定——
  // offsets/messages 标识每次渲染都变化，不能放在 useImperativeHandle 依赖中而不重新创建句柄。
  const jumpState = useRef({
    offsets,
    start,
    getItemElement,
    getItemTop,
    messages,
    scrollToIndex,
  })
  jumpState.current = {
    offsets,
    start,
    getItemElement,
    getItemTop,
    messages,
    scrollToIndex,
  }

  // 保持光标选中的消息可见。offsets 每次重建重新构建
  // ——作为裸依赖会在每次鼠标滚轮 tick 时重新固定。改为通过
  // jumpState 读取；超出 overscan 的跳转通过 scrollToIndex 着陆，
  // 下次导航是精确的。
  useEffect(() => {
    if (selectedIndex === undefined) {
      return
    }
    const s = jumpState.current
    const el = s.getItemElement(selectedIndex)
    if (el) {
      scrollRef.current?.scrollToElement(el, 1)
    } else {
      s.scrollToIndex(selectedIndex)
    }
  }, [selectedIndex, scrollRef])

  // 待处理的搜索请求。jump() 设置此项 + 增加 seekGen。搜索
  // effect 在绘制后触发（passive effect——resetAfterCommit 之后），
  // 检查目标是否已挂载。是 → 扫描并高亮。否 → 用更新的锚点
  //（start 向 idx 移动）重新估计并再次 scrollTo。
  const scanRequestRef = useRef<{
    idx: number
    wantLast: boolean
    tries: number
  } | null>(null)
  // 来自 scanElement 的消息相对位置。Row 0 = 消息顶部。
  // 滚动时保持稳定——highlight 重新计算 rowOffset。msgIdx
  // 用于计算 rowOffset = getItemTop(msgIdx) - scrollTop。
  const elementPositions = useRef<{
    msgIdx: number
    positions: MatchPosition[]
  }>({
    msgIdx: -1,
    positions: [],
  })
  // 回绕保护。如果 ptr 回绕到此位置，自动前进停止。
  const startPtrRef = useRef(-1)
  // 幻影突发限制。扫描成功时重置。
  const phantomBurstRef = useRef(0)
  // 单深度队列：搜索进行中的 n/N 会被存储（不丢弃）并在搜索完成后触发。
  // 按住 n 保持平滑，不会排队 30 次跳转。最新按下覆盖——我们需要用户
  // 当前前进的方向，而不是 10 次按键之前的方向。
  const pendingStepRef = useRef<1 | -1 | 0>(0)
  // step + highlight via ref so the seek effect reads latest without
  // closure-capture or deps churn.
  const stepRef = useRef<(d: 1 | -1) => void>(() => {})
  const highlightRef = useRef<(ord: number) => void>(() => {})
  const searchState = useRef({
    matches: [] as number[],
    // deduplicated msg indices
    ptr: 0,
    screenOrd: 0,
    // 每个 matches[k] 之前的引擎出现累计计数。让我们可以
    // 计算全局当前索引：prefixSum[ptr] + screenOrd + 1。
    // 引擎计数（extractSearchText 上的 indexOf），而非渲染计数——
    // 对于徽章来说足够接近；精确计数需要对每条匹配消息调用 scanElement
    //（~1-3ms × N）。total = prefixSum[matches.length]。
    prefixSum: [] as number[],
  })
  // 按下 / 时的 scrollTop。incsearch 预览跳转在匹配数降为 0 时回到此处。
  // -1 = 没有锚点（第一次 / 之前）。
  const searchAnchor = useRef(-1)
  const indexWarmed = useRef(false)

  // 消息 i 的滚动目标：落在消息顶部。est = top - HEADROOM
  // 使 lo = top - est = HEADROOM ≥ 0（或 est 钳位为 0 时 lo = top）。
  // 跳转后的回读处理 scrollHeight 边界。
  // 没有 frac（渲染变换不尊重它），没有单调钳位
  //（原本是 frac 垃圾的安全网——没有 frac 时，est 就是下一条
  // 消息的顶部，连续 n/N 会收敛因为消息顶部是有序的）。
  function targetFor(i: number): number {
    const top = jumpState.current.getItemTop(i)
    return Math.max(0, top - HEADROOM)
  }

  // 高亮 positions[ord]。位置是消息相对的（row 0 = 元素顶部，
  // 来自 scanElement）。重新计算 rowOffset = getItemTop - scrollTop。
  // 如果 ord 的位置在视口外，滚动将其带入，重新计算 rowOffset。
  // setPositions 触发覆盖写入。
  function highlight(ord: number): void {
    const s = scrollRef.current
    const { msgIdx, positions } = elementPositions.current
    if (!s || positions.length === 0 || msgIdx < 0) {
      setPositions?.(null)
      return
    }
    const idx = Math.max(0, Math.min(ord, positions.length - 1))
    const p = positions[idx]!
    const top = jumpState.current.getItemTop(msgIdx)
    // lo = 项目在滚动内容中的位置（wrapper 相对）。
    // viewportTop = 滚动内容在屏幕上的起始位置（在
    // ScrollBox padding/border + 上方任何 chrome 之后）。高亮写入
    // 屏幕绝对位置，所以 rowOffset = viewportTop + lo。观察：没有
    // viewportTop 时偏差 1+（FullscreenLayout 在 ScrollBox 上有
    // paddingTop=1，加上上方任何头部）。
    const vpTop = s.getViewportTop()
    let lo = top - s.getScrollTop()
    const vp = s.getViewportHeight()
    let screenRow = vpTop + lo + p.row
    // 超出视口 → 滚动将其带入（顶部留 HEADROOM）。
    // scrollTo 同步提交；回读后得到新的 lo。
    if (screenRow < vpTop || screenRow >= vpTop + vp) {
      s.scrollTo(Math.max(0, top + p.row - HEADROOM))
      lo = top - s.getScrollTop()
      screenRow = vpTop + lo + p.row
    }
    setPositions?.({
      positions,
      rowOffset: vpTop + lo,
      currentIdx: idx,
    })
    // 徽章：全局当前 = 此消息之前的出现次数 + ord+1。
    // prefixSum[ptr] 是引擎计数的（extractSearchText 上的 indexOf）；
    // 可能与幽灵消息的渲染计数有偏差，但足够接近——
    // 徽章是粗略的位置提示，不是证明。
    const st = searchState.current
    const total = st.prefixSum.at(-1) ?? 0
    const current = (st.prefixSum[st.ptr] ?? 0) + idx + 1
    onSearchMatchesChange?.(total, current)
    logForDebugging(
      `highlight(i=${msgIdx}, ord=${idx}/${positions.length}): ` +
        `pos={row:${p.row},col:${p.col}} lo=${lo} screenRow=${screenRow} ` +
        `badge=${current}/${total}`,
    )
  }
  highlightRef.current = highlight

  // 搜索 effect。jump() 设置 scanRequestRef + scrollToIndex + bump。
  // bump → 重新渲染 → useVirtualScroll 挂载目标（scrollToIndex
  // 保证这一点——scrollTop 和 topSpacer 通过相同的 offsets 值一致）
  // → resetAfterCommit 绘制 → 此 passive effect 在绘制后触发，元素已挂载。
  // 精确的 scrollTo + 扫描。
  //
  // 依赖仅为 seekGen——effect 不会在随机渲染时重新运行
  //（incsearch 期间 onSearchMatchesChange 变化）。
  const [_seekGen, setSeekGen] = useState(0)
  const bumpSeek = useCallback(() => setSeekGen((g) => g + 1), [])
  useEffect(() => {
    const req = scanRequestRef.current
    if (!req) {
      return
    }
    const { idx, wantLast, tries } = req
    const s = scrollRef.current
    if (!s) {
      return
    }
    const { getItemElement, getItemTop, scrollToIndex } = jumpState.current
    const el = getItemElement(idx)
    const h = el?.yogaNode?.getComputedHeight() ?? 0
    if (!el || h === 0) {
      // scrollToIndex 后未挂载。不应发生——scrollToIndex
      // 通过构造保证挂载（scrollTop 和 topSpacer 通过相同 offsets 值一致）。
      // 健全性检查：重试一次，然后跳过。
      if (tries > 1) {
        scanRequestRef.current = null
        logForDebugging(`seek(i=${idx}): no mount after scrollToIndex, skip`)
        stepRef.current(wantLast ? -1 : 1)
        return
      }
      scanRequestRef.current = {
        idx,
        wantLast,
        tries: tries + 1,
      }
      scrollToIndex(idx)
      bumpSeek()
      return
    }
    scanRequestRef.current = null
    // 精确的 scrollTo——scrollToIndex 让我们到了附近
    //（项目已挂载，可能因 overscan 估计偏差偏离几十行）。
    // 现在将其定位到 top-HEADROOM。
    s.scrollTo(Math.max(0, getItemTop(idx) - HEADROOM))
    const positions = scanElement?.(el) ?? []
    elementPositions.current = {
      msgIdx: idx,
      positions,
    }
    logForDebugging(`seek(i=${idx} t=${tries}): ${positions.length} positions`)
    if (positions.length === 0) {
      // 幻影——引擎匹配了，但渲染没有。自动前进。
      if (++phantomBurstRef.current > 20) {
        phantomBurstRef.current = 0
        return
      }
      stepRef.current(wantLast ? -1 : 1)
      return
    }
    phantomBurstRef.current = 0
    const ord = wantLast ? positions.length - 1 : 0
    searchState.current.screenOrd = ord
    startPtrRef.current = -1
    highlightRef.current(ord)
    const pending = pendingStepRef.current
    if (pending) {
      pendingStepRef.current = 0
      stepRef.current(pending)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanElement, bumpSeek, scrollRef.current])

  // 滚动到消息 i 的顶部，准备 scanPending。search effect 在下个 tick 读取新的屏幕。
  // wantLast：N 进入消息——screenOrd = length-1。
  function jump(i: number, wantLast: boolean): void {
    const s = scrollRef.current
    if (!s) {
      return
    }
    const js = jumpState.current
    const { getItemElement, scrollToIndex } = js
    // offsets is a Float64Array whose .length is the allocated buffer (only
    // grows) — messages.length is the logical item count.
    if (i < 0 || i >= js.messages.length) {
      return
    }
    // 清除过时的高亮，在滚动前进行。从现在到搜索
    // effect 的高亮之间，scan-highlight 的反向显示。
    setPositions?.(null)
    elementPositions.current = {
      msgIdx: -1,
      positions: [],
    }
    scanRequestRef.current = {
      idx: i,
      wantLast,
      tries: 0,
    }
    const el = getItemElement(i)
    const h = el?.yogaNode?.getComputedHeight() ?? 0
    // 已挂载 → 精确的 scrollTo。未挂载 → scrollToIndex 挂载它
    //（scrollTop 和 topSpacer 通过相同的 offsets 值一致——构造上精确，无需估计）。
    // 无论哪种方式，seek effect 在绘制后都会执行精确的 scrollTo。
    if (el && h > 0) {
      s.scrollTo(targetFor(i))
    } else {
      scrollToIndex(i)
    }
    bumpSeek()
  }

  // 在 elementPositions 内推进 screenOrd。耗尽 → ptr 前进，
  // 跳转到下一个 matches[ptr]，重新扫描。幻影（跳转后扫描找到 0）
  // 从 scan-effect 触发自动前进。如果每条消息都是幻影，回绕保护停止。
  function step(delta: 1 | -1): void {
    const st = searchState.current
    const { matches, prefixSum } = st
    const total = prefixSum.at(-1) ?? 0
    if (matches.length === 0) {
      return
    }

    // 搜索进行中——将此按键排队（单深度，最新覆盖）。
    // seek effect 在高亮后触发它。
    if (scanRequestRef.current) {
      pendingStepRef.current = delta
      return
    }
    if (startPtrRef.current < 0) {
      startPtrRef.current = st.ptr
    }
    const { positions } = elementPositions.current
    const newOrd = st.screenOrd + delta
    if (newOrd >= 0 && newOrd < positions.length) {
      st.screenOrd = newOrd
      highlight(newOrd) // updates badge internally
      startPtrRef.current = -1
      return
    }

    // 可见项耗尽。前进 ptr → 跳转 → 重新扫描。
    const ptr = (st.ptr + delta + matches.length) % matches.length
    if (ptr === startPtrRef.current) {
      setPositions?.(null)
      startPtrRef.current = -1
      logForDebugging(`step: wraparound at ptr=${ptr}, all ${matches.length} msgs phantoms`)
      return
    }
    st.ptr = ptr
    st.screenOrd = 0 // resolved after scan (wantLast → length-1)
    jump(matches[ptr]!, delta < 0)
    // screenOrd 将在扫描后解析。尽力而为：prefixSum[ptr] + 0
    // 用于 n（第一个位置），prefixSum[ptr+1] 用于 N（最后一个位置 = count-1）。
    // scan-effect 的高亮才是真实值；这是扫描前的占位符，
    // 使徽章立即更新。
    const placeholder = delta < 0 ? (prefixSum[ptr + 1] ?? total) : prefixSum[ptr]! + 1
    onSearchMatchesChange?.(total, placeholder)
  }
  stepRef.current = step
  useImperativeHandle(
    jumpRef,
    () => ({
      // 非搜索跳转（sticky 头部点击等）。不扫描，无位置。
      jumpToIndex: (i: number) => {
        const s = scrollRef.current
        if (s) {
          s.scrollTo(targetFor(i))
        }
      },
      setSearchQuery: (q: string) => {
        // 新搜索使一切失效。
        scanRequestRef.current = null
        elementPositions.current = {
          msgIdx: -1,
          positions: [],
        }
        startPtrRef.current = -1
        setPositions?.(null)
        const lq = q.toLowerCase()
        // 每个消息一条记录（去重）。布尔值"此消息是否包含查询"。
        // 9k 条消息约 10ms（使用已降低的缓存）。
        const matches: number[] = []
        // 每条消息出现次数 → 前缀和用于全局当前索引。
        // 引擎计数（廉价 indexOf 循环）；可能与渲染计数有偏差
        //（幽灵/幻影消息），但足够接近徽章使用。徽章是粗略的位置提示。
        const prefixSum: number[] = [0]
        if (lq) {
          const msgs = jumpState.current.messages
          for (let i = 0; i < msgs.length; i++) {
            const text = extractSearchText(msgs[i]!)
            let pos = text.indexOf(lq)
            let cnt = 0
            while (pos >= 0) {
              cnt++
              pos = text.indexOf(lq, pos + lq.length)
            }
            if (cnt > 0) {
              matches.push(i)
              prefixSum.push(prefixSum.at(-1)! + cnt)
            }
          }
        }
        const total = prefixSum.at(-1)!
        // 距离锚点最近的消息。<= 使平局时取后者。
        let ptr = 0
        const s = scrollRef.current
        const { offsets, start, getItemTop } = jumpState.current
        const firstTop = getItemTop(start)
        const origin = firstTop >= 0 ? firstTop - offsets[start]! : 0
        if (matches.length > 0 && s) {
          const curTop = searchAnchor.current >= 0 ? searchAnchor.current : s.getScrollTop()
          let best = Infinity
          for (let k = 0; k < matches.length; k++) {
            const d = Math.abs(origin + offsets[matches[k]!]! - curTop)
            if (d <= best) {
              best = d
              ptr = k
            }
          }
          logForDebugging(
            `setSearchQuery('${q}'): ${matches.length} msgs · ptr=${ptr} ` +
              `msgIdx=${matches[ptr]} curTop=${curTop} origin=${origin}`,
          )
        }
        searchState.current = {
          matches,
          ptr,
          screenOrd: 0,
          prefixSum,
        }
        if (matches.length > 0) {
          // wantLast=true：预览最近消息中的最后一个出现。
          // 在 sticky-bottom（常见的 / 入口），最近的是最后一条消息；
          // 其最后一次出现最接近用户之前所在位置——视图移动最小。
          // n 从那里向前前进。
          jump(matches[ptr]!, true)
        } else if (searchAnchor.current >= 0 && s) {
          // /foob → 0 匹配 → 回到锚点。less/vim incsearch 行为。
          s.scrollTo(searchAnchor.current)
        }
        // 全局出现次数 + 1 基当前。wantLast=true 所以
        // 扫描会落在 matches[ptr] 的最后一次出现上。占位符
        // = prefixSum[ptr+1]（到此消息的计数）。highlight() 在扫描完成后更新为精确值。
        onSearchMatchesChange?.(total, matches.length > 0 ? (prefixSum[ptr + 1] ?? total) : 0)
      },
      nextMatch: () => step(1),
      prevMatch: () => step(-1),
      setAnchor: () => {
        const s = scrollRef.current
        if (s) {
          searchAnchor.current = s.getScrollTop()
        }
      },
      disarmSearch: () => {
        // 手动滚动使屏幕绝对位置失效。
        setPositions?.(null)
        scanRequestRef.current = null
        elementPositions.current = {
          msgIdx: -1,
          positions: [],
        }
        startPtrRef.current = -1
      },
      warmSearchIndex: async () => {
        if (indexWarmed.current) {
          return 0
        }
        const msgs = jumpState.current.messages
        const CHUNK = 500
        let workMs = 0
        const wallStart = performance.now()
        for (let i = 0; i < msgs.length; i += CHUNK) {
          await sleep(0)
          const chunkStart = performance.now()
          const end = Math.min(i + CHUNK, msgs.length)
          for (let j = i; j < end; j++) {
            extractSearchText(msgs[j]!)
          }
          workMs += performance.now() - chunkStart
        }
        const wallMs = Math.round(performance.now() - wallStart)
        logForDebugging(
          `warmSearchIndex: ${msgs.length} msgs · work=${Math.round(workMs)}ms wall=${wallMs}ms chunks=${Math.ceil(msgs.length / CHUNK)}`,
        )
        indexWarmed.current = true
        return Math.round(workMs)
      },
    }),
    // 闭包引用 ref + 回调。scrollRef 稳定；其他是
    // useCallback([]) 或从 REPL 传递的 props（稳定）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      scrollRef,
      step,
      targetFor, // wantLast=true：预览最近消息中的最后一个出现。
      // 在 sticky-bottom（常见的 / 入口），最近的是最后一条消息；
      // 其最后一次出现最接近用户之前所在位置——视图移动最小。
      // n 从那里向前前进。
      jump, // 全局出现次数 + 1 基当前。wantLast=true 所以
      // 扫描会落在 matches[ptr] 的最后一次出现上。占位符
      // = prefixSum[ptr+1]（到此消息的计数）。highlight() 在扫描完成后更新为精确值。
      onSearchMatchesChange, // 手动滚动使屏幕绝对位置失效。
      setPositions,
      extractSearchText,
    ],
  )

  // StickyTracker 放在列表内容之后。它返回 null（无 DOM 节点），
  // 所以顺序本不应影响布局——但放在前面意味着每次
  // 来自其自身滚动订阅的细粒度提交都会遍历兄弟项目
  //（React 按顺序遍历子节点）。在项目之后，它是叶子 reconcile。
  // 防御性：也避免如果 Ink reconciler 为 null 返回物化占位符时的 Yoga child-index 问题。
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)
  // 稳定的点击/悬停句柄——通过 ref 调用 k、dispatch，使
  // 闭包标识不会每次渲染都变化。每个项目的处理程序
  // 闭包（`e => ...`、`() => setHoveredKey(k)`）是滚动 CPU 配置文件中的
  // `operationNewArrowFunction` 叶节点；其清理占 GC 时间的 16%
  //（`FunctionExecutable::finalizeUnconditionally`）。
  // 快速滚动期间分配 3 个闭包 × 60 个挂载项 × 10 次提交/秒
  // = 1800 个短命闭包/秒。使用稳定 ref 后，项目包装器 props 不变
  // → VirtualItem.memo 对约 35 个未更改的项 bail，仅约 25 个新项支付 createElement 成本。
  const handlersRef = useRef({
    onItemClick,
    setHoveredKey,
  })
  handlersRef.current = {
    onItemClick,
    setHoveredKey,
  }
  const onClickK = useCallback((msg: RenderableMessage, cellIsBlank: boolean) => {
    const h = handlersRef.current
    if (!cellIsBlank && h.onItemClick) {
      h.onItemClick(msg)
    }
  }, [])
  const onEnterK = useCallback((k: string) => {
    handlersRef.current.setHoveredKey(k)
  }, [])
  const onLeaveK = useCallback((k: string) => {
    handlersRef.current.setHoveredKey((prev) => (prev === k ? null : prev))
  }, [])
  return (
    <>
      <Box ref={spacerRef} height={topSpacer} flexShrink={0} />
      {messages.slice(start, end).map((msg, i) => {
        const idx = start + i
        const k = keys[idx]!
        const clickable = !!onItemClick && (isItemClickable?.(msg) ?? true)
        const hovered = clickable && hoveredKey === k
        const expanded = isItemExpanded?.(msg)
        return (
          <VirtualItem
            key={k}
            itemKey={k}
            msg={msg}
            idx={idx}
            measureRef={measureRef}
            expanded={expanded}
            hovered={hovered}
            clickable={clickable}
            onClickK={onClickK}
            onEnterK={onEnterK}
            onLeaveK={onLeaveK}
            renderItem={renderItem}
          />
        )
      })}
      {bottomSpacer > 0 && <Box height={bottomSpacer} flexShrink={0} />}
      {trackStickyPrompt && (
        <StickyTracker
          messages={messages}
          start={start}
          end={end}
          offsets={offsets}
          getItemTop={getItemTop}
          getItemElement={getItemElement}
          scrollRef={scrollRef}
        />
      )}
    </>
  )
}
const NOOP_UNSUB = () => {}

/**
 * 仅 effect 的子组件，跟踪滚动到视口顶部上方的最后一个用户提示，
 * 并在变化时触发 onChange。
 *
 * 渲染为独立组件（而非 VirtualMessageList 中的 hook），以便它可以
 * 以比 SCROLL_QUANTUM=40 更细的粒度订阅滚动。列表需要粗量子
 * 以避免每次滚轮 tick 的 Yoga 重新布局；此跟踪器只是 walk + 比较，
 * 可以每次 tick 运行。当它单独重新渲染时，列表的协调输出不变
 *（来自父级上次提交的相同 props）——无 Yoga 工作。不这样拆分的话，
 * 头部滞后约一个对话回合（40 行 ≈ 一个提示 + 响应）。
 *
 * firstVisible 推导：项目 Box 是 ScrollBox 内容包装器的直接 Yoga 子节点
 *（fragments 在 Ink DOM 中折叠），所以 yoga.getComputedTop 是内容包装器相对的——
 * 与 scrollTop 相同的坐标空间。与 scrollTop + pendingDelta 比较
 *（滚动目标——scrollBy 仅设置 pendingDelta，committed scrollTop 滞后）。
 * 从挂载范围末尾向后 walk；当项目的 top 低于 target 时 break。
 */
function StickyTracker({
  messages,
  start,
  end,
  offsets,
  getItemTop,
  getItemElement,
  scrollRef,
}: {
  messages: RenderableMessage[]
  start: number
  end: number
  offsets: ArrayLike<number>
  getItemTop: (index: number) => number
  getItemElement: (index: number) => DOMElement | null
  scrollRef: RefObject<ScrollBoxHandle | null>
}): null {
  const { setStickyPrompt } = useContext(ScrollChromeContext)
  // 细粒度订阅——快照是未量化的 scrollTop+delta，
  // 所以每次滚动操作（滚轮 tick、PgUp、拖拽）都会触发此组件的重新渲染。
  // Sticky 位折叠到符号中，sticky→broken 也会触发
  //（scrollToBottom 设置 sticky 但不移动 scrollTop）。
  const subscribe = useCallback(
    (listener: () => void) => scrollRef.current?.subscribe(listener) ?? NOOP_UNSUB,
    [scrollRef],
  )
  useSyncExternalStore(subscribe, () => {
    const s = scrollRef.current
    if (!s) {
      return NaN
    }
    const t = s.getScrollTop() + s.getPendingDelta()
    return s.isSticky() ? -1 - t : t
  })

  // 每次渲染读取实时滚动状态。
  const isSticky = scrollRef.current?.isSticky() ?? true
  const target = Math.max(
    0,
    (scrollRef.current?.getScrollTop() ?? 0) + (scrollRef.current?.getPendingDelta() ?? 0),
  )

  // 遍历挂载范围，找到第一个在视口顶部或下方的项目。
  // `range` 来自父级的粗量子渲染（可能略有滞后），
  // 但 overscan 保证它远远超出视口两个方向。
  // 尚未 Yoga 布局的项目（本帧新挂载的）被视为在或下方——
  // 它们在视口中的某个位置，否则假设会显示一个实际上在屏幕上的提示的 sticky。
  let firstVisible = start
  let firstVisibleTop = -1
  for (let i = end - 1; i >= start; i--) {
    const top = getItemTop(i)
    if (top >= 0) {
      if (top < target) {
        break
      }
      firstVisibleTop = top
    }
    firstVisible = i
  }
  let idx = -1
  let text: string | null = null
  if (firstVisible > 0 && !isSticky) {
    for (let i = firstVisible - 1; i >= 0; i--) {
      const t = stickyPromptText(messages[i]!)
      if (t === null) {
        continue
      }
      // 提示的包装 Box 顶部在 target 上方（这就是为什么它在
      // [0, firstVisible) 范围内），但其 ❯ 在 top+1（marginTop=1）。
      // 如果 ❯ 在或低于 target，它在视口顶部可见——
      // 在头部显示相同文本会重复它。发生在 Box 顶部滚过和
      // ❯ 滚过之间的 1 行间隙中。跳到下一个更旧的提示（其 ❯ 肯定在上方）。
      const top = getItemTop(i)
      if (top >= 0 && top + 1 >= target) {
        continue
      }
      idx = i
      text = t
      break
    }
  }
  const baseOffset = firstVisibleTop >= 0 ? firstVisibleTop - offsets[firstVisible]! : 0
  const estimate = idx >= 0 ? Math.max(0, baseOffset + offsets[idx]!) : -1

  // 对于点击跳转到尚未挂载的项目（用户滚动很远，提示在 topSpacer 中）。
  // 点击句柄滚动到估计值以挂载它；一旦出现就通过元素锚定。
  // scrollToElement 将 Yoga 位置读取延迟到渲染时（render-node-to-output
  // 在同一个 calculateLayout 中读取 el.yogaNode.getComputedTop()，
  // 该 pass 产生 scrollHeight）——无节流竞争。限制重试次数：
  // /clear 竞争可能在序列中间卸载项目。
  const pending = useRef({
    idx: -1,
    tries: 0,
  })
  // 抑制状态机。点击句柄武装；onChange effect
  // 消耗（armed→force），然后在那次渲染之后触发并清除
  //（force→none）。force 步骤毒化去重：点击后，idx 经常
  // 重新计算为相同的提示（其顶部仍在 target 上方），所以
  // 没有 force 的话 last.idx===idx 守卫会保持 'clicked' 直到用户
  // 跨越提示边界。之前编码在 last.idx 中为 -1/-2/-3，
  // 与真实索引重叠——太聪明了。
  type Suppress = 'none' | 'armed' | 'force'
  const suppress = useRef<Suppress>('none')
  // 仅对 idx 去重——estimate 来源于 firstVisibleTop，每次滚动 tick 都偏移，
  // 所以将其包含在 key 中会使守卫失效（setStickyPrompt 每帧触发新的
  // {text,scrollTo}）。scrollTo 闭包仍然捕获当前估计值；它只是
  // 不需要在仅 estimate 移动时重新触发。
  const lastIdx = useRef(-1)

  // setStickyPrompt effect 优先——必须在下方校正 effect 之前看到 pending.idx。
  // 在估计回退路径上，挂载项目的渲染也是校正清除 pending 的渲染；
  // 如果此在后运行，pending 门控会失效，setStickyPrompt(prevPrompt) 会在
  // 跳转中间触发，在 'clicked' 上重新挂载头部。
  useEffect(() => {
    // 在两阶段校正进行中时保持。
    if (pending.current.idx >= 0) {
      return
    }
    if (suppress.current === 'armed') {
      suppress.current = 'force'
      return
    }
    const force = suppress.current === 'force'
    suppress.current = 'none'
    if (!force && lastIdx.current === idx) {
      return
    }
    lastIdx.current = idx
    if (text === null) {
      setStickyPrompt(null)
      return
    }
    // 仅第一段（按空行分割）——类似
    // "still seeing bugs:\n\n1. foo\n2. bar" 的提示预览仅为引导部分。
    // trimStart 使前导空行（queued_command 中间回合消息有时有）
    // 不会在 0 处找到 paraEnd。
    const trimmed = text.trimStart()
    const paraEnd = trimmed.search(/\n\s*\n/)
    const collapsed = (paraEnd >= 0 ? trimmed.slice(0, paraEnd) : trimmed)
      .slice(0, STICKY_TEXT_CAP)
      .replace(/\s+/g, ' ')
      .trim()
    if (collapsed === '') {
      setStickyPrompt(null)
      return
    }
    const capturedIdx = idx
    const capturedEstimate = estimate
    setStickyPrompt({
      text: collapsed,
      scrollTo: () => {
        // 隐藏头部，保持 padding 折叠——FullscreenLayout 的
        // 'clicked' 哨兵 → scrollBox_y=0 + pad=0 → viewportTop=0。
        setStickyPrompt('clicked')
        suppress.current = 'armed'
        // scrollToElement anchors by DOMElement ref, not a number:
        // render-node-to-output reads el.yogaNode.getComputedTop() at
        // paint time (same Yoga pass as scrollHeight). No staleness from
        // the throttled render — the ref is stable, the position read is
        // deferred. offset=1 = UserPromptMessage marginTop.
        const el = getItemElement(capturedIdx)
        if (el) {
          scrollRef.current?.scrollToElement(el, 1)
        } else {
          // 未挂载（滚动很远——在 topSpacer 中）。跳转到
          // 估计值以挂载它；校正 effect 在出现后重新锚定。
          // 估计基于 DEFAULT_ESTIMATE——着陆不足。
          scrollRef.current?.scrollTo(capturedEstimate)
          pending.current = {
            idx: capturedIdx,
            tries: 0,
          }
        }
      },
    })
    // 无依赖——必须每次渲染都运行。抑制状态存在于 ref 中
    //（而非 idx/estimate），所以依赖守卫的 effect 永远不会看到它 tick。
    // 函数体自己的守卫在没有变化时短路。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })

  // 校正：用于点击跳转到未挂载的项目。点击句柄滚动到估计值；
  // 此在项目出现后通过元素重新锚定。scrollToElement 将 Yoga 读取延迟到绘制时——确定性的。
  // 第二个运行，使它在 onChange 门控看到 pending 之后清除 pending。
  useEffect(() => {
    if (pending.current.idx < 0) {
      return
    }
    const el = getItemElement(pending.current.idx)
    if (el) {
      scrollRef.current?.scrollToElement(el, 1)
      pending.current = {
        idx: -1,
        tries: 0,
      }
    } else if (++pending.current.tries > 5) {
      pending.current = {
        idx: -1,
        tries: 0,
      }
    }
  })
  return null
}
