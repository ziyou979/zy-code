import type { RefObject } from 'react';
import * as React from 'react';
import { useCallback, useContext, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore } from 'react';
import { useVirtualScroll } from '../hooks/useVirtualScroll.js';
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js';
import type { DOMElement } from '../ink/dom.js';
import type { MatchPosition } from '../ink/render-to-screen.js';
import { Box } from '../ink.js';
import type { RenderableMessage } from '../types/message.js';
import { TextHoverColorContext } from './design-system/ThemedText.js';
import { ScrollChromeContext } from './FullscreenLayout.js';

// scrollTo 时目标上方留出的空间行数。
const HEADROOM = 3;
import { logForDebugging } from '../utils/debug.js';
import { sleep } from '../utils/sleep.js';
import { renderableSearchText } from '../utils/transcriptSearch.js';
import { isNavigableMessage, type MessageActionsNav, type MessageActionsState, type NavigableMessage, stripSystemReminders, toolCallOf } from './messageActions.js';

// 后备提取器：在此处降低并缓存，供没有 Messages.tsx 工具查找路径的调用者使用
//（测试、静态上下文）。Messages.tsx 提供自己的降低缓存，还处理 tool extractSearchText。
const fallbackLowerCache = new WeakMap<RenderableMessage, string>();
function defaultExtractSearchText(msg: RenderableMessage): string {
  const cached = fallbackLowerCache.get(msg);
  if (cached !== undefined) return cached;
  const lowered = renderableSearchText(msg);
  fallbackLowerCache.set(msg, lowered);
  return lowered;
}
export type StickyPrompt = {
  text: string;
  scrollTo: () => void;
}
// 点击设置此值——头部隐藏但 padding 保持折叠（0），这样内容 ❯ 落在屏幕第 0 行而非第 1 行。
// 下次 sticky-prompt 计算时清除（用户再次滚动）。
| 'clicked';

/** 超大粘贴提示（cat file | zy）可能达 MB 级。头部通过 overflow:hidden 换行为
 *  2 行——这仅限制 React 属性大小。*/
const STICKY_TEXT_CAP = 500;

/** 转录导航的命令式句柄。方法在此计算匹配项（renderableMessages 索引仅在此组件内有效——
 *  Messages.tsx 过滤并重新排序，REPL 无法在外部计算）。*/
