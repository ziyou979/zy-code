import { fileURLToPath } from 'node:url'
import React, {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useInsertionEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { ARROW_DOWN, POINTER } from '../constants/figures.js'
import { ModalContext } from '../context/ModalContext.js'
import {
  PromptOverlayProvider,
  usePromptOverlay,
  usePromptOverlayDialog,
} from '../context/PromptOverlayContext.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { tSync } from '../i18n/index.js'
import ScrollBox, { type ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import type { DOMElement } from '../ink/dom.js'
import instances from '../ink/instances.js'
import { nodeCache } from '../ink/nodeCache.js'
import { VtPlusPlusRenderer } from '../ink/vtplus/vtPlusPlusRenderer.js'
import { Box, Text } from '../ink/index.js'
import { findStickyHeaderHitMeta, registerStickyHeaderHitTarget } from '../ink/messageHitTarget.js'
import type { Message } from '../types/message.js'
import { openBrowser, openPath } from '../services/browser/browser.js'
import { isFullscreenEnvEnabled } from '../services/terminal/fullscreen.js'
import { plural } from '../utils/stringUtils.js'
import { isNullRenderingAttachment } from './messages/nullRenderingAttachments.js'
import PromptInputFooterSuggestions from './PromptInput/PromptInputFooterSuggestions.js'
import type { StickyPrompt } from './VirtualMessageList.js'

/** Rows of transcript context kept visible above the modal pane's ▔ divider. */
const MODAL_TRANSCRIPT_PEEK = 2

/** Context for scroll-derived chrome (sticky header, pill). StickyTracker
 *  in VirtualMessageList writes via this instead of threading a callback
 *  up through Messages → REPL → FullscreenLayout. The setter is stable so
 *  consuming this context never causes re-renders. */
export const ScrollChromeContext = createContext<{
  setStickyPrompt: (p: StickyPrompt | null) => void
}>({
  setStickyPrompt: () => {},
})
type Props = {
  /** Content that scrolls (messages, tool output) */
  scrollable: ReactNode
  /** Content pinned to the bottom (spinner, prompt, permissions) */
  bottom: ReactNode
  /** Content rendered inside the ScrollBox after messages — user can scroll
   *  up to see context while it's showing (used by PermissionRequest). */
  overlay?: ReactNode
  /** Absolute-positioned content anchored at the bottom-right of the
   *  ScrollBox area, floating over scrollback. Rendered inside the flexGrow
   *  region (not the bottom slot) so the overflowY:hidden cap doesn't clip
   *  it. Fullscreen only. */
  bottomFloat?: ReactNode
  /** Slash-command dialog content. Rendered in an absolute-positioned
   *  bottom-anchored pane (▔ divider, paddingX=2) that paints over the
   *  ScrollBox AND bottom slot. Provides ModalContext so Pane/Dialog inside
   *  skip their own frame. Fullscreen only; inline after overlay otherwise. */
  modal?: ReactNode
  /** Ref passed via ModalContext so Tabs (or any scroll-owning descendant)
   *  can attach it to their own ScrollBox for tall content. */
  modalScrollRef?: React.RefObject<ScrollBoxHandle | null>
  /** Ref to the scroll box for keyboard scrolling. RefObject (not Ref) so
   *  pillVisible's useSyncExternalStore can subscribe to scroll changes. */
  scrollRef?: RefObject<ScrollBoxHandle | null>
  /** Y-position (scrollHeight at snapshot) of the unseen-divider. Pill
   *  shows while viewport bottom hasn't reached this. Ref so REPL doesn't
   *  re-render on the one-shot snapshot write. */
  dividerYRef?: RefObject<number | null>
  /** Force-hide the pill (e.g. viewing a sub-agent task). */
  hidePill?: boolean
  /** Force-hide the sticky prompt header (e.g. viewing a teammate task). */
  hideSticky?: boolean
  /** Count for the pill text. 0 → "Jump to bottom", >0 → "N new messages". */
  newMessageCount?: number
  /** Called when the user clicks the "N new" pill. */
  onPillClick?: () => void
}

/**
 * Tracks the in-transcript "N new messages" divider position while the
 * user is scrolled up. Snapshots message count AND scrollHeight the first
 * time sticky breaks. scrollHeight ≈ the y-position of the divider in the
 * scroll content (it renders right after the last message that existed at
 * snapshot time).
 *
 * `pillVisible` lives in FullscreenLayout (not here) — it subscribes
 * directly to ScrollBox via useSyncExternalStore with a boolean snapshot
 * against `dividerYRef`, so per-frame scroll never re-renders REPL.
 * `dividerIndex` stays here because REPL needs it for computeUnseenDivider
 * → Messages' divider line; it changes only ~twice/scroll-session
 * (first scroll-away + repin), acceptable REPL re-render cost.
 *
 * `onScrollAway` must be called by every scroll-away action with the
 * handle; `onRepin` by submit/scroll-to-bottom.
 */
export function useUnseenDivider(messageCount: number): {
  /** Index into messages[] where the divider line renders. Cleared on
   *  sticky-resume (scroll back to bottom) so the "N new" line doesn't
   *  linger once everything is visible. */
  dividerIndex: number | null
  /** scrollHeight snapshot at first scroll-away — the divider's y-position.
   *  FullscreenLayout subscribes to ScrollBox and compares viewport bottom
   *  against this for pillVisible. Ref so writes don't re-render REPL. */
  dividerYRef: RefObject<number | null>
  onScrollAway: (handle: ScrollBoxHandle) => void
  onRepin: () => void
  /** Scroll the handle so the divider line is at the top of the viewport. */
  jumpToNew: (handle: ScrollBoxHandle | null) => void
  /** Shift dividerIndex and dividerYRef when messages are prepended
   *  (infinite scroll-back). indexDelta = number of messages prepended;
   *  heightDelta = content height growth in rows. */
  shiftDivider: (indexDelta: number, heightDelta: number) => void
} {
  const [dividerIndex, setDividerIndex] = useState<number | null>(null)
  // Ref 保存当前消息数量，供 onScrollAway 快照使用。在渲染体中写入
  //（而非 useEffect），这样在消息追加渲染与 effect 刷新之间到达的滚轮事件
  // 不会捕获到过时的数量（基线偏差一格）。React Compiler 在此处会退出优化——
  // 对于 REPL 中只实例化一次的 hook 来说可以接受。
  const countRef = useRef(messageCount)
  countRef.current = messageCount
  // scrollHeight 快照——分割线在内容坐标系中的 y 位置。仅用 ref：
  // 在 onScrollAway 中同步读取（setState 是批处理的，无法在同一个
  // 回调中读后写），同时供 FullscreenLayout 的 pillVisible 订阅使用。
  // null 表示固定在底部。
  const dividerYRef = useRef<number | null>(null)
  const onRepin = useCallback(() => {
    // 不要在这里清除 dividerYRef——同一 stdin 批次中竞态到达的触控板动量滚轮事件
    // 会看到 null 并重新快照，覆盖下方的 setDividerIndex(null)。下方的 useEffect
    // 会在 React 提交 null dividerIndex 后清除 ref，因此 ref 在状态稳定前保持非 null。
    setDividerIndex(null)
  }, [])
  const onScrollAway = useCallback((handle: ScrollBoxHandle) => {
    // 视口下方没有内容 → 没有可跳转的目标。涵盖两种情况：
    // • 会话为空/较短：scrollUp 调用 scrollTo(0) 会破坏 sticky 状态
    //   即使 scrollTop=0（新会话上的滚轮上滚会显示 pill）
    // • 底部点击选择：useDragToScroll.check() 调用 scrollTo(current) 破坏
    //   sticky 状态以便流式内容不会在选择下移动，然后触发 onScroll(false, …)
    //   但 scrollTop 仍在最大值
    // pendingDelta：scrollBy 累积但不更新 scrollTop。没有它的话，从最大值滚轮上滚
    // 会看到 scrollTop==max 并抑制 pill 显示。
    const max = Math.max(0, handle.getScrollHeight() - handle.getViewportHeight())
    if (handle.getScrollTop() + handle.getPendingDelta() >= max) {
      return
    }
    // 仅在第一次离开底部时快照。onScrollAway 在每次滚动操作时都会触发
    //（而不仅是初次离开 sticky）——此守卫保留原始基线，这样第二次 PageUp 时
    // 计数不会重置。后续调用仅为 ref 级别的空操作（不会触发 REPL 重新渲染）。
    if (dividerYRef.current === null) {
      dividerYRef.current = handle.getScrollHeight()
      // 新的滚动离开会话 → 将分割线移动到这里（替换旧的）
      setDividerIndex(countRef.current)
    }
  }, [])
  const jumpToNew = useCallback((handle_0: ScrollBoxHandle | null) => {
    if (!handle_0) {
      return
    }
    // scrollToBottom（而非 scrollTo(dividerY)）：设置 stickyScroll=true 使
    // useVirtualScroll 挂载尾部，render-node-to-output 固定 scrollTop=maxScroll。
    // scrollTo 设置 stickyScroll=false → 钳位（仍在 React 重新渲染前的顶部范围边界）
    // 会将 scrollTop 拉回，导致滚动不足。分割线保持渲染（dividerIndex 不变），
    // 因此用户可以看到新消息的起始位置；下次提交/显式滚动到底部时会清理。
    handle_0.scrollToBottom()
  }, [])

  // 同步 dividerYRef 与 dividerIndex。当 onRepin 触发（提交、滚动到底部）时，
  // 它将 dividerIndex 设为 null 但 ref 保持非 null——同一 stdin 批次中竞态到达的
  // 滚轮事件否则会看到 null 并重新快照。将 ref 清除延迟到 useEffect 保证 ref 在
  // React 提交 null dividerIndex 之前保持非 null，从而阻止 onScrollAway 中的 if-null 守卫。
  //
  // 同时处理 /clear、回退、teammate-view 切换——如果计数下降到分割线索引以下，
  // 分割线将指向空位置。
  useEffect(() => {
    if (dividerIndex === null) {
      dividerYRef.current = null
    } else if (messageCount < dividerIndex) {
      dividerYRef.current = null
      setDividerIndex(null)
    }
  }, [messageCount, dividerIndex])
  const shiftDivider = useCallback((indexDelta: number, heightDelta: number) => {
    setDividerIndex((idx) => (idx === null ? null : idx + indexDelta))
    if (dividerYRef.current !== null) {
      dividerYRef.current += heightDelta
    }
  }, [])
  return {
    dividerIndex,
    dividerYRef,
    onScrollAway,
    onRepin,
    jumpToNew,
    shiftDivider,
  }
}

/**
 * Counts assistant turns in messages[dividerIndex..end). A "turn" is what
 * users think of as "a new message from Zy" — not raw assistant entries
 * (one turn yields multiple entries: tool_use blocks + text blocks). We count
 * non-assistant→assistant transitions, but only for entries that actually
 * carry text — tool-use-only entries are skipped (like progress messages)
 * so "⏺ Searched for 13 patterns, read 6 files" doesn't tick the pill.
 */
export function countUnseenAssistantTurns(
  messages: readonly Message[],
  dividerIndex: number,
): number {
  let count = 0
  let prevWasAssistant = false
  for (let i = dividerIndex; i < messages.length; i++) {
    const m = messages[i]!
    if (m.type === 'progress') {
      continue
    }
    // 仅包含工具调用的 assistant 条目对用户来说不是"新消息"——
    // 与跳过 progress 消息一样跳过它们。prevWasAssistant 不会更新，
    // 因此紧随其后的文本块仍然算作同一个回合（一次 API 响应中的
    // tool_use + text = 1）。
    if (m.type === 'assistant' && !assistantHasVisibleText(m)) {
      continue
    }
    const isAssistant = m.type === 'assistant'
    if (isAssistant && !prevWasAssistant) {
      count++
    }
    prevWasAssistant = isAssistant
  }
  return count
}
function assistantHasVisibleText(m: Message): boolean {
  if (m.type !== 'assistant') {
    return false
  }
  const content = m.message.content
  if (!Array.isArray(content)) {
    return false
  }
  for (const b of content) {
    if (b.type === 'text' && b.text.trim() !== '') {
      return true
    }
  }
  return false
}
export type UnseenDivider = {
  firstUnseenUuid: Message['uuid']
  count: number
}

/**
 * Builds the unseenDivider object REPL passes to Messages + the pill.
 * Returns undefined only when no content has arrived past the divider
 * yet (messages[dividerIndex] doesn't exist). Once ANY message arrives
 * — including tool_use-only assistant entries and tool_result user entries
 * that countUnseenAssistantTurns skips — count floors at 1 so the pill
 * flips from "Jump to bottom" to "1 new message". Without the floor,
 * the pill stays "Jump to bottom" through an entire tool-call sequence
 * until Zy's text response lands.
 */
export function computeUnseenDivider(
  messages: readonly Message[],
  dividerIndex: number | null,
): UnseenDivider | undefined {
  if (dividerIndex === null) {
    return undefined
  }
  // 跳过 progress 和 null-rendering attachments 来选择分割线锚点——
  // Messages.tsx 在 dividerBeforeIndex 搜索之前将这些从 renderableMessages 中过滤掉，
  // 因此它们的 UUID 不会被找到 (CC-724)。Hook attachments 使用 randomUUID()，
  // 所以没有东西与它们的 24 字符前缀共享。
  let anchorIdx = dividerIndex
  while (
    anchorIdx < messages.length &&
    (messages[anchorIdx]?.type === 'progress' || isNullRenderingAttachment(messages[anchorIdx]!))
  ) {
    anchorIdx++
  }
  const uuid = messages[anchorIdx]?.uuid
  if (!uuid) {
    return undefined
  }
  const count = countUnseenAssistantTurns(messages, dividerIndex)
  return {
    firstUnseenUuid: uuid,
    count: Math.max(1, count),
  }
}

/**
 * Layout wrapper for the REPL. In fullscreen mode, puts scrollable
 * content in a sticky-scroll box and pins bottom content via flexbox.
 * Outside fullscreen mode, renders content sequentially so the existing
 * main-screen scrollback rendering works unchanged.
 *
 * Fullscreen mode defaults on for ants (ZY_CODE_NO_FLICKER=0 to opt out)
 * and off for external users (ZY_CODE_NO_FLICKER=1 to opt in).
 * The <AlternateScreen> wrapper
 * (alt buffer + mouse tracking + height constraint) lives at REPL's root
 * so nothing can accidentally render outside it.
 */
export function FullscreenLayout({
  scrollable,
  bottom,
  overlay,
  bottomFloat,
  modal,
  modalScrollRef,
  scrollRef,
  dividerYRef,
  hidePill = false,
  hideSticky = false,
  newMessageCount = 0,
  onPillClick,
}: Props) {
  const { rows: terminalRows, columns } = useTerminalSize()
  const [stickyPrompt, setStickyPrompt] = useState<StickyPrompt | null>(null)
  const chromeCtx = {
    setStickyPrompt,
  }
  const subscribe = (listener: () => void) => scrollRef?.current?.subscribe(listener) ?? _temp
  const pillVisible = useSyncExternalStore(subscribe, () => {
    const s = scrollRef?.current
    const dividerY = dividerYRef?.current
    if (!s || dividerY == null) {
      return false
    }
    return s.getScrollTop() + s.getPendingDelta() + s.getViewportHeight() < dividerY
  })
  useLayoutEffect(() => {
    if (!isFullscreenEnvEnabled()) {
      return
    }
    const ink = instances.get(process.stdout)
    if (!ink) {
      return
    }
    ink.onHyperlinkClick = (url) => {
      if (url.startsWith('file:')) {
        try {
          openPath(fileURLToPath(url))
        } catch {}
      } else {
        openBrowser(url)
      }
    }
    // 双击：sticky 区或 DOM hit 任一命中即跳转
    ink.onDoubleClickAt = (col, row) => {
      if (ink.isStickyHeaderRow(row) && ink.activateStickyHeader()) {
        return true
      }
      const sticky = findStickyHeaderHitMeta(ink.hitTestAt(col, row))
      if (!sticky) {
        return false
      }
      sticky.scrollTo()
      return true
    }
    return () => {
      ink.onHyperlinkClick = undefined
      ink.onDoubleClickAt = undefined
      ink.stickyHeaderZone = null
    }
  }, [])
  // CC 对齐：useInsertionEffect 只创建一次实例，useLayoutEffect 处理 resize。
  const vtppRef = useRef<VtPlusPlusRenderer | null>(null)
  useInsertionEffect(() => {
    if (!isFullscreenEnvEnabled()) return
    const ink = instances.get(process.stdout)
    if (!ink) return
    const vtpp = new VtPlusPlusRenderer(process.stdout, columns, terminalRows)
    vtpp.setup()
    vtppRef.current = vtpp
    ink.frameSink = (frame, stylePool) => {
      return vtpp.renderFrame(frame.screen, stylePool)
    }
    ink.vtppReset = () => vtpp.reset()
    return () => {
      ink.frameSink = null
      ink.vtppReset = null
      vtppRef.current = null
      vtpp.restore()
    }
  }, [])
  // CC 对齐：resize 时复用实例，调用 handleResize 清屏 + 重置状态
  useLayoutEffect(() => {
    vtppRef.current?.handleResize(columns, terminalRows)
  }, [columns, terminalRows])
  if (isFullscreenEnvEnabled()) {
    const sticky = hideSticky ? null : stickyPrompt
    const headerPrompt = sticky != null && sticky !== 'clicked' && overlay == null ? sticky : null
    const padCollapsed = sticky != null && overlay == null
    return (
      <PromptOverlayProvider>
        {
          <Box flexGrow={1} flexDirection="column" overflow="hidden">
            {headerPrompt && (
              <StickyPromptHeader
                text={headerPrompt.text}
                onClick={headerPrompt.scrollTo}
                scrollRef={scrollRef}
              />
            )}
            {
              <ScrollBox
                ref={scrollRef}
                flexGrow={1}
                flexDirection="column"
                paddingTop={padCollapsed ? 0 : 1}
                stickyScroll={true}
              >
                {<ScrollChromeContext value={chromeCtx}>{scrollable}</ScrollChromeContext>}
                {overlay}
              </ScrollBox>
            }
            {!hidePill && pillVisible && overlay == null && (
              <NewMessagesPill count={newMessageCount} onClick={onPillClick} />
            )}
            {bottomFloat != null && (
              <Box position="absolute" bottom={0} right={0} opaque={true}>
                {bottomFloat}
              </Box>
            )}
          </Box>
        }
        {
          <Box flexDirection="column" flexShrink={0} width="100%" maxHeight="50%">
            {<SuggestionsOverlay />}
            {<DialogOverlay />}
            <Box flexDirection="column" width="100%" flexGrow={1} overflowY="hidden">
              {bottom}
            </Box>
          </Box>
        }
        {modal != null && (
          <ModalContext
            value={{
              rows: terminalRows - MODAL_TRANSCRIPT_PEEK - 1,
              columns: columns - 4,
              scrollRef: modalScrollRef ?? null,
            }}
          >
            <Box
              position="absolute"
              bottom={0}
              left={0}
              right={0}
              maxHeight={terminalRows - MODAL_TRANSCRIPT_PEEK}
              flexDirection="column"
              overflow="hidden"
              opaque={true}
            >
              <Box flexShrink={0}>
                <Text color="permission">{'\u2594'.repeat(columns)}</Text>
              </Box>
              <Box flexDirection="column" paddingX={2} flexShrink={0} overflow="hidden">
                {modal}
              </Box>
            </Box>
          </ModalContext>
        )}
      </PromptOverlayProvider>
    )
  }
  return (
    <>
      {scrollable}
      {bottom}
      {overlay}
      {modal}
    </>
  )
}

// Slack 风格的 pill。绝对定位在 scrollwrap 底部={0} 的覆盖层——浮动在
// ScrollBox 最后一个内容行之上，仅遮住居中的 pill 文本（该行的其余部分
// 显示 ScrollBox 内容）。DECSTBM 移动 pill 像素造成的滚动涂抹在 Ink 层
// 修复（render-node-to-output.ts 中的 absoluteRectsPrev 第三遍，#23939）。
// count 为 0 时显示 "Jump to bottom"（已离开底部但尚无新消息——
// 用户之前认为聊天卡死的死区）。

function _temp() {}
function NewMessagesPill({ count, onClick }: { count: number; onClick?: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <Box position="absolute" bottom={0} left={0} right={0} justifyContent="center">
      <Box
        onClick={onClick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {
          <Text
            backgroundColor={hover ? 'userMessageBackgroundHover' : 'userMessageBackground'}
            dimColor={true}
          >
            {' '}
            {count > 0
              ? tSync('fullscreen.newMessages', {
                  count,
                  unit: plural(
                    count,
                    tSync('fullscreen.newMessageUnit_one'),
                    tSync('fullscreen.newMessageUnit_other'),
                  ),
                })
              : tSync('fullscreen.jumpToBottom')}{' '}
            {ARROW_DOWN}{' '}
          </Text>
        }
      </Box>
    </Box>
  )
}

// 上下文面包屑：向上滚动到历史记录时，将当前对话回合的提示固定在视口上方。
// 对齐 CC：onClick=scrollTo 跳回该用户消息起始处。
//
// 命中策略（WT / JetBrains 上 DOM hit-test 常失败，表现为无 hover）：
// 1) 向 ink.stickyHeaderZone 注册屏幕行区域（优先用 nodeCache，否则
//    ScrollBox.viewportTop-1 / 回退 y=0）
// 2) App.handleMouseEvent 按行号拦截 press/release，不依赖 onClick 冒泡
// 3) DOM onClick / onMouseEnter 仍保留作兜底
//
// 高度固定 1 行，避免 sticky 切换时 ScrollBox 跳动。
function StickyPromptHeader({
  text,
  onClick,
  scrollRef,
}: {
  text: string
  onClick?: () => void
  scrollRef?: RefObject<ScrollBoxHandle | null>
}) {
  const [hover, setHover] = useState(false)
  const elRef = useRef<DOMElement | null>(null)
  const onClickRef = useRef(onClick)
  onClickRef.current = onClick
  const setHoverRef = useRef(setHover)
  setHoverRef.current = setHover

  const headerRef = useCallback(
    (el: DOMElement | null) => {
      elRef.current = el
      registerStickyHeaderHitTarget(el, onClick)
    },
    [onClick],
  )

  // 把 sticky 屏幕行写入 ink，供鼠标事件按行命中（不靠 DOM hit-test）
  useLayoutEffect(() => {
    if (!onClick) {
      return
    }
    const ink = instances.get(process.stdout)
    if (!ink) {
      return
    }

    const publishZone = (): void => {
      const scrollTo = () => onClickRef.current?.()
      const setHoverFn = (h: boolean) => setHoverRef.current(h)
      const rect = elRef.current ? nodeCache.get(elRef.current) : undefined
      if (rect && rect.height > 0) {
        ink.stickyHeaderZone = {
          y: rect.y,
          height: Math.max(1, Math.floor(rect.height)),
          scrollTo,
          setHover: setHoverFn,
        }
        return
      }
      // nodeCache 未就绪：sticky 在 ScrollBox 上方 1 行
      const vpTop = scrollRef?.current?.getViewportTop()
      const y = vpTop != null && vpTop > 0 ? vpTop - 1 : 0
      ink.stickyHeaderZone = {
        y,
        height: 1,
        scrollTo,
        setHover: setHoverFn,
      }
    }

    publishZone()
    // 滚动/重绘后 viewportTop 可能变，订阅 ScrollBox 刷新 zone
    const unsub = scrollRef?.current?.subscribe(publishZone)
    // 下一帧再刷一次（nodeCache 在 Ink paint 后才有值）
    const raf =
      typeof requestAnimationFrame === 'function' ? requestAnimationFrame(publishZone) : undefined
    return () => {
      unsub?.()
      if (raf !== undefined) {
        cancelAnimationFrame(raf)
      }
      ink.stickyHeaderZone = null
      setHoverRef.current(false)
    }
  }, [onClick, text, scrollRef])

  return (
    <Box
      ref={headerRef}
      flexShrink={0}
      width="100%"
      height={1}
      paddingRight={1}
      noSelect={true}
      backgroundColor={hover ? 'userMessageBackgroundHover' : 'userMessageBackground'}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {
        <Text color="subtle" wrap="truncate-end">
          {POINTER} {text}
        </Text>
      }
    </Box>
  )
}

// 斜杠命令建议覆盖层——参见 promptOverlayContext.tsx 了解为何要 portal 出去。
// 浮动在 DECSTBM 区域上方的滚动涂抹在 Ink 层修复
//（render-node-to-output.ts 中的 absoluteRectsPrev）。
// 渲染器将绝对元素的负 y 值钳位为 0（参见 render-node-to-output.ts），
// 因此即使覆盖层延伸到视口上方，顶行（最佳匹配）仍然可见。
// 此处省略 minHeight 和 flex-end：它们会创建空填充行，当列表项数少于最大值时，
// 会将可见项下移到提示区域。
function SuggestionsOverlay() {
  const data = usePromptOverlay()
  if (!data || data.suggestions.length === 0) {
    return null
  }
  return (
    <Box
      position="absolute"
      bottom="100%"
      left={0}
      right={0}
      paddingX={2}
      paddingTop={1}
      flexDirection="column"
      opaque={true}
    >
      <PromptInputFooterSuggestions
        suggestions={data.suggestions}
        selectedSuggestion={data.selectedSuggestion}
        maxColumnWidth={data.maxColumnWidth}
        onAcceptSuggestion={data.onAcceptSuggestion}
        onClickSuggestion={data.onClickSuggestion}
        overlay={true}
      />
    </Box>
  )
}

// 从 PromptInput portal 出去的对话框（AutoModeOptInDialog）——与 SuggestionsOverlay
// 相同的 clip-escape 模式。在树序中靠后渲染，这样如果两者同时显示时会覆盖建议列表
//（它们不应该同时出现）。
function DialogOverlay() {
  const node = usePromptOverlayDialog()
  if (!node) {
    return null
  }
  return (
    <Box position="absolute" bottom="100%" left={0} right={0} opaque={true}>
      {node}
    </Box>
  )
}
