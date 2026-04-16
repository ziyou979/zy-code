import React, { type PropsWithChildren, type Ref, useImperativeHandle, useRef, useState } from 'react';
import type { Except } from 'type-fest';
import { markScrollActivity } from '../../bootstrap/state.js';
import type { DOMElement } from '../dom.js';
import { markDirty, scheduleRenderFrom } from '../dom.js';
import { markCommitStart } from '../reconciler.js';
import type { Styles } from '../styles.js';
import '../global.d.ts';
import Box from './Box.js';
export type ScrollBoxHandle = {
  scrollTo: (y: number) => void;
  scrollBy: (dy: number) => void;
  /**
   * 滚动使 `el` 的顶部对齐到视口顶部（加上 `offset`）。与
   * scrollTo 不同，scrollTo 使用的是节流渲染触发时已过时的数值，
   * 而该方法将位置读取推迟到渲染时 ——
   * render-node-to-output 在计算 scrollHeight 的同一个 Yoga 渲染流程中
   * 读取 `el.yogaNode.getComputedTop()`。确定性执行，一次性完成。
   */
  scrollToElement: (el: DOMElement, offset?: number) => void;
  scrollToBottom: () => void;
  getScrollTop: () => number;
  getPendingDelta: () => number;
  getScrollHeight: () => number;
  /**
   * 类似于 getScrollHeight，但直接读取 Yoga 而非缓存值。
   * 缓存值由 render-node-to-output 写入（节流，最多过时 16ms）。
   * 当你在内容增长后的 React commit 之后，需要在 useLayoutEffect 中
   * 获取最新值时使用该方法。开销略大（需要调用原生 Yoga）。
   */
  getFreshScrollHeight: () => number;
  getViewportHeight: () => number;
  /**
   * 首个可见内容行的绝对屏幕缓冲行号（在 padding 内部）。
   * 用于拖拽滚动边缘检测。
   */
  getViewportTop: () => number;
  /**
   * 滚动是否钉在底部。由 scrollToBottom、初始 stickyScroll 属性、
   * 以及渲染器在 positional follow 触发时设置（内容增长时 scrollTop
   * 处于 prevMax）。被 scrollTo/scrollBy 清除。作为"在底部"的稳定信号，
   * 不依赖布局值（不像 scrollTop+viewportH >= scrollHeight）。
   */
  isSticky: () => boolean;
  /**
   * 订阅命令式滚动变化（scrollTo/scrollBy/scrollToBottom）。
   * 不会为 Ink 渲染器完成的 stickyScroll 更新触发 —— 那些发生在
   * React commit 之后的 Ink 渲染阶段。关心 sticky 场景的调用方
   * 应将"在底部"作为后备行为。
   */
  subscribe: (listener: () => void) => () => void;
  /**
   * 将渲染时的 scrollTop 钳位设置为当前已挂载子元素的覆盖范围。
   * 由 useVirtualScroll 在计算范围后调用；render-node-to-output
   * 将 scrollTop 钳位到 [min, max]，使得超过 React 异步重渲染的
   * 突发 scrollTo 调用会显示已挂载内容的边缘，而非空白占位符。
   * 传入 undefined 则禁用（sticky、冷启动场景）。
   */
  setClampBounds: (min: number | undefined, max: number | undefined) => void;
};
export type ScrollBoxProps = Except<Styles, 'textWrap' | 'overflow' | 'overflowX' | 'overflowY'> & {
  ref?: Ref<ScrollBoxHandle>;
  /**
   * 为 true 时，内容增长时自动将滚动位置钉在底部。
   * 可通过 scrollTo/scrollBy 手动解除粘性。
   */
  stickyScroll?: boolean;
};

/**
 * 带有 `overflow: scroll` 和命令式滚动 API 的 Box。
 *
 * 子元素在受限容器内以其完整的 Yoga 计算高度进行布局。
 * 渲染时，仅渲染与可见窗口（scrollTop..scrollTop+height）相交的
 * 子元素（视口裁剪）。内容通过 -scrollTop 平移并裁剪到盒子边界。
 *
 * 最适合在 Ink 全屏（受限高度的根）树内使用。
 */