export type JumpHandle = {
  jumpToIndex: (i: number) => void;
  setSearchQuery: (q: string) => void;
  nextMatch: () => void;
  prevMatch: () => void;
  /** 捕获当前 scrollTop 作为 incsearch 锚点。输入时预览会跳动；
   *  0 匹配时回到此处。Enter/n/N 从不恢复（它们不调用空字符串的 setSearchQuery）。
   *  下次 / 调用会覆盖。*/
  setAnchor: () => void;
  /** 预热搜索文本缓存，提取每条消息的文本。返回耗时 ms，
   *  或 0 如果已预热（同一转录会话中的后续 /）。
   *  工作前 yield 以便调用者先绘制 "indexing…"。调用者在 resolve 后显示 "indexed in Xms"。*/
  warmSearchIndex: () => Promise<number>;
  /** 手动滚动（j/k/PgUp/滚轮）退出了搜索上下文。清除位置
   *  （黄色标记消失，反向高亮保留）。下次 n/N 通过 step()→jump() 重新建立。
   *  从 ScrollKeybindingHandler 的 onScroll 连接——仅对键盘/滚轮触发，不对编程式 scrollTo 触发。*/
  disarmSearch: () => void;
};
type Props = {
  messages: RenderableMessage[];
  scrollRef: RefObject<ScrollBoxHandle | null>;
  /** 更改时使 heightCache 失效——来自不同宽度的缓存高度是错误的
   *  （文本重新换行→放大后向上滚动时黑屏）。*/
  columns: number;
  itemKey: (msg: RenderableMessage) => string;
  renderItem: (msg: RenderableMessage, index: number) => React.ReactNode;
  /** Fires when a message Box is clicked (toggle per-message verbose). */
  onItemClick?: (msg: RenderableMessage) => void;
  /** Per-item filter — suppress hover/click for messages where the verbose
   *  toggle does nothing (text, file edits, etc). Defaults to all-clickable. */
  isItemClickable?: (msg: RenderableMessage) => boolean;
  /** Expanded items get a persistent grey bg (not just on hover). */
  isItemExpanded?: (msg: RenderableMessage) => boolean;
  /** PRE-LOWERED search text. Messages.tsx caches the lowered result
   *  once at warm time so setSearchQuery's per-keystroke loop does
   *  only indexOf (zero toLowerCase alloc). Falls back to a lowering
   *  wrapper on renderableSearchText for callers without the cache. */
  extractSearchText?: (msg: RenderableMessage) => string;
  /** Enable the sticky-prompt tracker. StickyTracker writes via
   *  ScrollChromeContext (not a callback prop) so state lives in
   *  FullscreenLayout instead of REPL. */
  trackStickyPrompt?: boolean;
  selectedIndex?: number;
  /** 导航句柄放在这里因为高度测量在这里。*/
  cursorNavRef?: React.Ref<MessageActionsNav>;
  setCursor?: (c: MessageActionsState | null) => void;
  jumpRef?: RefObject<JumpHandle | null>;
  /** 搜索匹配变化时触发（查询编辑、n/N）。current 是 1 基的用于 "3/47" 显示；
   *  0 表示没有匹配项。*/
  onSearchMatchesChange?: (count: number, current: number) => void;
  /** 将现有 DOM 子树绘制到新的 Screen 并扫描。来自主树的元素（包含所有 provider）。
   *  消息相对的位置（row 0 = 元素顶部）。适用于任何高度——填补高消息的间隙。*/
  scanElement?: (el: DOMElement) => MatchPosition[];
  /** 基于位置的 CURRENT 高亮。位置预先已知（来自 scanElement），
   *  导航 = 索引算术 + scrollTo。rowOffset = 消息当前屏幕顶部；位置保持稳定。*/
  setPositions?: (state: {
    positions: MatchPosition[];
    rowOffset: number;
    currentIdx: number;
  } | null) => void;
};

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
const promptTextCache = new WeakMap<RenderableMessage, string | null>();
function stickyPromptText(msg: RenderableMessage): string | null {
  // 以消息对象为键的缓存——消息是追加的且不会突变，
  // 所以 WeakMap 命中始终有效。walk（StickyTracker，每次滚动 tick）
  // 每个 tick 用相同的消息调用此函数 5-50+ 次；系统提醒剥离每次
  // 解析都分配新字符串。WeakMap 在压缩/清除时自动 GC（messages[] 被替换）。
  const cached = promptTextCache.get(msg);
  if (cached !== undefined) return cached;
  const result = computeStickyPromptText(msg);
  promptTextCache.set(msg, result);
  return result;
}
function computeStickyPromptText(msg: RenderableMessage): string | null {
  let raw: string | null = null;
  if (msg.type === 'user') {
    if (msg.isMeta || msg.isVisibleInTranscriptOnly) return null;
    const block = msg.message.content[0];
    if (block?.type !== 'text') return null;
    raw = block.text;
  } else if (msg.type === 'attachment' && msg.attachment.type === 'queued_command' && msg.attachment.commandMode !== 'task-notification' && !msg.attachment.isMeta) {
    const p = msg.attachment.prompt;
    raw = typeof p === 'string' ? p : p.flatMap(b => b.type === 'text' ? [b.text] : []).join('\n');
  }
  if (raw === null) return null;
  const t = stripSystemReminders(raw);
  if (t.startsWith('<') || t === '') return null;
  return t;
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
  itemKey: string;
  msg: RenderableMessage;
  idx: number;
  measureRef: (key: string) => (el: DOMElement | null) => void;
  expanded: boolean | undefined;
  hovered: boolean;
  clickable: boolean;
  onClickK: (msg: RenderableMessage, cellIsBlank: boolean) => void;
  onEnterK: (k: string) => void;
  onLeaveK: (k: string) => void;
  renderItem: (msg: RenderableMessage, idx: number) => React.ReactNode;
};

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
  renderItem
}: VirtualItemProps) {
  const t1 = measureRef(k);
  const t8 = renderItem(msg, idx);
  return <Box ref={t1} flexDirection="column" backgroundColor={expanded ? "userMessageBackgroundHover" : undefined} paddingBottom={expanded ? 1 : undefined} onClick={clickable ? e => onClickK(msg, e.cellIsBlank) : undefined} onMouseEnter={clickable ? () => onEnterK(k) : undefined} onMouseLeave={clickable ? () => onLeaveK(k) : undefined}>{<TextHoverColorContext.Provider value={hovered && !expanded ? "text" : undefined}>{t8}</TextHoverColorContext.Provider>}</Box>;
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
  setPositions
}: Props): React.ReactNode {
  // 增量 key 数组。流式追加每次一条消息；每次提交重建
  // 完整字符串数组会为每条消息分配 O(n)（27k 消息时约 1MB  churn）。
  // 前缀匹配时仅追加增量 push；在压缩、/clear 或 itemKey 更改时回退到完整重建。
  const keysRef = useRef<string[]>([]);
  const prevMessagesRef = useRef<typeof messages>(messages);
  const prevItemKeyRef = useRef(itemKey);
  if (prevItemKeyRef.current !== itemKey || messages.length < keysRef.current.length || messages[0] !== prevMessagesRef.current[0]) {
    keysRef.current = messages.map(m => itemKey(m));
  } else {
    for (let i = keysRef.current.length; i < messages.length; i++) {
      keysRef.current.push(itemKey(messages[i]!));
    }
  }
  prevMessagesRef.current = messages;
  prevItemKeyRef.current = itemKey;
  const keys = keysRef.current;
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
    scrollToIndex
  } = useVirtualScroll(scrollRef, keys, columns);
  const [start, end] = range;

  // 未测量（高度 undefined）的穿过——假设可见。
  const isVisible = useCallback((i: number) => {
    const h = getItemHeight(i);
    if (h === 0) return false;
    return isNavigableMessage(messages[i]!);
  }, [getItemHeight, messages]);
  useImperativeHandle(cursorNavRef, (): MessageActionsNav => {
    const select = (m: NavigableMessage) => setCursor?.({
      uuid: m.uuid,
      msgType: m.type,
      expanded: false,
      toolName: toolCallOf(m)?.name
    });
    const selIdx = selectedIndex ?? -1;
    const scan = (from: number, dir: 1 | -1, pred: (i: number) => boolean = isVisible) => {
      for (let i = from; i >= 0 && i < messages.length; i += dir) {
        if (pred(i)) {
          select(messages[i]!);
          return true;
        }
      }
      return false;
    };
    const isUser = (i: number) => isVisible(i) && messages[i]!.type === 'user';
    return {
      // 通过 shift+↑ 进入 = 与光标内 shift+↑ 相同语义（prevUser）。
      enterCursor: () => scan(messages.length - 1, -1, isUser),
      navigatePrev: () => scan(selIdx - 1, -1),
      navigateNext: () => {
        if (scan(selIdx + 1, 1)) return;
        // 超过最后可见项 → 退出并重新固定。最后消息的顶部在视口
        // 顶部（选择滚动效果）；其底部可能在视口下方。
        scrollRef.current?.scrollToBottom();
        setCursor?.(null);
      },
      // type:'user' only — queued_command attachments look like prompts but have no raw UserMessage to rewind to.
      navigatePrevUser: () => scan(selIdx - 1, -1, isUser),
      navigateNextUser: () => scan(selIdx + 1, 1, isUser),
      navigateTop: () => scan(0, 1),
      navigateBottom: () => scan(messages.length - 1, -1),
      getSelected: () => selIdx >= 0 ? messages[selIdx] ?? null : null
    };
  }, [messages, selectedIndex, setCursor, isVisible]);
  // 两阶段跳转 + 搜索引擎。通过 ref 读取以保持句柄在渲染间稳定——
  // offsets/messages 标识每次渲染都变化，不能放在 useImperativeHandle 依赖中而不重新创建句柄。
  const jumpState = useRef({
    offsets,
    start,
    getItemElement,
    getItemTop,
    messages,
    scrollToIndex
  });
  jumpState.current = {
    offsets,
    start,
    getItemElement,
    getItemTop,
    messages,
    scrollToIndex
  };

  // 保持光标选中的消息可见。offsets 每次重建重新构建
  // ——作为裸依赖会在每次鼠标滚轮 tick 时重新固定。改为通过
  // jumpState 读取；超出 overscan 的跳转通过 scrollToIndex 着陆，
  // 下次导航是精确的。
  useEffect(() => {
    if (selectedIndex === undefined) return;
    const s = jumpState.current;
    const el = s.getItemElement(selectedIndex);
    if (el) {
      scrollRef.current?.scrollToElement(el, 1);
    } else {
      s.scrollToIndex(selectedIndex);
    }
  }, [selectedIndex, scrollRef]);

  // 待处理的搜索请求。jump() 设置此项 + 增加 seekGen。搜索
  // effect 在绘制后触发（passive effect——resetAfterCommit 之后），
  // 检查目标是否已挂载。是 → 扫描并高亮。否 → 用更新的锚点
  //（start 向 idx 移动）重新估计并再次 scrollTo。
  const scanRequestRef = useRef<{
    idx: number;
    wantLast: boolean;
    tries: number;
  } | null>(null);
  // 来自 scanElement 的消息相对位置。Row 0 = 消息顶部。
  // 滚动时保持稳定——highlight 重新计算 rowOffset。msgIdx
  // 用于计算 rowOffset = getItemTop(msgIdx) - scrollTop。
  const elementPositions = useRef<{
    msgIdx: number;
    positions: MatchPosition[];
  }>({
    msgIdx: -1,
    positions: []
  });
  // 回绕保护。如果 ptr 回绕到此位置，自动前进停止。
  const startPtrRef = useRef(-1);
  // 幻影突发限制。扫描成功时重置。
  const phantomBurstRef = useRef(0);
  // 单深度队列：搜索进行中的 n/N 会被存储（不丢弃）并在搜索完成后触发。
  // 按住 n 保持平滑，不会排队 30 次跳转。最新按下覆盖——我们需要用户
  // 当前前进的方向，而不是 10 次按键之前的方向。
  const pendingStepRef = useRef<1 | -1 | 0>(0);
  // step + highlight via ref so the seek effect reads latest without
  // closure-capture or deps churn.
  const stepRef = useRef<(d: 1 | -1) => void>(() => {});
  const highlightRef = useRef<(ord: number) => void>(() => {});
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
    prefixSum: [] as number[]
  });
  // scrollTop at the moment / was pressed. Incsearch preview-jumps snap
  // back here when matches drop to 0. -1 = no anchor (before first /).
  const searchAnchor = useRef(-1);
  const indexWarmed = useRef(false);

  // Scroll target for message i: land at MESSAGE TOP. est = top - HEADROOM
  // so lo = top - est = HEADROOM ≥ 0 (or lo = top if est clamped to 0).
  // Post-clamp read-back in jump() handles the scrollHeight boundary.
  // No frac (render transform didn't respect it), no monotone clamp
  // (was a safety net for frac garbage — without frac, est IS the next
  // message's top, spam-n/N converges because message tops are ordered).
  function targetFor(i: number): number {
    const top = jumpState.current.getItemTop(i);
    return Math.max(0, top - HEADROOM);
  }

  // Highlight positions[ord]. Positions are MESSAGE-RELATIVE (row 0 =
  // element top, from scanElement). Compute rowOffset = getItemTop -
  // scrollTop fresh. If ord's position is off-viewport, scroll to bring
  // it in, recompute rowOffset. setPositions triggers overlay write.
  function highlight(ord: number): void {
    const s = scrollRef.current;
    const {
      msgIdx,
      positions
    } = elementPositions.current;
    if (!s || positions.length === 0 || msgIdx < 0) {
      setPositions?.(null);
      return;
    }
    const idx = Math.max(0, Math.min(ord, positions.length - 1));
    const p = positions[idx]!;
    const top = jumpState.current.getItemTop(msgIdx);
    // lo = item's position within scroll content (wrapper-relative).
    // viewportTop = where the scroll content starts on SCREEN (after
    // ScrollBox padding/border + any chrome above). Highlight writes to
    // screen-absolute, so rowOffset = viewportTop + lo. Observed: off-by-
    // 1+ without viewportTop (FullscreenLayout has paddingTop=1 on the
    // ScrollBox, plus any header above).
    const vpTop = s.getViewportTop();
    let lo = top - s.getScrollTop();
    const vp = s.getViewportHeight();
    let screenRow = vpTop + lo + p.row;
    // Off viewport → scroll to bring it in (HEADROOM from top).
    // scrollTo commits sync; read-back after gives fresh lo.
    if (screenRow < vpTop || screenRow >= vpTop + vp) {
      s.scrollTo(Math.max(0, top + p.row - HEADROOM));
      lo = top - s.getScrollTop();
      screenRow = vpTop + lo + p.row;
    }
    setPositions?.({
      positions,
      rowOffset: vpTop + lo,
      currentIdx: idx
    });
    // Badge: global current = sum of occurrences before this msg + ord+1.
    // prefixSum[ptr] is engine-counted (indexOf on extractSearchText);
    // may drift from render-count for ghost messages but close enough —
    // badge is a rough location hint, not a proof.
    const st = searchState.current;
    const total = st.prefixSum.at(-1) ?? 0;
    const current = (st.prefixSum[st.ptr] ?? 0) + idx + 1;
    onSearchMatchesChange?.(total, current);
    logForDebugging(`highlight(i=${msgIdx}, ord=${idx}/${positions.length}): ` + `pos={row:${p.row},col:${p.col}} lo=${lo} screenRow=${screenRow} ` + `badge=${current}/${total}`);
  }
  highlightRef.current = highlight;

  // Seek effect. jump() sets scanRequestRef + scrollToIndex + bump.
  // bump → re-render → useVirtualScroll mounts the target (scrollToIndex
  // guarantees this — scrollTop and topSpacer agree via the same
  // offsets value) → resetAfterCommit paints → this passive effect
  // fires POST-PAINT with the element mounted. Precise scrollTo + scan.
  //
  // Dep is ONLY seekGen — effect doesn't re-run on random renders
  // (onSearchMatchesChange churn during incsearch).
  const [seekGen, setSeekGen] = useState(0);
  const bumpSeek = useCallback(() => setSeekGen(g => g + 1), []);
  useEffect(() => {
    const req = scanRequestRef.current;
    if (!req) return;
    const {
      idx,
      wantLast,
      tries
    } = req;
    const s = scrollRef.current;
    if (!s) return;
    const {
      getItemElement,
      getItemTop,
      scrollToIndex
    } = jumpState.current;
    const el = getItemElement(idx);
    const h = el?.yogaNode?.getComputedHeight() ?? 0;
    if (!el || h === 0) {
      // Not mounted after scrollToIndex. Shouldn't happen — scrollToIndex
      // guarantees mount by construction (scrollTop and topSpacer agree
      // via the same offsets value). Sanity: retry once, then skip.
      if (tries > 1) {
        scanRequestRef.current = null;
        logForDebugging(`seek(i=${idx}): no mount after scrollToIndex, skip`);
        stepRef.current(wantLast ? -1 : 1);
        return;
      }
      scanRequestRef.current = {
        idx,
        wantLast,
        tries: tries + 1
      };
      scrollToIndex(idx);
      bumpSeek();
      return;
    }
    scanRequestRef.current = null;
    // Precise scrollTo — scrollToIndex got us in the neighborhood
    // (item is mounted, maybe a few-dozen rows off due to overscan
    // estimate drift). Now land it at top-HEADROOM.
    s.scrollTo(Math.max(0, getItemTop(idx) - HEADROOM));
    const positions = scanElement?.(el) ?? [];
    elementPositions.current = {
      msgIdx: idx,
      positions
    };
    logForDebugging(`seek(i=${idx} t=${tries}): ${positions.length} positions`);
    if (positions.length === 0) {
      // Phantom — engine matched, render didn't. Auto-advance.
      if (++phantomBurstRef.current > 20) {
        phantomBurstRef.current = 0;
        return;
      }
      stepRef.current(wantLast ? -1 : 1);
      return;
    }
    phantomBurstRef.current = 0;
    const ord = wantLast ? positions.length - 1 : 0;
    searchState.current.screenOrd = ord;
    startPtrRef.current = -1;
    highlightRef.current(ord);
    const pending = pendingStepRef.current;
    if (pending) {
      pendingStepRef.current = 0;
      stepRef.current(pending);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekGen]);

  // Scroll to message i's top, arm scanPending. scan-effect reads fresh
  // screen next tick. wantLast: N-into-message — screenOrd = length-1.
  function jump(i: number, wantLast: boolean): void {
    const s = scrollRef.current;
    if (!s) return;
    const js = jumpState.current;
    const {
      getItemElement,
      scrollToIndex
    } = js;
    // offsets is a Float64Array whose .length is the allocated buffer (only
    // grows) — messages.length is the logical item count.
    if (i < 0 || i >= js.messages.length) return;
    // Clear stale highlight before scroll. Between now and the seek
    // effect's highlight, inverse-only from scan-highlight shows.
    setPositions?.(null);
    elementPositions.current = {
      msgIdx: -1,
      positions: []
    };
    scanRequestRef.current = {
      idx: i,
      wantLast,
      tries: 0
    };
    const el = getItemElement(i);
    const h = el?.yogaNode?.getComputedHeight() ?? 0;
    // Mounted → precise scrollTo. Unmounted → scrollToIndex mounts it
    // (scrollTop and topSpacer agree via the same offsets value — exact
    // by construction, no estimation). Seek effect does the precise
    // scrollTo after paint either way.
    if (el && h > 0) {
      s.scrollTo(targetFor(i));
    } else {
      scrollToIndex(i);
    }
    bumpSeek();
  }

  // Advance screenOrd within elementPositions. Exhausted → ptr advances,
  // jump to next matches[ptr], re-scan. Phantom (scan found 0 after
  // jump) triggers auto-advance from scan-effect. Wraparound guard stops
  // if every message is a phantom.
  function step(delta: 1 | -1): void {
    const st = searchState.current;
    const {
      matches,
      prefixSum
    } = st;
    const total = prefixSum.at(-1) ?? 0;
    if (matches.length === 0) return;

    // Seek in-flight — queue this press (one-deep, latest overwrites).
    // The seek effect fires it after highlight.
    if (scanRequestRef.current) {
      pendingStepRef.current = delta;
      return;
    }
    if (startPtrRef.current < 0) startPtrRef.current = st.ptr;
    const {
      positions
    } = elementPositions.current;
    const newOrd = st.screenOrd + delta;
    if (newOrd >= 0 && newOrd < positions.length) {
      st.screenOrd = newOrd;
      highlight(newOrd); // updates badge internally
      startPtrRef.current = -1;
      return;
    }

    // Exhausted visible. Advance ptr → jump → re-scan.
    const ptr = (st.ptr + delta + matches.length) % matches.length;
    if (ptr === startPtrRef.current) {
      setPositions?.(null);
      startPtrRef.current = -1;
      logForDebugging(`step: wraparound at ptr=${ptr}, all ${matches.length} msgs phantoms`);
      return;
    }
    st.ptr = ptr;
    st.screenOrd = 0; // resolved after scan (wantLast → length-1)
    jump(matches[ptr]!, delta < 0);
    // screenOrd will resolve after scan. Best-effort: prefixSum[ptr] + 0
    // for n (first pos), prefixSum[ptr+1] for N (last pos = count-1).
    // The scan-effect's highlight will be the real value; this is a
    // pre-scan placeholder so the badge updates immediately.
    const placeholder = delta < 0 ? prefixSum[ptr + 1] ?? total : prefixSum[ptr]! + 1;
    onSearchMatchesChange?.(total, placeholder);
  }
  stepRef.current = step;
  useImperativeHandle(jumpRef, () => ({
    // Non-search jump (sticky header click, etc). No scan, no positions.
    jumpToIndex: (i: number) => {
      const s = scrollRef.current;
      if (s) s.scrollTo(targetFor(i));
    },
    setSearchQuery: (q: string) => {
      // New search invalidates everything.
      scanRequestRef.current = null;
      elementPositions.current = {
        msgIdx: -1,
        positions: []
      };
      startPtrRef.current = -1;
      setPositions?.(null);
      const lq = q.toLowerCase();
      // One entry per MESSAGE (deduplicated). Boolean "does this msg
      // contain the query". ~10ms for 9k messages with cached lowered.
      const matches: number[] = [];
      // Per-message occurrence count → prefixSum for global current
      // index. Engine-counted (cheap indexOf loop); may differ from
      // render-count (scanElement) for ghost/phantom messages but close
      // enough for the badge. The badge is a rough location hint.
      const prefixSum: number[] = [0];
      if (lq) {
        const msgs = jumpState.current.messages;
        for (let i = 0; i < msgs.length; i++) {
          const text = extractSearchText(msgs[i]!);
          let pos = text.indexOf(lq);
          let cnt = 0;
          while (pos >= 0) {
            cnt++;
            pos = text.indexOf(lq, pos + lq.length);
          }
          if (cnt > 0) {
            matches.push(i);
            prefixSum.push(prefixSum.at(-1)! + cnt);
          }
        }
      }
      const total = prefixSum.at(-1)!;
      // Nearest MESSAGE to the anchor. <= so ties go to later.
      let ptr = 0;
      const s = scrollRef.current;
      const {
        offsets,
        start,
        getItemTop
      } = jumpState.current;
      const firstTop = getItemTop(start);
      const origin = firstTop >= 0 ? firstTop - offsets[start]! : 0;
      if (matches.length > 0 && s) {
        const curTop = searchAnchor.current >= 0 ? searchAnchor.current : s.getScrollTop();
        let best = Infinity;
        for (let k = 0; k < matches.length; k++) {
          const d = Math.abs(origin + offsets[matches[k]!]! - curTop);
          if (d <= best) {
            best = d;
            ptr = k;
          }
        }
        logForDebugging(`setSearchQuery('${q}'): ${matches.length} msgs · ptr=${ptr} ` + `msgIdx=${matches[ptr]} curTop=${curTop} origin=${origin}`);
      }
      searchState.current = {
        matches,
        ptr,
        screenOrd: 0,
        prefixSum
      };
      if (matches.length > 0) {
        // wantLast=true: preview the LAST occurrence in the nearest
        // message. At sticky-bottom (common / entry), nearest is the
        // last msg; its last occurrence is closest to where the user
        // was — minimal view movement. n advances forward from there.
        jump(matches[ptr]!, true);
      } else if (searchAnchor.current >= 0 && s) {
        // /foob → 0 matches → snap back to anchor. less/vim incsearch.
        s.scrollTo(searchAnchor.current);
      }
      // Global occurrence count + 1-based current. wantLast=true so the
      // scan will land on the last occurrence in matches[ptr]. Placeholder
      // = prefixSum[ptr+1] (count through this msg). highlight() updates
      // to the exact value after scan completes.
      onSearchMatchesChange?.(total, matches.length > 0 ? prefixSum[ptr + 1] ?? total : 0);
    },
    nextMatch: () => step(1),
    prevMatch: () => step(-1),
    setAnchor: () => {
      const s = scrollRef.current;
      if (s) searchAnchor.current = s.getScrollTop();
    },
    disarmSearch: () => {
      // Manual scroll invalidates screen-absolute positions.
      setPositions?.(null);
      scanRequestRef.current = null;
      elementPositions.current = {
        msgIdx: -1,
        positions: []
      };
      startPtrRef.current = -1;
    },
    warmSearchIndex: async () => {
      if (indexWarmed.current) return 0;
      const msgs = jumpState.current.messages;
      const CHUNK = 500;
      let workMs = 0;
      const wallStart = performance.now();
      for (let i = 0; i < msgs.length; i += CHUNK) {
        await sleep(0);
        const t0 = performance.now();
        const end = Math.min(i + CHUNK, msgs.length);
        for (let j = i; j < end; j++) {
          extractSearchText(msgs[j]!);
        }
        workMs += performance.now() - t0;
      }
      const wallMs = Math.round(performance.now() - wallStart);
      logForDebugging(`warmSearchIndex: ${msgs.length} msgs · work=${Math.round(workMs)}ms wall=${wallMs}ms chunks=${Math.ceil(msgs.length / CHUNK)}`);
      indexWarmed.current = true;
      return Math.round(workMs);
    }
  }),
  // Closures over refs + callbacks. scrollRef stable; others are
  // useCallback([]) or prop-drilled from REPL (stable).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [scrollRef]);

  // StickyTracker goes AFTER the list content. It returns null (no DOM node)
  // so order shouldn't matter for layout — but putting it first means every
  // fine-grained commit from its own scroll subscription reconciles THROUGH
  // the sibling items (React walks children in order). After the items, it's
  // a leaf reconcile. Defensive: also avoids any Yoga child-index quirks if
  // the Ink reconciler ever materializes a placeholder for null returns.
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  // Stable click/hover handlers — called with k, dispatch from a ref so
  // closure identity doesn't change per render. The per-item handler
  // closures (`e => ...`, `() => setHoveredKey(k)`) were the
  // `operationNewArrowFunction` leafs in the scroll CPU profile; their
  // cleanup was 16% of GC time (`FunctionExecutable::finalizeUnconditionally`).
  // Allocating 3 closures × 60 mounted items × 10 commits/sec during fast
  // scroll = 1800 short-lived closures/sec. With stable refs the item
  // wrapper props don't change → VirtualItem.memo bails for the ~35
  // unchanged items, only ~25 fresh items pay createElement cost.
  const handlersRef = useRef({
    onItemClick,
    setHoveredKey
  });
  handlersRef.current = {
    onItemClick,
    setHoveredKey
  };
  const onClickK = useCallback((msg: RenderableMessage, cellIsBlank: boolean) => {
    const h = handlersRef.current;
    if (!cellIsBlank && h.onItemClick) h.onItemClick(msg);
  }, []);
  const onEnterK = useCallback((k: string) => {
    handlersRef.current.setHoveredKey(k);
  }, []);
  const onLeaveK = useCallback((k: string) => {
    handlersRef.current.setHoveredKey(prev => prev === k ? null : prev);
  }, []);
  return <>
      <Box ref={spacerRef} height={topSpacer} flexShrink={0} />
      {messages.slice(start, end).map((msg, i) => {
      const idx = start + i;
      const k = keys[idx]!;
      const clickable = !!onItemClick && (isItemClickable?.(msg) ?? true);
      const hovered = clickable && hoveredKey === k;
      const expanded = isItemExpanded?.(msg);
      return <VirtualItem key={k} itemKey={k} msg={msg} idx={idx} measureRef={measureRef} expanded={expanded} hovered={hovered} clickable={clickable} onClickK={onClickK} onEnterK={onEnterK} onLeaveK={onLeaveK} renderItem={renderItem} />;
    })}
      {bottomSpacer > 0 && <Box height={bottomSpacer} flexShrink={0} />}
      {trackStickyPrompt && <StickyTracker messages={messages} start={start} end={end} offsets={offsets} getItemTop={getItemTop} getItemElement={getItemElement} scrollRef={scrollRef} />}
    </>;
}
const NOOP_UNSUB = () => {};

/**
 * Effect-only child that tracks the last user-prompt scrolled above the
 * viewport top and fires onChange when it changes.
 *
 * Rendered as a separate component (not a hook in VirtualMessageList) so it
 * can subscribe to scroll at FINER granularity than SCROLL_QUANTUM=40. The
 * list needs the coarse quantum to avoid per-wheel-tick Yoga relayouts; this
 * tracker is just a walk + comparison and can afford to run every tick. When
 * it re-renders alone, the list's reconciled output is unchanged (same props
 * from the parent's last commit) — no Yoga work. Without this split, the
 * header lags by ~one conversation turn (40 rows ≈ one prompt + response).
 *
 * firstVisible derivation: item Boxes are direct Yoga children of the
 * ScrollBox content wrapper (fragments collapse in the Ink DOM), so
 * yoga.getComputedTop is content-wrapper-relative — same coordinate space as
 * scrollTop. Compare against scrollTop + pendingDelta (the scroll TARGET —
 * scrollBy only sets pendingDelta, committed scrollTop lags). Walk backward
 * from the mount-range end; break when an item's top is above target.
 */
function StickyTracker({
  messages,
  start,
  end,
  offsets,
  getItemTop,
  getItemElement,
  scrollRef
}: {
  messages: RenderableMessage[];
  start: number;
  end: number;
  offsets: ArrayLike<number>;
  getItemTop: (index: number) => number;
  getItemElement: (index: number) => DOMElement | null;
  scrollRef: RefObject<ScrollBoxHandle | null>;
}): null {
  const {
    setStickyPrompt
  } = useContext(ScrollChromeContext);
  // Fine-grained subscription — snapshot is unquantized scrollTop+delta so
  // every scroll action (wheel tick, PgUp, drag) triggers a re-render of
  // THIS component only. Sticky bit folded into the sign so sticky→broken
  // also triggers (scrollToBottom sets sticky without moving scrollTop).
  const subscribe = useCallback((listener: () => void) => scrollRef.current?.subscribe(listener) ?? NOOP_UNSUB, [scrollRef]);
  useSyncExternalStore(subscribe, () => {
    const s = scrollRef.current;
    if (!s) return NaN;
    const t = s.getScrollTop() + s.getPendingDelta();
    return s.isSticky() ? -1 - t : t;
  });

  // Read live scroll state on every render.
  const isSticky = scrollRef.current?.isSticky() ?? true;
  const target = Math.max(0, (scrollRef.current?.getScrollTop() ?? 0) + (scrollRef.current?.getPendingDelta() ?? 0));

  // Walk the mounted range to find the first item at-or-below the viewport
  // top. `range` is from the parent's coarse-quantum render (may be slightly
  // stale) but overscan guarantees it spans well past the viewport in both
  // directions. Items without a Yoga layout yet (newly mounted this frame)
  // are treated as at-or-below — they're somewhere in view, and assuming
  // otherwise would show a sticky for a prompt that's actually on screen.
  let firstVisible = start;
  let firstVisibleTop = -1;
  for (let i = end - 1; i >= start; i--) {
    const top = getItemTop(i);
    if (top >= 0) {
      if (top < target) break;
      firstVisibleTop = top;
    }
    firstVisible = i;
  }
  let idx = -1;
  let text: string | null = null;
  if (firstVisible > 0 && !isSticky) {
    for (let i = firstVisible - 1; i >= 0; i--) {
      const t = stickyPromptText(messages[i]!);
      if (t === null) continue;
      // The prompt's wrapping Box top is above target (that's why it's in
      // the [0, firstVisible) range), but its ❯ is at top+1 (marginTop=1).
      // If the ❯ is at-or-below target, it's VISIBLE at viewport top —
      // showing the same text in the header would duplicate it. Happens
      // in the 1-row gap between Box top scrolling past and ❯ scrolling
      // past. Skip to the next-older prompt (its ❯ is definitely above).
      const top = getItemTop(i);
      if (top >= 0 && top + 1 >= target) continue;
      idx = i;
      text = t;
      break;
    }
  }
  const baseOffset = firstVisibleTop >= 0 ? firstVisibleTop - offsets[firstVisible]! : 0;
  const estimate = idx >= 0 ? Math.max(0, baseOffset + offsets[idx]!) : -1;

  // For click-jumps to items not yet mounted (user scrolled far past,
  // prompt is in the topSpacer). Click handler scrolls to the estimate
  // to mount it; this anchors by element once it appears. scrollToElement
  // defers the Yoga-position read to render time (render-node-to-output
  // reads el.yogaNode.getComputedTop() in the SAME calculateLayout pass
  // that produces scrollHeight) — no throttle race. Cap retries: a /clear
  // race could unmount the item mid-sequence.
  const pending = useRef({
    idx: -1,
    tries: 0
  });
  // Suppression state machine. The click handler arms; the onChange effect
  // consumes (armed→force) then fires-and-clears on the render AFTER that
  // (force→none). The force step poisons the dedup: after click, idx often
  // recomputes to the SAME prompt (its top is still above target), so
  // without force the last.idx===idx guard would hold 'clicked' until the
  // user crossed a prompt boundary. Previously encoded in last.idx as
  // -1/-2/-3 which overlapped with real indices — too clever.
  type Suppress = 'none' | 'armed' | 'force';
  const suppress = useRef<Suppress>('none');
  // Dedup on idx only — estimate derives from firstVisibleTop which shifts
  // every scroll tick, so including it in the key made the guard dead
  // (setStickyPrompt fired a fresh {text,scrollTo} per-frame). The scrollTo
  // closure still captures the current estimate; it just doesn't need to
  // re-fire when only estimate moved.
  const lastIdx = useRef(-1);

  // setStickyPrompt effect FIRST — must see pending.idx before the
  // correction effect below clears it. On the estimate-fallback path, the
  // render that mounts the item is ALSO the render where correction clears
  // pending; if this ran second, the pending gate would be dead and
  // setStickyPrompt(prevPrompt) would fire mid-jump, re-mounting the
  // header over 'clicked'.
  useEffect(() => {
    // Hold while two-phase correction is in flight.
    if (pending.current.idx >= 0) return;
    if (suppress.current === 'armed') {
      suppress.current = 'force';
      return;
    }
    const force = suppress.current === 'force';
    suppress.current = 'none';
    if (!force && lastIdx.current === idx) return;
    lastIdx.current = idx;
    if (text === null) {
      setStickyPrompt(null);
      return;
    }
    // First paragraph only (split on blank line) — a prompt like
    // "still seeing bugs:\n\n1. foo\n2. bar" previews as just the
    // lead-in. trimStart so a leading blank line (queued_command mid-
    // turn messages sometimes have one) doesn't find paraEnd at 0.
    const trimmed = text.trimStart();
    const paraEnd = trimmed.search(/\n\s*\n/);
    const collapsed = (paraEnd >= 0 ? trimmed.slice(0, paraEnd) : trimmed).slice(0, STICKY_TEXT_CAP).replace(/\s+/g, ' ').trim();
    if (collapsed === '') {
      setStickyPrompt(null);
      return;
    }
    const capturedIdx = idx;
    const capturedEstimate = estimate;
    setStickyPrompt({
      text: collapsed,
      scrollTo: () => {
        // Hide header, keep padding collapsed — FullscreenLayout's
        // 'clicked' sentinel → scrollBox_y=0 + pad=0 → viewportTop=0.
        setStickyPrompt('clicked');
        suppress.current = 'armed';
        // scrollToElement anchors by DOMElement ref, not a number:
        // render-node-to-output reads el.yogaNode.getComputedTop() at
        // paint time (same Yoga pass as scrollHeight). No staleness from
        // the throttled render — the ref is stable, the position read is
        // deferred. offset=1 = UserPromptMessage marginTop.
        const el = getItemElement(capturedIdx);
        if (el) {
          scrollRef.current?.scrollToElement(el, 1);
        } else {
          // Not mounted (scrolled far past — in topSpacer). Jump to
          // estimate to mount it; correction effect re-anchors once it
          // appears. Estimate is DEFAULT_ESTIMATE-based — lands short.
          scrollRef.current?.scrollTo(capturedEstimate);
          pending.current = {
            idx: capturedIdx,
            tries: 0
          };
        }
      }
    });
    // No deps — must run every render. Suppression state lives in a ref
    // (not idx/estimate), so a deps-gated effect would never see it tick.
    // Body's own guards short-circuit when nothing changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  // Correction: for click-jumps to unmounted items. Click handler scrolled
  // to the estimate; this re-anchors by element once the item appears.
  // scrollToElement defers the Yoga read to paint time — deterministic.
  // SECOND so it clears pending AFTER the onChange gate above has seen it.
  useEffect(() => {
    if (pending.current.idx < 0) return;
    const el = getItemElement(pending.current.idx);
    if (el) {
      scrollRef.current?.scrollToElement(el, 1);
      pending.current = {
        idx: -1,
        tries: 0
      };
    } else if (++pending.current.tries > 5) {
      pending.current = {
        idx: -1,
        tries: 0
      };
    }
  });
  return null;
}
