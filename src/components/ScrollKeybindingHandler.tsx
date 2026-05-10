import React, { type RefObject, useEffect, useRef } from 'react'
import { useNotifications } from '../context/notifications.js'
import { useCopyOnSelect, useSelectionBgColor } from '../hooks/useCopyOnSelect.js'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import { useSelection } from '../ink/hooks/use-selection.js'
import type { FocusMove, SelectionState } from '../ink/selection.js'
import { isXtermJs } from '../ink/terminal.js'
import { getClipboardPath } from '../ink/termio/osc.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- Esc needs conditional propagation based on selection state
import { type Key, useInput } from '../ink.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { logForDebugging } from '../utils/debug.js'
type Props = {
  scrollRef: RefObject<ScrollBoxHandle | null>
  isActive: boolean
  /** Called after every scroll action with the resulting sticky state and
   *  the handle (for reading scrollTop/scrollHeight post-scroll). */
  onScroll?: (sticky: boolean, handle: ScrollBoxHandle) => void
  /** Enables modal pager keys (g/G, ctrl+u/d/b/f). Only safe when there
   *  is no text input competing for those characters — i.e. transcript
   *  mode. Defaults to false. When true, G works regardless of editorMode
   *  and sticky state; ctrl+u/d/b/f don't conflict with kill-line/exit/
   *  task:background/kill-agents (none are mounted, or they mount after
   *  this component so stopImmediatePropagation wins). */
  isModal?: boolean
}

// Terminals send one SGR wheel event per intended row (verified in Ghostty
// src/Surface.zig: `for (0..@abs(y.delta)) |_| { mouseReport(.four, ...) }`).
// Ghostty already 3×'s discrete wheel ticks before that loop; trackpad
// precision scroll is pixels/cell_size. 1 event = 1 row intended — use it
// as the base, and ramp a multiplier when events arrive rapidly. The
// pendingScrollDelta accumulator + proportional drain in
// render-node-to-output handles smooth catch-up on big bursts.
//
// xterm.js (VS Code/Cursor/Windsurf integrated terminals) sends exactly 1
// event per wheel notch — no pre-amplification. A separate exponential
// decay curve (below) compensates for the lower event rate, with burst
// detection and gap-dependent caps tuned to VS Code's event patterns.

// Native terminals: hard-window linear ramp. Events closer than the window
// ramp the multiplier; idle gaps reset to `base` (default 1). Some emulators
// pre-multiply at their layer (ghostty discrete=3 sends 3 SGR events/notch;
// iTerm2 "faster scroll" similar) — base=1 is correct there. Others send 1
// event/notch — users on those can set ZY_CODE_SCROLL_SPEED=3 to match
// vim/nvim/opencode app-side defaults. We can't detect which, so knob it.
const WHEEL_ACCEL_WINDOW_MS = 40
const WHEEL_ACCEL_STEP = 0.3
const WHEEL_ACCEL_MAX = 6

// Encoder bounce debounce + wheel-mode decay curve. Worn/cheap optical
// encoders emit spurious reverse-direction ticks during fast spins — measured
// 28% of events on Boris's mouse (2026-03-17, iTerm2). Pattern is always
// flip-then-flip-back; trackpads produce ZERO flips (0/458 in same recording).
// A confirmed bounce proves a physical wheel is attached — engage the same
// exponential-decay curve the xterm.js path uses (it's already tuned), with
// a higher cap to compensate for the lower event rate (~9/sec vs VS Code's
// ~30/sec). Trackpad can't reach this path.
//
// The decay curve gives: 1st click after idle = 1 row (precision), 2nd = 10,
// 3rd = cap. Slowing down decays smoothly toward 1 — no separate idle
// threshold needed, large gaps just have m≈0 → mult→1. Wheel mode is STICKY:
// once a bounce confirms it's a mouse, the decay curve applies until an idle
// gap or trackpad-flick-burst signals a possible device switch.
const WHEEL_BOUNCE_GAP_MAX_MS = 200 // flip-back must arrive within this
// Mouse is ~9 events/sec vs VS Code's ~30 — STEP is 3× xterm.js's 5 to
// compensate. At gap=100ms (m≈0.63): one click gives 1+15*0.63≈10.5.
const WHEEL_MODE_STEP = 15
const WHEEL_MODE_CAP = 15
// Max mult growth per event. Without this, the +STEP*m term jumps mult
// from 1→10 in one event when wheelMode engages mid-scroll (bounce
// detected after N events in trackpad mode at mult=1). User sees scroll
// suddenly go 10× faster. Cap=3 gives 1→4→7→10→13→15 over ~0.5s at
// 9 events/sec — smooth ramp instead of a jump. Decay is unaffected
// (target<mult wins the min).
const WHEEL_MODE_RAMP = 3
// Device-switch disengage: mouse finger-repositions max at ~830ms (measured);
// trackpad between-gesture pauses are 2000ms+. An idle gap above this means
// the user stopped — might have switched devices. Disengage; the next mouse
// bounce re-engages. Trackpad slow swipe (no <5ms bursts, so the burst-count
// guard doesn't catch it) is what this protects against.
const WHEEL_MODE_IDLE_DISENGAGE_MS = 1500

// xterm.js: exponential decay. momentum=0.5^(gap/hl) — slow click → m≈0
// → mult→1 (precision); fast → m≈1 → carries momentum. Steady-state
// = 1 + step×m/(1-m), capped. Measured event rates in VS Code (wheel.log):
// sustained scroll sends events at 20-50ms gaps (20-40 Hz), plus 0-2ms
// same-batch bursts on flicks. Cap is low (3–6, gap-dependent) because event
// frequency is high — at 40 Hz × 6 = 240 rows/sec max demand, which the
// adaptive drain at ~200fps (measured) handles. Higher cap → pending explosion.
// Tuned empirically (boris 2026-03). See docs/research/terminal-scroll-*.
const WHEEL_DECAY_HALFLIFE_MS = 150
const WHEEL_DECAY_STEP = 5
// Same-batch events (<BURST_MS) arrive in one stdin batch — the terminal
// is doing proportional reporting. Treat as 1 row/event like native.
const WHEEL_BURST_MS = 5
// Cap boundary: slow events (≥GAP_MS) cap low for short smooth drains;
// fast events cap higher for throughput (adaptive drain handles backlog).
const WHEEL_DECAY_GAP_MS = 80
const WHEEL_DECAY_CAP_SLOW = 3 // gap ≥ GAP_MS: precision
const WHEEL_DECAY_CAP_FAST = 6 // gap < GAP_MS: throughput
// Idle threshold: gaps beyond this reset to the kick value (2) so the
// first click after a pause feels responsive regardless of direction.
const WHEEL_DECAY_IDLE_MS = 500