function ScrollBox({
  children,
  ref,
  stickyScroll,
  ...style
}: PropsWithChildren<ScrollBoxProps>): React.ReactNode {
  const domRef = useRef<DOMElement>(null);
  // scrollTo/scrollBy 绕过 React：直接修改 DOM 节点上的 scrollTop，
  // 标记为 dirty，并调用根的节流 scheduleRender。
  // Ink 渲染器从节点读取 scrollTop —— 不需要 React 状态，
  // 每次 wheel 事件无需 reconciler 开销。微任务 defer 将一次输入批次
  //（discreteUpdates）中的多次 scrollBy 调用合并为一次渲染 ——
  // 否则 scheduleRender 的前沿会在第一个事件上触发，而后续事件还未
  // 修改 scrollTop。scrollToBottom 仍会触发 React 渲染：sticky 是
  // 属性观察的，没有纯 DOM 路径。
  const [, forceRender] = useState(0);
  const listenersRef = useRef(new Set<() => void>());
  const renderQueuedRef = useRef(false);
  const notify = () => {
    for (const l of listenersRef.current) l();
  };
  function scrollMutated(el: DOMElement): void {
    // 通知后台间隔（IDE 轮询、LSP 轮询、GCS 请求、孤立检查）
    // 跳过下一次 tick —— 它们竞争事件循环，在滚动释放期间
    // 曾导致最大 1402ms 的帧间隔。
    markScrollActivity();
    markDirty(el);
    markCommitStart();
    notify();
    if (renderQueuedRef.current) return;
    renderQueuedRef.current = true;
    queueMicrotask(() => {
      renderQueuedRef.current = false;
      scheduleRenderFrom(el);
    });
  }
  useImperativeHandle(ref, (): ScrollBoxHandle => ({
    scrollTo(y: number) {
      const el = domRef.current;
      if (!el) return;
      // 显式 false 会覆盖 DOM 属性，使手动滚动解除粘性。
      // 渲染代码通过 ?? 优先级检查。
      el.stickyScroll = false;
      el.pendingScrollDelta = undefined;
      el.scrollAnchor = undefined;
      el.scrollTop = Math.max(0, Math.floor(y));
      scrollMutated(el);
    },
    scrollToElement(el: DOMElement, offset = 0) {
      const box = domRef.current;
      if (!box) return;
      box.stickyScroll = false;
      box.pendingScrollDelta = undefined;
      box.scrollAnchor = {
        el,
        offset
      };
      scrollMutated(box);
    },
    scrollBy(dy: number) {
      const el = domRef.current;
      if (!el) return;
      el.stickyScroll = false;
      // 滚轮输入取消任何进行中的锚点寻址 —— 用户覆盖。
      el.scrollAnchor = undefined;
      // 累积到 pendingScrollDelta；渲染器以限速释放，
      // 使快速滑动显示中间帧。纯累加器：上滚后接下滚自然抵消。
      el.pendingScrollDelta = (el.pendingScrollDelta ?? 0) + Math.floor(dy);
      scrollMutated(el);
    },
    scrollToBottom() {
      const el = domRef.current;
      if (!el) return;
      el.pendingScrollDelta = undefined;
      el.stickyScroll = true;
      markDirty(el);
      notify();
      forceRender(n => n + 1);
    },
    getScrollTop() {
      return domRef.current?.scrollTop ?? 0;
    },
    getPendingDelta() {
      // 已累积但尚未释放的增量。useVirtualScroll 需要
      // 此值来挂载联合范围 [committed, committed+pending] ——
      // 否则中间释放帧找不到子元素（显示空白）。
      return domRef.current?.pendingScrollDelta ?? 0;
    },
    getScrollHeight() {
      return domRef.current?.scrollHeight ?? 0;
    },
    getFreshScrollHeight() {
      const content = domRef.current?.childNodes[0] as DOMElement | undefined;
      return content?.yogaNode?.getComputedHeight() ?? domRef.current?.scrollHeight ?? 0;
    },
    getViewportHeight() {
      return domRef.current?.scrollViewportHeight ?? 0;
    },
    getViewportTop() {
      return domRef.current?.scrollViewportTop ?? 0;
    },
    isSticky() {
      const el = domRef.current;
      if (!el) return false;
      return el.stickyScroll ?? Boolean(el.attributes['stickyScroll']);
    },
    subscribe(listener: () => void) {
      listenersRef.current.add(listener);
      return () => listenersRef.current.delete(listener);
    },
    setClampBounds(min, max) {
      const el = domRef.current;
      if (!el) return;
      el.scrollClampMin = min;
      el.scrollClampMax = max;
    }
  }),
  // notify/scrollMutated 是内联的（未用 useCallback），但仅闭包
  // 引用 ref 和导入 —— 保持稳定。空依赖数组避免每次渲染时
  // 重建 handle（会重新注册 ref = 额外开销）。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  []);

  // 结构：外层视口（overflow:scroll，受限高度）>
  // 内部内容（flexGrow:1, flexShrink:0 —— 至少填满视口，
  // 高内容时可超出）。flexGrow:1 让子元素可用 spacer 将元素
  // 固定在滚动区域底部。Yoga 的 Overflow.Scroll 防止视口
  // 增长以适应内容。渲染器从内容框计算 scrollHeight 并根据
  // scrollTop 裁剪内容的子元素。
  //
  // stickyScroll 作为 DOM 属性传递（通过 ink-box 直接传递），
  // 使其在首次渲染时可用 —— ref 回调在首次 commit 后才触发，
  // 对第一帧来说太晚了。
  return <ink-box ref={el => {
    domRef.current = el;
    if (el) el.scrollTop ??= 0;
  }} style={{
    flexWrap: 'nowrap',
    flexDirection: style.flexDirection ?? 'row',
    flexGrow: style.flexGrow ?? 0,
    flexShrink: style.flexShrink ?? 1,
    ...style,
    overflowX: 'scroll',
    overflowY: 'scroll'
  }} {...stickyScroll ? {
    stickyScroll: true
  } : {}}>
      <Box flexDirection="column" flexGrow={1} flexShrink={0} width="100%">
        {children}
      </Box>
    </ink-box>;
}
export default ScrollBox;