/**
 * Whether a keypress should clear the virtual text selection. Mimics
 * native terminal selection: any keystroke clears, EXCEPT modified nav
 * keys (shift/opt/cmd + arrow/home/end/page*). In native macOS contexts,
 * shift+nav extends selection, and cmd/opt+nav are often intercepted by
 * the terminal emulator for scrollback nav — neither disturbs selection.
 * Bare arrows DO clear (user's cursor moves, native deselects). Wheel is
 * excluded — scroll:lineUp/Down already clears via the keybinding path.
 */
export function shouldClearSelectionOnKey(key: Key): boolean {
  if (key.wheelUp || key.wheelDown) return false
  const isNav =
    key.leftArrow ||
    key.rightArrow ||
    key.upArrow ||
    key.downArrow ||
    key.home ||
    key.end ||
    key.pageUp ||
    key.pageDown
  if (isNav && (key.shift || key.meta || key.super)) return false
  return true
}

/**
 * Map a keypress to a selection focus move (keyboard extension). Only
 * shift extends — that's the universal text-selection modifier. cmd
 * (super) only arrives via kitty keyboard protocol — in most terminals
 * cmd+arrow is intercepted by the emulator and never reaches the pty, so
 * no super branch. shift+home/end covers line-edge jumps (and fn+shift+
 * left/right on mac laptops = shift+home/end). shift+opt (word-jump) not
 * yet implemented — falls through to shouldClearSelectionOnKey which
 * preserves (modified nav). Returns null for non-extend keys.
 */
export function selectionFocusMoveForKey(key: Key): FocusMove | null {
  if (!key.shift || key.meta) return null
  if (key.leftArrow) return 'left'
  if (key.rightArrow) return 'right'
  if (key.upArrow) return 'up'
  if (key.downArrow) return 'down'
  if (key.home) return 'lineStart'
  if (key.end) return 'lineEnd'
  return null
}
export type WheelAccelState = {
  time: number
  mult: number
  dir: 0 | 1 | -1
  xtermJs: boolean
  /** Carried fractional scroll (xterm.js only). scrollBy floors, so without
   *  this a mult of 1.5 gives 1 row every time. Carrying the remainder gives
   *  1,2,1,2 on average for mult=1.5 — correct throughput over time. */
  frac: number
  /** Native-path baseline rows/event. Reset value on idle/reversal; ramp
   *  builds on top. xterm.js path ignores this (own kick=2 tuning). */
  base: number
  /** Deferred direction flip (native only). Might be encoder bounce or a
   *  real reversal — resolved by the NEXT event. Real reversal loses 1 row
   *  of latency; bounce is swallowed and triggers wheel mode. The flip's
   *  direction and timestamp are derivable (it's always -state.dir at
   *  state.time) so this is just a marker. */
  pendingFlip: boolean
  /** Set true once a bounce is confirmed (flip-then-flip-back within
   *  BOUNCE_GAP_MAX). Sticky — but disengaged on idle gap >1500ms OR a
   *  trackpad-signature burst (see burstCount). State lives in a useRef so
   *  it persists across device switches; the disengages handle mouse→trackpad. */
  wheelMode: boolean
  /** Consecutive <5ms events. Trackpad flick produces 100+ at <5ms; mouse
   *  produces ≤3 (verified in /tmp/wheel-tune.txt). 5+ in a row → trackpad
   *  signature → disengage wheel mode so device-switch doesn't leak mouse
   *  accel to trackpad. */
  burstCount: number
}

/** Compute rows for one wheel event, mutating accel state. Returns 0 when
 *  a direction flip is deferred for bounce detection — call sites no-op on
 *  step=0 (scrollBy(0) is a no-op, onScroll(false) is idempotent). Exported
 *  for tests. */
export function computeWheelStep(state: WheelAccelState, dir: 1 | -1, now: number): number {
  if (!state.xtermJs) {
    // Device-switch guard ①: idle disengage. Runs BEFORE pendingFlip resolve
    // so a pending bounce (28% of last-mouse-events) doesn't bypass it via
    // the real-reversal early return. state.time is either the last committed
    // event OR the deferred flip — both count as "last activity".
    if (state.wheelMode && now - state.time > WHEEL_MODE_IDLE_DISENGAGE_MS) {
      state.wheelMode = false
      state.burstCount = 0
      state.mult = state.base
    }

    // Resolve any deferred flip BEFORE touching state.time/dir — we need the
    // pre-flip state.dir to distinguish bounce (flip-back) from real reversal
    // (flip persisted), and state.time (= bounce timestamp) for the gap check.
    if (state.pendingFlip) {
      state.pendingFlip = false
      if (dir !== state.dir || now - state.time > WHEEL_BOUNCE_GAP_MAX_MS) {
        // Real reversal: new dir persisted, OR flip-back arrived too late.
        // Commit. The deferred event's 1 row is lost (acceptable latency).
        state.dir = dir
        state.time = now
        state.mult = state.base
        return Math.floor(state.mult)
      }
      // Bounce confirmed: flipped back to original dir within the window.
      // state.dir/mult unchanged from pre-bounce. state.time was advanced to
      // the bounce below, so gap here = flip-back interval — reflects the
      // user's actual click cadence (bounce IS a physical click, just noisy).
      state.wheelMode = true
    }
    const gap = now - state.time
    if (dir !== state.dir && state.dir !== 0) {
      // Flip. Defer — next event decides bounce vs. real reversal. Advance
      // time (but NOT dir/mult): if this turns out to be a bounce, the
      // confirm event's gap will be the flip-back interval, which reflects
      // the user's actual click rate. The bounce IS a physical wheel click,
      // just misread by the encoder — it should count toward cadence.
      state.pendingFlip = true
      state.time = now
      return 0
    }
    state.dir = dir
    state.time = now

    // ─── MOUSE (wheel mode, sticky until device-switch signal) ───
    if (state.wheelMode) {
      if (gap < WHEEL_BURST_MS) {
        // Same-batch burst check (ported from xterm.js): iTerm2 proportional
        // reporting sends 2+ SGR events for one detent when macOS gives
        // delta>1. Without this, the 2nd event at gap<1ms has m≈1 → STEP*m=15
        // → one gentle click gives 1+15=16 rows.
        //
        // 设备切换守卫 ②：触控板轻扫产生 100+ 事件在 <5ms 内
        //（实测）；鼠标产生 ≤3。5+ 连续 → 触控板轻扫。
        if (++state.burstCount >= 5) {
          state.wheelMode = false
          state.burstCount = 0
          state.mult = state.base
        } else {
          return 1
        }
      } else {
        state.burstCount = 0
      }
    }
    // 重新检查：可能在上方已解除。
    if (state.wheelMode) {
      // xterm.js decay curve with STEP×3, higher cap. No idle threshold —
      // the curve handles it (gap=1000ms → m≈0.01 → mult≈1). No frac —
      // rounding loss is minor at high mult, and frac persisting across idle
      // was causing off-by-one on the first click back.
      const m = Math.pow(0.5, gap / WHEEL_DECAY_HALFLIFE_MS)
      const cap = Math.max(WHEEL_MODE_CAP, state.base * 2)
      const next = 1 + (state.mult - 1) * m + WHEEL_MODE_STEP * m
      state.mult = Math.min(cap, next, state.mult + WHEEL_MODE_RAMP)
      return Math.floor(state.mult)
    }

    // ─── TRACKPAD / HI-RES (native, non-wheel-mode) ───
    // 紧密 40ms 突发窗口：子 40ms 事件加速，更慢的重置。
    // 触控板轻扫在 <20ms 间隙产生 200+ 事件 → 加速到上限 6。
    // 触控板慢滑在 40-400ms 间隙 → 每次事件重置 → 每次 1 行。
    if (gap > WHEEL_ACCEL_WINDOW_MS) {
      state.mult = state.base
    } else {
      const cap = Math.max(WHEEL_ACCEL_MAX, state.base * 2)
      state.mult = Math.min(cap, state.mult + WHEEL_ACCEL_STEP)
    }
    return Math.floor(state.mult)
  }

  // ─── VSCODE (xterm.js, browser wheel events) ───
  // 浏览器滚轮事件——无编码器反弹，无 SGR 突发。衰减曲线
  // 与原始调优不变。与上方 wheel 模式公式形状相同（保持同步），
  // 但 STEP=5 而非 15——此处事件率更高。
  const gap = now - state.time
  const sameDir = dir === state.dir
  state.time = now
  state.dir = dir
  // xterm.js path. Debug log shows two patterns: (a) 20-50ms gaps during
  // sustained scroll (~30 Hz), (b) <5ms same-batch bursts on flicks. For
  // (b) give 1 row/event — the burst count IS the acceleration, same as
  // native. For (a) the decay curve gives 3-5 rows. For sparse events
  // (100ms+, slow deliberate scroll) the curve gives 1-3.
  if (sameDir && gap < WHEEL_BURST_MS) return 1
  if (!sameDir || gap > WHEEL_DECAY_IDLE_MS) {
    // 方向反转或长时间空闲：从 2 开始（而非 1），这样暂停后的第一次
    // 点击移动可见量。没有这个的话，同方向空闲后恢复会衰减到 mult≈1（1 行）。
    state.mult = 2
    state.frac = 0
  } else {
    const m = Math.pow(0.5, gap / WHEEL_DECAY_HALFLIFE_MS)
    const cap = gap >= WHEEL_DECAY_GAP_MS ? WHEEL_DECAY_CAP_SLOW : WHEEL_DECAY_CAP_FAST
    state.mult = Math.min(cap, 1 + (state.mult - 1) * m + WHEEL_DECAY_STEP * m)
  }
  const total = state.mult + state.frac
  const rows = Math.floor(total)
  state.frac = total - rows
  return rows
}

/** Read ZY_CODE_SCROLL_SPEED, default 1, clamp (0, 20].
 *  Some terminals pre-multiply wheel events (ghostty discrete=3, iTerm2
 *  "faster scroll") — base=1 is correct there. Others send 1 event/notch —
 *  set ZY_CODE_SCROLL_SPEED=3 to match vim/nvim/opencode. We can't
 *  detect which kind of terminal we're in, hence the knob. Called lazily
 *  from initAndLogWheelAccel so globalSettings.env has loaded. */
export function readScrollSpeedBase(): number {
  const raw = process.env.ZY_CODE_SCROLL_SPEED
  if (!raw) return 1
  const n = parseFloat(raw)
  return Number.isNaN(n) || n <= 0 ? 1 : Math.min(n, 20)
}

/** Initial wheel accel state. xtermJs=true selects the decay curve.
 *  base is the native-path baseline rows/event (default 1). */
export function initWheelAccel(xtermJs = false, base = 1): WheelAccelState {
  return {
    time: 0,
    mult: base,
    dir: 0,
    xtermJs,
    frac: 0,
    base,
    pendingFlip: false,
    wheelMode: false,
    burstCount: 0,
  }
}

// 延迟初始化辅助函数。isXtermJs() 组合 TERM_PROGRAM env 检查 + 异步
// XTVERSION 探测——探测可能在渲染时未解析，所以这在第一个滚轮事件时调用
//（启动后 >>50ms），此时已稳定。记录检测模式一次，使 --debug 用户可以
// 验证 SSH 检测有效。渲染器也调用 isXtermJsHost()（在 render-node-to-output 中）
// 来选择排放算法——无需传递状态。
function initAndLogWheelAccel(): WheelAccelState {
  const xtermJs = isXtermJs()
  const base = readScrollSpeedBase()
  logForDebugging(
    `wheel accel: ${xtermJs ? 'decay (xterm.js)' : 'window (native)'} · base=${base} · TERM_PROGRAM=${process.env.TERM_PROGRAM ?? 'unset'}`,
  )
  return initWheelAccel(xtermJs, base)
}

// 拖拽滚动：当拖拽超过视口边缘时，每 AUTOSCROLL_INTERVAL_MS 滚动这么多行。
// 模式 1002 鼠标跟踪仅在单元格变化时触发，所以需要一个定时器在静止时继续滚动。
const AUTOSCROLL_LINES = 2
const AUTOSCROLL_INTERVAL_MS = 50
// 连续自动滚动 tick 的硬上限。如果释放事件丢失
//（在终端窗口外释放鼠标——某些模拟器不捕获
// 指针并丢弃释放），isDragging 保持 true，定时器会
// 一直运行到滚动边界。上限限制损害；任何新的拖拽运动
// 事件通过 check()→start() 重新会计数。
const AUTOSCROLL_MAX_TICKS = 200 // 10s @ 50ms

/**
 * Keyboard scroll navigation for the fullscreen layout's message scroll box.
 * PgUp/PgDn scroll by half-viewport. Mouse wheel scrolls by a few lines.
 * Scrolling breaks sticky mode; Ctrl+End re-enables it. Wheeling down at
 * the bottom also re-enables sticky so new content follows naturally.
 */
export function ScrollKeybindingHandler({
  scrollRef,
  isActive,
  onScroll,
  isModal = false,
}: Props): React.ReactNode {
  const selection = useSelection()
  const { addNotification } = useNotifications()
  // 在第一个滚轮事件时延迟初始化，这样 XTVERSION 探测（在
  // raw-mode-enable 时触发）那时已解析——在 useRef() 中初始化会在
  // SSH 上探测回复到达之前读取 getWheelBase()。
  const wheelAccel = useRef<WheelAccelState | null>(null)
  function showCopiedToast(text: string): void {
    // getClipboardPath reads env synchronously — predicts what setClipboard
    // did (native pbcopy / tmux load-buffer / raw OSC 52) so we can tell
    // the user whether paste will Just Work or needs prefix+].
    const path = getClipboardPath()
    const n = text.length
    let msg: string
    switch (path) {
      case 'native':
        msg = `copied ${n} chars to clipboard`
        break
      case 'tmux-buffer':
        msg = `copied ${n} chars to tmux buffer · paste with prefix + ]`
        break
      case 'osc52':
        msg = `sent ${n} chars via OSC 52 · check terminal clipboard settings if paste fails`
        break
    }
    addNotification({
      key: 'selection-copied',
      text: msg,
      color: 'suggestion',
      priority: 'immediate',
      timeoutMs: path === 'native' ? 2000 : 4000,
    })
  }
  function copyAndToast(): void {
    const text_0 = selection.copySelection()
    if (text_0) showCopiedToast(text_0)
  }

  // 转换选区以跟踪键盘页面跳转。选区坐标是
  // 屏幕缓冲区局部的；将内容移动 N 行的 scrollTo 也必须
  // 将 anchor+focus 移动 N，这样高亮保持在相同文本上（原生
  // 终端行为：选区随内容移动，在视口边缘裁剪）。
  // 滚出视口的行在滚动前被捕获到
  // scrolledOffAbove/Below，所以 getSelectedText 仍然返回完整文本。
  // 滚轮滚动（通过 scrollBy 的 scroll:lineUp/Down）仍然清除——
  // 其异步 pendingScrollDelta 排放意味着实际 delta 无法同步知道。
  function translateSelectionForJump(s: ScrollBoxHandle, delta: number): void {
    const sel = selection.getState()
    if (!sel?.anchor || !sel.focus) return
    const top = s.getViewportTop()
    const bottom = top + s.getViewportHeight() - 1
    // 仅当选区在 scrollbox 内容上时才转换。页脚/提示/StickyPromptHeader
    // 中的选区在静态文本上——滚动不会移动它们下面的内容。
    // 与 ink.tsx 的自动跟随转换相同的守卫（commit 36a8d154）。
    if (sel.anchor.row < top || sel.anchor.row > bottom) return
    // 跨边界：anchor 在 scrollbox，focus 在页脚/头部。镜像
    // ink.tsx 的 Flag-3 守卫——不移动也不捕获。
    // 静态端点固定选区；移动会将其传送到 scrollbox 内容中。
    if (sel.focus.row < top || sel.focus.row > bottom) return
    const max = Math.max(0, s.getScrollHeight() - s.getViewportHeight())
    const cur = s.getScrollTop() + s.getPendingDelta()
    // 边界钳位后的实际滚动距离。jumpBy 可能在 target >= max 时调用
    // scrollToBottom，但视图无法超过 max 移动，所以选区位移在此受限。
    const actual = Math.max(0, Math.min(max, cur + delta)) - cur
    if (actual === 0) return
    if (actual > 0) {
      // 向下滚动：内容向上移动。顶部的行离开视口。
      // Anchor+focus 移动 -actual，这样它们跟踪向上移动的内容。
      selection.captureScrolledRows(top, top + actual - 1, 'above')
      selection.shiftSelection(-actual, top, bottom)
    } else {
      // 向上滚动：内容向下移动。底部的行离开视口。
      const a = -actual
      selection.captureScrolledRows(bottom - a + 1, bottom, 'below')
      selection.shiftSelection(a, top, bottom)
    }
  }
  useKeybindings(
    {
      'scroll:pageUp': () => {
        const scrollHandle = scrollRef.current
        if (!scrollHandle) return
        const delta = -Math.max(1, Math.floor(scrollHandle.getViewportHeight() / 2))
        translateSelectionForJump(scrollHandle, delta)
        const sticky = jumpBy(scrollHandle, delta)
        onScroll?.(sticky, scrollHandle)
      },
      'scroll:pageDown': () => {
        const scrollHandle = scrollRef.current
        if (!scrollHandle) return
        const delta = Math.max(1, Math.floor(scrollHandle.getViewportHeight() / 2))
        translateSelectionForJump(scrollHandle, delta)
        const sticky = jumpBy(scrollHandle, delta)
        onScroll?.(sticky, scrollHandle)
      },
      'scroll:lineUp': () => {
        // 滚轮：scrollBy 累积到 pendingScrollDelta，由渲染器异步排放。
        // captureScrolledRows 无法在行离开前读取外出行
        //（排放是非确定性的）。暂时清除。
        selection.clearSelection()
        const scrollHandle = scrollRef.current
        // Return false (not consumed) when the ScrollBox content fits —
        // scroll would be a no-op. Lets a child component's handler take
        // the wheel event instead (e.g. Settings Config's list navigation
        // inside the centered Modal, where the paginated slice always fits).
        if (!scrollHandle || scrollHandle.getScrollHeight() <= scrollHandle.getViewportHeight()) return false
        wheelAccel.current ??= initAndLogWheelAccel()
        scrollUp(scrollHandle, computeWheelStep(wheelAccel.current, -1, performance.now()))
        onScroll?.(false, scrollHandle)
      },
      'scroll:lineDown': () => {
        selection.clearSelection()
        const scrollHandle = scrollRef.current
        if (!scrollHandle || scrollHandle.getScrollHeight() <= scrollHandle.getViewportHeight()) return false
        wheelAccel.current ??= initAndLogWheelAccel()
        const step = computeWheelStep(wheelAccel.current, 1, performance.now())
        const reachedBottom = scrollDown(scrollHandle, step)
        onScroll?.(reachedBottom, scrollHandle)
      },
      'scroll:top': () => {
        const scrollHandle = scrollRef.current
        if (!scrollHandle) return
        translateSelectionForJump(scrollHandle, -(scrollHandle.getScrollTop() + scrollHandle.getPendingDelta()))
        scrollHandle.scrollTo(0)
        onScroll?.(false, scrollHandle)
      },
      'scroll:bottom': () => {
        const scrollHandle = scrollRef.current
        if (!scrollHandle) return
        const maxScrollTop = Math.max(0, scrollHandle.getScrollHeight() - scrollHandle.getViewportHeight())
        translateSelectionForJump(scrollHandle, maxScrollTop - (scrollHandle.getScrollTop() + scrollHandle.getPendingDelta()))
        // scrollTo(max) eager-writes scrollTop so the render-phase sticky
        // follow computes followDelta=0. Without this, scrollToBottom()
        // alone leaves scrollTop stale → followDelta=max-stale →
        // shiftSelectionForFollow applies the SAME shift we already did
        // above, 2× offset. scrollToBottom() then re-enables sticky.
        scrollHandle.scrollTo(maxScrollTop)
        scrollHandle.scrollToBottom()
        onScroll?.(true, scrollHandle)
      },
      'selection:copy': copyAndToast,
    },
    {
      context: 'Scroll',
      isActive,
    },
  )

  // scroll:halfPage*/fullPage* have no default key bindings — ctrl+u/d/b/f
  // all have real owners in normal mode (kill-line/exit/task:background/
  // kill-agents). Transcript mode gets them via the isModal raw useInput
  // below. These handlers stay for custom rebinds only.
  useKeybindings(
    {
      'scroll:halfPageUp': () => {
        const scrollHandle = scrollRef.current
        if (!scrollHandle) return
        const delta = -Math.max(1, Math.floor(scrollHandle.getViewportHeight() / 2))
        translateSelectionForJump(scrollHandle, delta)
        const sticky = jumpBy(scrollHandle, delta)
        onScroll?.(sticky, scrollHandle)
      },
      'scroll:halfPageDown': () => {
        const scrollHandle = scrollRef.current
        if (!scrollHandle) return
        const delta = Math.max(1, Math.floor(scrollHandle.getViewportHeight() / 2))
        translateSelectionForJump(scrollHandle, delta)
        const sticky = jumpBy(scrollHandle, delta)
        onScroll?.(sticky, scrollHandle)
      },
      'scroll:fullPageUp': () => {
        const scrollHandle = scrollRef.current
        if (!scrollHandle) return
        const delta = -Math.max(1, scrollHandle.getViewportHeight())
        translateSelectionForJump(scrollHandle, delta)
        const sticky = jumpBy(scrollHandle, delta)
        onScroll?.(sticky, scrollHandle)
      },
      'scroll:fullPageDown': () => {
        const scrollHandle = scrollRef.current
        if (!scrollHandle) return
        const delta = Math.max(1, scrollHandle.getViewportHeight())
        translateSelectionForJump(scrollHandle, delta)
        const sticky = jumpBy(scrollHandle, delta)
        onScroll?.(sticky, scrollHandle)
      },
    },
    {
      context: 'Scroll',
      isActive,
    },
  )

  // 模态寻呼键——仅转录模式。less/tmux copy-mode 谱系：
  // ctrl+u/d（半页），ctrl+b/f（整页），g/G（顶部/底部）。
  // Tom 的决议（2026-03-15）："在 ctrl-o 模式下，ctrl-u、ctrl-d 等应该大致正常工作！"
  // ——转录是 copy-mode 容器。
  //
  // 安全，因为冲突的处理程序在这里不可达：
  //   ctrl+u → kill-line，ctrl+d → exit：未挂载 PromptInput
  //   ctrl+b → task:background：未挂载 SessionBackgroundHint
  //   ctrl+f → chat:killAgents 已移至 ctrl+x ctrl+k；无冲突
  //   g/G → 可打印字符：没有提示吃掉它们，不需要 vim/sticky 门控
  //
  // TODO(search): `/`, n/N — build on Richard Kim's d94b07add4 (branch
  // zy/jump-recent-message-CEPcq). getItemY Yoga-walk + computeOrigin +
  // anchorY already solve scroll-to-index. jumpToPrevTurn is the n/N
  // template. Single-shot via OVERSCAN_ROWS=80; two-phase was tried and
  // abandoned (❯ oscillation). See team memory scroll-copy-mode-design.md.
  useInput(
    (input, key, event) => {
      const s_10 = scrollRef.current
      if (!s_10) return
      const sticky_5 = applyModalPagerAction(s_10, modalPagerAction(input, key), (d_5) =>
        translateSelectionForJump(s_10, d_5),
      )
      if (sticky_5 === null) return
      onScroll?.(sticky_5, s_10)
      event.stopImmediatePropagation()
    },
    {
      isActive: isActive && isModal,
    },
  )

  // Esc 清除选区；任何其他按键也会清除它（匹配原生终端行为，
  // 选区在输入时消失）。Ctrl+C 在存在选区时复制——在旧终端上需要，
  // 那里 ctrl+shift+c 发送相同字节（\x03，shift 丢失），
  // cmd+c 永远不会到达 pty（终端拦截它用于 Edit > Copy）。
  // 通过原始 useInput 处理，使我们可以有条件地消费：
  // Esc/Ctrl+C 仅在存在选区时停止传播，让它们仍然可以用于
  // 取消请求/中断。其他按键从不阻止传播——它们作为副作用清除选区。
  // selection:copy 快捷键（ctrl+shift+c / cmd+c）通过 useKeybindings
  // 在上方注册并在到达此处之前消费其事件。
  useInput(
    (input_0, key_0, event_0) => {
      if (!selection.hasSelection()) return
      if (key_0.escape) {
        selection.clearSelection()
        event_0.stopImmediatePropagation()
        return
      }
      if (key_0.ctrl && !key_0.shift && !key_0.meta && input_0 === 'c') {
        copyAndToast()
        event_0.stopImmediatePropagation()
        return
      }
      const move = selectionFocusMoveForKey(key_0)
      if (move) {
        selection.moveFocus(move)
        event_0.stopImmediatePropagation()
        return
      }
      if (shouldClearSelectionOnKey(key_0)) {
        selection.clearSelection()
      }
    },
    {
      isActive,
    },
  )
  useDragToScroll(scrollRef, selection, isActive, onScroll)
  useCopyOnSelect(selection, isActive, showCopiedToast)
  useSelectionBgColor(selection)
  return null
}

/**
 * Auto-scroll the ScrollBox when the user drags a selection past its top or
 * bottom edge. The anchor is shifted in the opposite direction so it stays
 * on the same content (content that was at viewport row N is now at row N±d
 * after scrolling by d). Focus stays at the mouse position (edge row).
 *
 * Selection coords are screen-buffer-local, so the anchor is clamped to the
 * viewport bounds once the original content scrolls out. To preserve the full
 * selection, rows about to scroll out are captured into scrolledOffAbove/
 * scrolledOffBelow before each scroll step and joined back in by
 * getSelectedText.
 */
function useDragToScroll(
  scrollRef: RefObject<ScrollBoxHandle | null>,
  selection: ReturnType<typeof useSelection>,
  isActive: boolean,
  onScroll: Props['onScroll'],
): void {
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const dirRef = useRef<-1 | 0 | 1>(0) // -1 scrolling up, +1 down, 0 idle
  // 在 stop() 后仍然存活——仅在拖拽结束时重置。参见 check() 了解语义。
  const lastScrolledDirRef = useRef<-1 | 0 | 1>(0)
  const ticksRef = useRef(0)
  // onScroll 可能每次渲染都改变标识（如果调用者未 memo 化）。
  // 通过 ref 读取，这样 effect 不会在每次滚动引起的重新渲染时
  // 重新订阅并杀死定时器。
  const onScrollRef = useRef(onScroll)
  onScrollRef.current = onScroll
  useEffect(() => {
    if (!isActive) return
    function stop(): void {
      dirRef.current = 0
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
    function tick(): void {
      const sel = selection.getState()
      const s = scrollRef.current
      const dir = dirRef.current
      // dir === 0 defends against a stale interval (start() may have set one
      // after the immediate tick already called stop() at a scroll boundary).
      // ticks cap defends against a lost release event (mouse released
      // outside terminal window) leaving isDragging stuck true.
      if (
        !sel?.isDragging ||
        !sel.focus ||
        !s ||
        dir === 0 ||
        ++ticksRef.current > AUTOSCROLL_MAX_TICKS
      ) {
        stop()
        return
      }
      // scrollBy accumulates into pendingScrollDelta; the screen buffer
      // doesn't update until the next render drains it. If a previous
      // tick's scroll hasn't drained yet, captureScrolledRows would read
      // stale content (same rows as last tick → duplicated in the
      // accumulator AND missing the rows that actually scrolled out).
      // 跳过此 tick；50ms 间隔将在 Ink 的 16ms 渲染赶上后重试。
      // 也防止 shiftAnchor 不同步。
      if (s.getPendingDelta() !== 0) return
      const top = s.getViewportTop()
      const bottom = top + s.getViewportHeight() - 1
      // 将 anchor 钳位在 [top, bottom] 内。不是 [0, bottom]：ScrollBox
      // 在 0 处的填充行会在 getSelectedText 中产生 scrolledOffAbove
      // 与屏幕内容之间的空行。填充行高亮是一个次要的视觉好处；
      // 文本正确性优先。
      if (dir < 0) {
        if (s.getScrollTop() <= 0) {
          stop()
          return
        }
        // 向上滚动：内容在视口中向下移动，所以 anchor 行 +N。
        // 钳位到实际滚动距离，使 anchor 在接近顶部边界时保持同步
        //（渲染器在排放时将 scrollTop 钳位为 0）。
        const actual = Math.min(AUTOSCROLL_LINES, s.getScrollTop())
        // 捕获即将滚出底部的行，在 scrollBy 覆盖它们之前。
        // 仅捕获选区内的行（captureScrolledRows 与选区边界相交）。
        selection.captureScrolledRows(bottom - actual + 1, bottom, 'below')
        selection.shiftAnchor(actual, 0, bottom)
        s.scrollBy(-AUTOSCROLL_LINES)
      } else {
        const max = Math.max(0, s.getScrollHeight() - s.getViewportHeight())
        if (s.getScrollTop() >= max) {
          stop()
          return
        }
        // 向下滚动：内容在视口中向上移动，所以 anchor 行 -N。
        // 钳位到实际滚动距离，使 anchor 在接近底部边界时保持同步
        //（渲染器在排放时将 scrollTop 钳位为 max）。
        const actual_0 = Math.min(AUTOSCROLL_LINES, max - s.getScrollTop())
        // 捕获即将滚出顶部的行。
        selection.captureScrolledRows(top, top + actual_0 - 1, 'above')
        selection.shiftAnchor(-actual_0, top, bottom)
        s.scrollBy(AUTOSCROLL_LINES)
      }
      onScrollRef.current?.(false, s)
    }
    function start(dir_0: -1 | 1): void {
      // 在提前返回之前记录：check() 中的空累加器重置
      // 可能在预穿越阶段将此清零（累加器在 anchor 行进入捕获范围之前为空）。
      // 每次调用都重新记录，这样损坏可以立即修复。
      lastScrolledDirRef.current = dir_0
      if (dirRef.current === dir_0) return // already going this way
      stop()
      dirRef.current = dir_0
      ticksRef.current = 0
      tick()
      // tick() may have hit a scroll boundary and called stop() (dir reset to
      // 0). Only start the interval if we're still going — otherwise the
      // interval would run forever with dir === 0 doing nothing useful.
      if (dirRef.current === dir_0) {
        timerRef.current = setInterval(tick, AUTOSCROLL_INTERVAL_MS)
      }
    }

    // 每次选区变化时重新评估（开始/拖拽/结束/清除）。
    // 当拖拽离开视口时驱动拖拽自动滚动。
    // 之前的版本在拖拽开始时破坏了 sticky 状态以防止流式期间选区漂移——
    // ink.tsx 现在改为通过跟随 delta 转换选区坐标（原生终端行为：
    // 视图继续滚动，高亮随文本向上移动）。保持 sticky 也避免了
    // useVirtualScroll 的尾部遍历 → 向前遍历幻影增长。
    function check(): void {
      const s_0 = scrollRef.current
      if (!s_0) {
        stop()
        return
      }
      const top_0 = s_0.getViewportTop()
      const bottom_0 = top_0 + s_0.getViewportHeight() - 1
      const sel_0 = selection.getState()
      // 传递最后滚动方向（而非 dirRef），这样在 shiftAnchor 将 anchor
      // 钳位到第 0 行后绕过锚守卫。使用 lastScrolledDirRef（在 stop() 后仍然存活）
      // 使鼠标短暂进入视口后自动滚动可以恢复。仅同方向——鼠标
      // 从底部跳到顶部必须停止，因为在反转时 scrolledOffAbove/Below
      // 累加器持有先前方向的行，会在 getSelectedText 中重复文本。
      // 在拖拽结束时重置，或当两个累加器都为空时：startSelection 清除它们
      //（selection.ts），所以在丢失释放后的新拖拽（isDragging 卡住为 true，
      // 即 AUTOSCROLL_MAX_TICKS 存在的原因）仍然重置。
      // 安全：下方的 start() 在提前返回之前重新记录 lastScrolledDirRef，
      // 所以此处的中途重置会立即撤销。
      if (
        !sel_0?.isDragging ||
        (sel_0.scrolledOffAbove.length === 0 && sel_0.scrolledOffBelow.length === 0)
      ) {
        lastScrolledDirRef.current = 0
      }
      const dir_1 = dragScrollDirection(sel_0, top_0, bottom_0, lastScrolledDirRef.current)
      if (dir_1 === 0) {
        // 被阻止的反转：焦点跳到对面边缘（窗外拖拽返回、快速轻扫）。
        // handleSelectionDrag 已将焦点移过锚点，翻转了 selectionBounds——
        // 累加器现在孤立了（持有错误一侧的行）。清除它使
        // getSelectedText 匹配可见高亮。
        if (lastScrolledDirRef.current !== 0 && sel_0?.focus) {
          const want = sel_0.focus.row < top_0 ? -1 : sel_0.focus.row > bottom_0 ? 1 : 0
          if (want !== 0 && want !== lastScrolledDirRef.current) {
            sel_0.scrolledOffAbove = []
            sel_0.scrolledOffBelow = []
            sel_0.scrolledOffAboveSW = []
            sel_0.scrolledOffBelowSW = []
            lastScrolledDirRef.current = 0
          }
        }
        stop()
      } else start(dir_1)
    }
    const unsubscribe = selection.subscribe(check)
    return () => {
      unsubscribe()
      stop()
      lastScrolledDirRef.current = 0
    }
  }, [isActive, scrollRef, selection])
}

/**
 * 计算拖拽选区相对于 ScrollBox 视口的自动滚动方向。
 * 当不拖拽、缺少 anchor/focus 或 anchor 在视口外时返回 0——
 * 在输入区域开始的多击或拖拽不能劫持消息滚动
 *（在输入区域双击，而之前向上滚动，会通过 shiftAnchor 损坏 anchor，
 * 并在释放前每 50ms 虚假滚动消息历史）。
 *
 * alreadyScrollingDir 在自动滚动激活后绕过 anchor-in-viewport 守卫
 *（shiftAnchor 合法地将 anchor 钳位到第 0 行，低于 `top`），
 * 但只允许同方向继续。如果焦点跳到对面边缘
 *（下→上或上→下——快速轻扫或窗外拖拽可能发生，
 * 因为模式 1002 在单元格变化时报告，而非每单元格），
 * 返回 0 停止——不清除 scrolledOffAbove/Below 就反转会在行滚回屏幕时重复捕获的行。
 */
export function dragScrollDirection(
  sel: SelectionState | null,
  top: number,
  bottom: number,
  alreadyScrollingDir: -1 | 0 | 1 = 0,
): -1 | 0 | 1 {
  if (!sel?.isDragging || !sel.anchor || !sel.focus) return 0
  const row = sel.focus.row
  const want: -1 | 0 | 1 = row < top ? -1 : row > bottom ? 1 : 0
  if (alreadyScrollingDir !== 0) {
    // Same-direction only. Focus on the opposite side, or back inside the
    // viewport, stops the scroll — captured rows stay in scrolledOffAbove/
    // Below but never scroll back on-screen, so getSelectedText is correct.
    return want === alreadyScrollingDir ? want : 0
  }
  // Anchor must be inside the viewport for us to own this drag. If the
  // user started selecting in the input box or header, autoscrolling the
  // message history is surprising and corrupts the anchor via shiftAnchor.
  if (sel.anchor.row < top || sel.anchor.row > bottom) return 0
  return want
}

// Keyboard page jumps: scrollTo() writes scrollTop directly and clears
// pendingScrollDelta — one frame, no drain. scrollBy() accumulates into
// pendingScrollDelta which the renderer drains over several frames
// (render-node-to-output.ts drainProportional/drainAdaptive) — correct for
// wheel smoothness, wrong for PgUp/ctrl+u where the user expects a snap.
// Target is relative to scrollTop+pendingDelta so a jump mid-wheel-burst
// lands where the wheel was heading.
export function jumpBy(s: ScrollBoxHandle, delta: number): boolean {
  const max = Math.max(0, s.getScrollHeight() - s.getViewportHeight())
  const target = s.getScrollTop() + s.getPendingDelta() + delta
  if (target >= max) {
    // Eager-write scrollTop so follow-scroll sees followDelta=0. Callers
    // that ran translateSelectionForJump already shifted; scrollToBottom()
    // alone would double-shift via the render-phase sticky follow.
    s.scrollTo(max)
    s.scrollToBottom()
    return true
  }
  s.scrollTo(Math.max(0, target))
  return false
}

// 滚轮向下超过 maxScroll 重新启用 sticky，这样在底部滚轮滚动时自然重新固定
//（匹配典型聊天应用行为）。返回结果的 sticky 状态使调用者可以传播它。
function scrollDown(s: ScrollBoxHandle, amount: number): boolean {
  const max = Math.max(0, s.getScrollHeight() - s.getViewportHeight())
  // 包含 pendingDelta：scrollBy 累积到 pendingScrollDelta 而不更新 scrollTop，
  // 所以在一批滚轮事件中 getScrollTop() 单独是过时的。没有这个的话，
  // 滚轮滚到底部永远不会重新启用 sticky 滚动。
  const effectiveTop = s.getScrollTop() + s.getPendingDelta()
  if (effectiveTop + amount >= max) {
    s.scrollToBottom()
    return true
  }
  s.scrollBy(amount)
  return false
}

// 滚轮向上超过 scrollTop=0 通过 scrollTo(0) 钳位，清除
// pendingScrollDelta，使激进的滚轮突发（例如 MX Master 自由旋转）
// 不会累积无界的负 delta。没有这个钳位的话，
// useVirtualScroll 的 [effLo, effHi] 跨度会增长到 MAX_MOUNTED_ITEMS
// 无法覆盖的范围，中间排放帧渲染在没有挂载子节点的 scrollTop 上——空白视口。
export function scrollUp(s: ScrollBoxHandle, amount: number): void {
  // 包含 pendingDelta：scrollBy 累积而不更新 scrollTop，
  // 所以在一批滚轮事件中 getScrollTop() 单独是过时的。
  const effectiveTop = s.getScrollTop() + s.getPendingDelta()
  if (effectiveTop - amount <= 0) {
    s.scrollTo(0)
    return
  }
  s.scrollBy(-amount)
}
export type ModalPagerAction =
  | 'lineUp'
  | 'lineDown'
  | 'halfPageUp'
  | 'halfPageDown'
  | 'fullPageUp'
  | 'fullPageDown'
  | 'top'
  | 'bottom'

/**
 * 将按键映射到模态寻呼动作。导出用于测试。
 * 对模态寻呼不处理的按键返回 null（它们穿透）。
 *
 * ctrl+u/d/b/f 是 less 谱系的绑定。g/G 是裸字母
 *（仅在没有挂载提示时安全）。G 在旧终端上以 input='G' shift=false 到达，
 * 或在 kitty 协议终端上以 input='g' shift=true 到达。
 * 小写 g 需要 !shift 守卫，这样它不会也匹配 kitty-G。
 *
 * 按键重复：stdin 将按住的可打印字符合并为一个多字符字符串
 *（例如 'ggg'）。仅处理统一字符批次——混合输入如 'gG' 不是按键重复。
 * g/G 是幂等的绝对跳转，所以计数无关紧要
 *（消费批次只是防止它泄漏到可打印字符的选区清除处理器）。
 */
export function modalPagerAction(
  input: string,
  key: Pick<Key, 'ctrl' | 'meta' | 'shift' | 'upArrow' | 'downArrow' | 'home' | 'end'>,
): ModalPagerAction | null {
  if (key.meta) return null
  // 特殊键优先——箭头/home/end 带有空或垃圾输入到达，
  // 所以这些必须在任何输入字符串逻辑之前检查。shift 保留用于选区扩展
  //（selectionFocusMoveForKey）；ctrl+home/end 已有 useKeybindings 路由到 scroll:top/bottom。
  if (!key.ctrl && !key.shift) {
    if (key.upArrow) return 'lineUp'
    if (key.downArrow) return 'lineDown'
    if (key.home) return 'top'
    if (key.end) return 'bottom'
  }
  if (key.ctrl) {
    if (key.shift) return null
    switch (input) {
      case 'u':
        return 'halfPageUp'
      case 'd':
        return 'halfPageDown'
      case 'b':
        return 'fullPageUp'
      case 'f':
        return 'fullPageDown'
      // emacs 风格的行滚动（less 接受 ctrl+n/p 和 ctrl+e/y）。
      // 在搜索导航期间工作——跳转后微调而不离开模态。
      // 此 useInput 的 isActive 上没有 !searchOpen 门控。
      case 'n':
        return 'lineDown'
      case 'p':
        return 'lineUp'
      default:
        return null
    }
  }
  // 裸字母。按键重复批次：仅对统一连续字符执行。
  const c = input[0]
  if (!c || input !== c.repeat(input.length)) return null
  // kitty sends G as input='g' shift=true; legacy as 'G' shift=false.
  // Check BEFORE the shift-gate so both hit 'bottom'.
  if (c === 'G' || (c === 'g' && key.shift)) return 'bottom'
  if (key.shift) return null
  switch (c) {
    case 'g':
      return 'top'
    // j/k re-added per Tom Mar 18 — reversal of Mar 16 removal. Works
    // during search nav (fine-adjust after n/N lands) since isModal is
    // independent of searchOpen.
    case 'j':
      return 'lineDown'
    case 'k':
      return 'lineUp'
    // less：space = 向下翻页，b = 向上翻页。ctrl+b 已在上方映射；
    // 裸 b 是 less 原生版本。
    case ' ':
      return 'fullPageDown'
    case 'b':
      return 'fullPageUp'
    default:
      return null
  }
}

/**
 * 将模态寻呼动作应用于 ScrollBox。返回结果的 sticky 状态，
 * 或如果动作为 null 则返回 null（无事可做——调用者应穿透）。
 * 在滚动前调用 onBeforeJump(delta)，使调用者可以按滚动 delta
 * 转换文本选区（捕获外出行、移动 anchor+focus）而非清除它。导出用于测试。
 */
export function applyModalPagerAction(
  s: ScrollBoxHandle,
  act: ModalPagerAction | null,
  onBeforeJump: (delta: number) => void,
): boolean | null {
  switch (act) {
    case null:
      return null
    case 'lineUp':
    case 'lineDown': {
      const d = act === 'lineDown' ? 1 : -1
      onBeforeJump(d)
      return jumpBy(s, d)
    }
    case 'halfPageUp':
    case 'halfPageDown': {
      const half = Math.max(1, Math.floor(s.getViewportHeight() / 2))
      const d = act === 'halfPageDown' ? half : -half
      onBeforeJump(d)
      return jumpBy(s, d)
    }
    case 'fullPageUp':
    case 'fullPageDown': {
      const page = Math.max(1, s.getViewportHeight())
      const d = act === 'fullPageDown' ? page : -page
      onBeforeJump(d)
      return jumpBy(s, d)
    }
    case 'top':
      onBeforeJump(-(s.getScrollTop() + s.getPendingDelta()))
      s.scrollTo(0)
      return false
    case 'bottom': {
      const max = Math.max(0, s.getScrollHeight() - s.getViewportHeight())
      onBeforeJump(max - (s.getScrollTop() + s.getPendingDelta()))
      // 在 scrollToBottom 之前提前写入 scrollTop——与 scroll:bottom 和
      // jumpBy 的 max 分支相同的双重偏移修复。
      s.scrollTo(max)
      s.scrollToBottom()
      return true
    }
  }
}
