import { closeSync, constants as fsConstants, openSync, readSync, writeSync } from 'node:fs'
import { format } from 'node:util'
import autoBind from 'auto-bind'
import noop from 'lodash-es/noop.js'
import throttle from 'lodash-es/throttle.js'
import { type ReactNode } from 'react'
import type { FiberRoot } from 'react-reconciler'
import { ConcurrentRoot } from 'react-reconciler/constants.js'
import { onExit } from 'signal-exit'
import { flushInteractionTime } from 'src/bootstrap/runtime/runtimeContext.js'
import { getYogaCounters } from 'src/native-ts/yoga-layout/index.js'
import { logForDebugging } from 'src/services/infra/debug.js'
import { isAlternateScreenDisabled } from 'src/services/terminal/fullscreen.js'
import { logError } from 'src/services/infra/log.js'
import { isDevEnv, isEnvTruthy } from '../services/infra/envUtils.js'
import { colorize } from './colorize.js'
import App from './components/App.js'
import type {
  CursorDeclaration,
  CursorDeclarationSetter,
} from './components/CursorDeclarationContext.js'
import { FRAME_INTERVAL_MS } from './constants.js'
import type { Rectangle } from './layout/geometry.js'
import * as dom from './dom.js'
import { KeyboardEvent } from './events/keyboardEvent.js'
import { FocusManager } from './focus.js'
import { emptyFrame, type Frame, type FrameEvent } from './frame.js'
import { dispatchClick, dispatchHover, hitTest } from './hitTest.js'
import instances from './instances.js'
import { LogUpdate } from './logUpdate.js'
import { nodeCache } from './nodeCache.js'
import { optimize } from './optimizer.js'
import Output from './output.js'
import type { ParsedKey } from './parseKeypress.js'
import reconciler, {
  dispatcher,
  getLastCommitMs,
  getLastYogaMs,
  isDebugRepaintsEnabled,
  recordYogaMs,
  resetProfileCounters,
} from './reconciler.js'
import renderNodeToOutput, { consumeFollowScroll, didLayoutShift } from './renderNodeToOutput.js'
import { applyPositionedHighlight, type MatchPosition, scanPositions } from './renderToScreen.js'
import createRenderer, { type Renderer } from './renderer.js'
import {
  CellWidth,
  CharPool,
  cellAt,
  collectLiveStyleIds,
  countWideCellsInRowBefore,
  createScreen,
  HyperlinkPool,
  isEmptyCellAt,
  migrateScreenPools,
  shrinkScreenIfOversized,
  StylePool,
} from './screen.js'
import { applySearchHighlight } from './searchHighlight.js'
import {
  applySelectionOverlay,
  captureScrolledRows,
  clearSelection,
  createSelectionState,
  extendSelection,
  selectionBounds,
  type FocusMove,
  findPlainTextUrlAt,
  getSelectedText,
  hasSelection,
  moveFocus,
  type SelectionState,
  selectLineAt,
  selectWordAt,
  shiftAnchor,
  shiftSelection,
  shiftSelectionForFollow,
  startSelection,
  updateSelection,
} from './selection.js'
import {
  canAnchorWideCellsForFrame,
  DECSTBM_FAST_PATH_SUPPORTED,
  needsWideCellRenderAnchor,
  SYNC_OUTPUT_SUPPORTED,
  supportsExtendedKeys,
  type Terminal,
  writeDiffToTerminal,
} from './terminal.js'
import {
  CURSOR_HOME,
  cursorMove,
  cursorPosition,
  DISABLE_KITTY_KEYBOARD,
  DISABLE_MODIFY_OTHER_KEYS,
  ENABLE_KITTY_KEYBOARD,
  ENABLE_MODIFY_OTHER_KEYS,
  ERASE_SCREEN,
  eraseToEndOfLine,
} from './termio/csi.js'
import {
  DBP,
  DFE,
  DISABLE_MOUSE_TRACKING,
  ENABLE_MOUSE_TRACKING,
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
  SHOW_CURSOR,
} from './termio/dec.js'
import {
  CLEAR_ITERM2_PROGRESS,
  CLEAR_TAB_STATUS,
  setClipboard,
  supportsTabStatus,
  wrapForMultiplexer,
} from './termio/osc.js'
import { TerminalWriteProvider } from './useTerminalNotification.js'

// 替代屏幕：renderer.ts 设置 cursor.visible = !isTTY || screen.height===0，
// 这在替代屏幕中始终为 false（TTY + 内容填满屏幕）。
// 复用冻结对象可以每帧节省 1 次分配。
const ALT_SCREEN_ANCHOR_CURSOR = Object.freeze({
  x: 0,
  y: 0,
  visible: false,
})
const CURSOR_HOME_PATCH = Object.freeze({
  type: 'stdout' as const,
  content: CURSOR_HOME,
})
const ERASE_THEN_HOME_PATCH = Object.freeze({
  type: 'stdout' as const,
  content: ERASE_SCREEN + CURSOR_HOME,
})
const WIDE_CELL_RENDER_QUIRKS = Object.freeze({
  anchorAfterWideCell: true,
})
const JEDITERM_LAYOUT_SHIFT_QUIRKS = Object.freeze({
  anchorAfterWideCell: true,
  forceFullRepaint: true,
})
const MAX_TERMINAL_COLUMNS = 8192
const MAX_TERMINAL_ROWS = 2048

function normalizeTerminalDimension(
  value: number | undefined,
  fallback: number,
  maximum: number,
  clampOversized = false,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return fallback
  }

  const dimension = Math.floor(value)
  if (dimension > maximum) {
    return clampOversized ? maximum : fallback
  }

  return dimension
}

// 按 Ink 实例缓存，resize 时失效。alt-screen 的 frame.cursor.y
// 始终为 terminalRows - 1（见 renderer.ts）。
function makeAltScreenParkPatch(terminalRows: number) {
  return Object.freeze({
    type: 'stdout' as const,
    content: cursorPosition(terminalRows, 1),
  })
}
export type Options = {
  stdout: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
  stderr: NodeJS.WriteStream
  exitOnCtrlC: boolean
  patchConsole: boolean
  waitUntilExit?: () => Promise<void>
  onFrame?: (event: FrameEvent) => void
  nativeCursor?: boolean
}
export default class Ink {
  private readonly log: LogUpdate
  private readonly terminal: Terminal
  private scheduleRender: (() => void) & {
    cancel?: () => void
  }
  // 忽略树卸载后的最后一次渲染，避免退出前输出空内容
  private isUnmounted = false
  private isPaused = false
  private readonly container: FiberRoot
  private rootNode: dom.DOMElement
  readonly focusManager: FocusManager
  private renderer: Renderer
  private readonly stylePool: StylePool
  private charPool: CharPool
  private hyperlinkPool: HyperlinkPool
  private exitPromise?: Promise<void>
  private restoreConsole?: () => void
  private restoreStderr?: () => void
  private readonly unsubscribeTTYHandlers?: () => void
  private terminalColumns: number
  private terminalRows: number
  private currentNode: ReactNode = null
  private frontFrame: Frame
  private backFrame: Frame
  private lastPoolResetTime = performance.now()
  private drainTimer: ReturnType<typeof setTimeout> | null = null
  private lastYogaCounters: {
    ms: number
    visited: number
    measured: number
    cacheHits: number
    live: number
  } = {
    ms: 0,
    visited: 0,
    measured: 0,
    cacheHits: 0,
    live: 0,
  }
  private altScreenParkPatch: Readonly<{
    type: 'stdout'
    content: string
  }>
  // 文本选择状态（仅 alt screen）。由此处持有，以便 onRender 的 overlay 阶段读取，
  // App.tsx 也可根据鼠标事件更新。保持 public，供 instances.get() 调用方访问。
  readonly selection: SelectionState = createSelectionState()
  // 搜索高亮 query（仅 alt screen）。下方 setter 会触发 scheduleRender，
  // onRender 中的 applySearchHighlight 会反转匹配 cell 的颜色。
  private searchHighlightQuery = ''
  // 基于位置的高亮。目标消息挂载时，VML 通过 scanElementSubtree 只扫描一次位置，
  // 按消息相对坐标保存，并在每帧应用时设置此字段。rowOffset 是消息当前的屏幕顶部；
  // currentIdx 指定哪个位置是黄色的“当前项”；null 表示清除。
  // 所有位置预先已知，导航只需索引运算，不存在扫描反馈循环。
  private searchPositions: {
    positions: MatchPosition[]
    rowOffset: number
    currentIdx: number
  } | null = null
  // React 侧的选区状态变化订阅者（useHasSelection）。每次选区变化时与终端重绘一起触发，
  // 让 UI（例如 footer 提示）能响应选区出现或清除。
  private readonly selectionListeners = new Set<() => void>()
  /** VtPlusPlus 帧拦截器。返回 true 跳过 log.render diff。 */
  frameSink: ((frame: Frame, stylePool: StylePool) => boolean) | null = null
  /** VtPlusPlus 渲染器重置回调。外部编辑器退出后调用。 */
  vtppReset: (() => void) | null = null
  // 当前位于指针下方的 DOM 节点（mode-1003 motion）。在此持有，
  // 使 App.tsx 的 handleMouseEvent 保持无状态；dispatchHover 会与该集合比较并原地修改。
  private readonly hoveredNodes = new Set<dom.DOMElement>()
  // 由 <AlternateScreen> 通过 setAltScreenActive() 设置。控制 renderer 对 cursor.y 的钳制，
  // 使光标留在 viewport 内，避免 screen.height === terminalRows 时 LF 引发滚动；
  // 同时门控感知 alt screen 的 SIGCONT、resize 和 unmount 处理。
  private altScreenActive = false
  // 与 altScreenActive 一起设置，让 SIGCONT 恢复时知道是否要重新启用鼠标跟踪；
  // 并非所有 <AlternateScreen> 用法都需要鼠标跟踪。
  private altScreenMouseTracking = false
  // JediTerm（JetBrains IDE 内置终端）将每个 CJK 宽字符计为 1 列而非 2 列，
  // 导致鼠标列坐标系统性偏小。缓存检测结果以避免每次事件查询环境变量。
  private isJetBrainsTerminal: boolean =
    process.env.TERMINAL_EMULATOR?.includes('JetBrains') === true
  // Windows Terminal 与 Windows JediTerm 在宽字符后的物理光标列可能
  // 偏离内部单元格模型。Windows Terminal 只需重新锚定；JediTerm 在
  // 布局位移时还需要全量重绘。
  private usesWideCellRenderAnchor = needsWideCellRenderAnchor()
  private usesJediTermLayoutQuirks = process.platform === 'win32' && this.isJetBrainsTerminal
  // True when the previous frame's screen buffer cannot be trusted for
  // blit — selection overlay mutated it, resetFramesForAltScreen()
  // replaced it with blanks, or forceRedraw() reset it to 0×0. Forces
  // one full-render frame; steady-state frames after clear it and regain
  // the blit + narrow-damage fast path.
  private prevFrameContaminated = false
  /** 上帧的 overlay 矩形（选区反色 / 搜索高亮）。传递到 renderNodeToOutput
   *  的 blit 条件中：不与 prevOverlayRect 相交的节点可以安全地从 prevScreen
   *  blit，相交的节点跳过后重新渲染。在每帧 overlay 写入后更新。 */
  private prevOverlayRect: Rectangle | null = null
  // 由 handleResize 设置：在 BSU/ESU 块内部将 ERASE_SCREEN 加到下一次 onRender patch 前，
  // 使清除和绘制成为原子操作。若在 handleResize 中同步写入 ERASE_SCREEN，
  // render() 所需约 80 毫秒内屏幕会保持空白；延后到原子块中可让旧内容持续可见，
  // 直到新帧完全就绪。
  private needsEraseBeforePaint = false
  // Native cursor positioning: a component (via useDeclaredCursor) declares
  // where the terminal cursor should be parked after each frame. Terminal
  // emulators render IME preedit text at the physical cursor position, and
  // screen readers / screen magnifiers track it — so parking at the text
  // input's caret makes CJK input appear inline and lets a11y tools follow.
  private cursorDeclaration: CursorDeclaration | null = null
  // Main-screen: physical cursor position after the declared-cursor move,
  // tracked separately from frame.cursor (which must stay at content-bottom
  // for log-update's relative-move invariants). Alt-screen doesn't need
  // this — every frame begins with CSI H. null = no move emitted last frame.
  private displayCursor: {
    x: number
    y: number
  } | null = null
  // 原生光标的已知终端状态。仅在状态变化时发序列，避免 JediTerm
  // 在每帧重复显示/隐藏光标时重启 IME 预编辑绘制。
  private nativeCursorVisible: boolean
  constructor(private readonly options: Options) {
    autoBind(this)
    // 启动时记录 quirk 决策：JediTerm 上的渲染路径与普通终端不同
    //（宽字符列补偿、全量重绘），没有这条日志时很难确认渲染问题
    // 是否来自终端特例分支。
    if (this.usesJediTermLayoutQuirks) {
      logForDebugging(
        `ink: JediTerm wide-cell/layout-shift render quirks enabled (${process.platform})`,
      )
    }
    this.nativeCursorVisible = isEnvTruthy(process.env.ZY_CODE_ACCESSIBILITY)
    if (this.options.patchConsole) {
      this.restoreConsole = this.patchConsole()
      this.restoreStderr = this.patchStderr()
    }
    this.terminal = {
      stdout: options.stdout,
      stderr: options.stderr,
    }
    this.terminalColumns = normalizeTerminalDimension(
      options.stdout.columns,
      80,
      MAX_TERMINAL_COLUMNS,
      true,
    )
    this.terminalRows = normalizeTerminalDimension(options.stdout.rows, 24, MAX_TERMINAL_ROWS, true)
    this.altScreenParkPatch = makeAltScreenParkPatch(this.terminalRows)
    this.stylePool = new StylePool()
    this.charPool = new CharPool()
    this.hyperlinkPool = new HyperlinkPool()
    this.frontFrame = emptyFrame(
      this.terminalRows,
      this.terminalColumns,
      this.stylePool,
      this.charPool,
      this.hyperlinkPool,
    )
    this.backFrame = emptyFrame(
      this.terminalRows,
      this.terminalColumns,
      this.stylePool,
      this.charPool,
      this.hyperlinkPool,
    )
    this.log = new LogUpdate({
      isTTY: (options.stdout.isTTY as boolean | undefined) || false,
      stylePool: this.stylePool,
    })

    // scheduleRender is called from the reconciler's resetAfterCommit, which
    // runs BEFORE React's layout phase (ref attach + useLayoutEffect). Any
    // state set in layout effects — notably the cursorDeclaration from
    // useDeclaredCursor — would lag one commit behind if we rendered
    // synchronously. Deferring to a microtask runs onRender after layout
    // effects have committed, so the native cursor tracks the caret without
    // a one-keystroke lag. Same event-loop tick, so throughput is unchanged.
    // Test env uses onImmediateRender (direct onRender, no throttle) so
    // existing synchronous lastFrame() tests are unaffected.
    const deferredRender = (): void => queueMicrotask(this.onRender)
    this.scheduleRender = throttle(deferredRender, FRAME_INTERVAL_MS, {
      leading: true,
      trailing: true,
    })

    // 忽略树卸载后的最后一次渲染，避免退出前输出空内容
    this.isUnmounted = false

    // 进程退出时卸载
    this.unsubscribeExit = onExit(this.unmount, {
      alwaysLast: false,
    })
    if (options.stdout.isTTY) {
      options.stdout.on('resize', this.handleResize)
      process.on('SIGCONT', this.handleResume)
      this.unsubscribeTTYHandlers = () => {
        options.stdout.off('resize', this.handleResize)
        process.off('SIGCONT', this.handleResume)
      }
    }
    this.rootNode = dom.createNode('ink-root')
    this.focusManager = new FocusManager((target, event) =>
      dispatcher.dispatchDiscrete(target, event),
    )
    this.rootNode.focusManager = this.focusManager
    this.renderer = createRenderer(this.rootNode, this.stylePool)
    this.rootNode.onRender = this.scheduleRender
    this.rootNode.onImmediateRender = this.onRender
    this.rootNode.onComputeLayout = () => {
      // 在 React commit 阶段计算布局，使 useLayoutEffect hook 能访问最新布局数据
      // 防止卸载后访问已释放的 Yoga 节点
      if (this.isUnmounted) {
        return
      }
      // 对齐 Claude Code：JediTerm 在 IME/窗口状态切换期间偶尔会短暂
      // 暴露 0 或过大的 winsize。resize 事件也可能晚于 React 提交；
      // 布局前主动同步，并让无效值沿用上一份有效尺寸，避免全屏高度
      // 瞬间回退到 24 行后又恢复。
      if (this.options.stdout.isTTY && this.syncTerminalSize()) {
        const currentNode = this.currentNode
        if (currentNode !== null) {
          queueMicrotask(() => {
            if (!this.isUnmounted) {
              this.render(currentNode)
            }
          })
        }
      }
      if (this.rootNode.yogaNode) {
        const layoutStart = performance.now()
        this.rootNode.yogaNode.setWidth(this.terminalColumns)
        this.rootNode.yogaNode.calculateLayout(this.terminalColumns)
        const ms = performance.now() - layoutStart
        recordYogaMs(ms)
        const c = getYogaCounters()
        this.lastYogaCounters = {
          ms,
          ...c,
        }
      }
    }

    // react-reconciler runtime 接受 10 个参数，但 @types 声明的参数更少
    this.container = reconciler.createContainer(
      this.rootNode,
      ConcurrentRoot,
      null,
      false,
      null,
      'id',
      noop,
      // onUncaughtError
      noop,
      // onCaughtError
      noop,
      // onRecoverableError
      noop, // onDefaultTransitionIndicator
    )
    if (isDevEnv()) {
      reconciler.injectIntoDevTools({
        bundleType: 0,
        // 报告 React DOM 版本，而非 Ink 版本
        // See https://github.com/facebook/react/issues/16666#issuecomment-532639905
        version: '16.13.1',
        rendererPackageName: 'ink',
      })
    }
  }
  private handleResume = () => {
    if (!this.options.stdout.isTTY) {
      return
    }

    // alt screen：SIGCONT 后内容已过期，shell 可能已写入 main screen 并切走焦点，
    // 鼠标跟踪也已被 handleSuspend 禁用。
    if (this.altScreenActive) {
      this.reenterAltScreen()
      return
    }

    // main screen：从空白状态开始，避免覆盖终端现有内容
    this.frontFrame = emptyFrame(
      this.frontFrame.viewport.height,
      this.frontFrame.viewport.width,
      this.stylePool,
      this.charPool,
      this.hyperlinkPool,
    )
    this.backFrame = emptyFrame(
      this.backFrame.viewport.height,
      this.backFrame.viewport.width,
      this.stylePool,
      this.charPool,
      this.hyperlinkPool,
    )
    this.log.reset()
    // Physical cursor position is unknown after the shell took over during
    // suspend. Clear displayCursor so the next frame's cursor preamble
    // doesn't emit a relative move from a stale park position.
    this.displayCursor = null
  }

  private stdoutSize(): { columns: number; rows: number } {
    return {
      columns: normalizeTerminalDimension(
        this.options.stdout.columns,
        this.terminalColumns,
        MAX_TERMINAL_COLUMNS,
      ),
      rows: normalizeTerminalDimension(
        this.options.stdout.rows,
        this.terminalRows,
        MAX_TERMINAL_ROWS,
      ),
    }
  }

  private hasStaleTerminalSize(): boolean {
    const { columns, rows } = this.stdoutSize()
    return columns !== this.terminalColumns || rows !== this.terminalRows
  }

  private syncTerminalSize(): boolean {
    if (!this.hasStaleTerminalSize()) {
      return false
    }

    const { columns, rows } = this.stdoutSize()
    this.terminalColumns = columns
    this.terminalRows = rows
    this.altScreenParkPatch = makeAltScreenParkPatch(rows)

    if (this.altScreenActive && !this.isPaused && this.options.stdout.isTTY) {
      if (this.altScreenMouseTracking) {
        this.options.stdout.write(ENABLE_MOUSE_TRACKING)
      }
      this.resetFramesForAltScreen()
      this.needsEraseBeforePaint = true
    }

    return true
  }

  // 此处不做 debounce。否则会出现 stdout.columns 已更新、this.terminalColumns/Yoga
  // 仍为旧值的时间窗；期间任何 scheduleRender（spinner、clock）都会让 log-update
  // 检测到宽度变化并清屏，debounce 随后再次清屏，造成两次空白→绘制闪烁。
  // useVirtualScroll 的高度缩放已限制单次 resize 成本，同步处理可保持尺寸一致。
  private handleResize = () => {
    // 终端常会为一次用户操作发出至少两个 resize 事件（窗口稳定过程）。
    // 尺寸相同或瞬时无效的事件无需处理。
    if (!this.syncTerminalSize()) {
      return
    }

    // 用更新后的 props 重新渲染 React 树，使 context 值发生变化。
    // React commit 阶段会调用 onComputeLayout()，按新尺寸重新计算 Yoga 布局，
    // 再调用 onRender() 渲染更新后的帧。此处不调用 scheduleRender()，
    // 否则会在布局更新前渲染，导致 viewport 与内容尺寸不匹配。
    if (this.currentNode !== null) {
      this.render(this.currentNode)
    }
  }
  resolveExitPromise: () => void = () => {}
  rejectExitPromise: (reason?: Error) => void = () => {}
  unsubscribeExit: () => void = () => {}

  /**
   * 暂停 Ink 并将终端交给外部 TUI（如 git commit editor）。非 fullscreen 模式下
   * 会进入 alt screen；fullscreen 模式已经处于 alt screen，只需清屏。
   * 完成后调用 `exitAlternateScreen()` 恢复 Ink。
   */
  enterAlternateScreen(): void {
    this.pause()
    this.suspendStdin()
    this.options.stdout.write(
      // Disable extended key reporting first — editors that don't speak
      // CSI-u (e.g. nano) show "Unknown sequence" for every Ctrl-<key> if
      // kitty/modifyOtherKeys stays active. exitAlternateScreen re-enables.
      DISABLE_KITTY_KEYBOARD +
        DISABLE_MODIFY_OTHER_KEYS +
        (this.altScreenMouseTracking ? DISABLE_MOUSE_TRACKING : '') +
        // 禁用鼠标（已关闭时不执行操作）
        (this.altScreenActive ? '' : '\x1b[?1049h') +
        // 进入 alt screen（fullscreen 时已经处于其中）
        '\x1b[?1004l' +
        // 禁用焦点报告
        '\x1b[0m' +
        // 重置 attributes
        '\x1b[?25h' +
        // 显示光标
        '\x1b[2J' +
        // 清屏
        '\x1b[H', // cursor home
    )
  }

  /**
   * 外部 TUI 交还终端后恢复 Ink，并完整重绘。
   * 非 fullscreen 模式下退出 alt screen 回到 main screen；
   * fullscreen 模式下重新进入 alt screen，并清除后重绘。
   *
   * The re-enter matters: terminal editors (vim, nano, less) write
   * smcup/rmcup (?1049h/?1049l), so even though we started in alt,
   * the editor's rmcup on exit drops us to main screen. Without
   * re-entering, the 2J below wipes the user's main-screen scrollback
   * and subsequent renders land in main — native terminal scroll
   * returns, fullscreen scroll is dead.
   */
  exitAlternateScreen(): void {
    this.options.stdout.write(
      (this.altScreenActive ? ENTER_ALT_SCREEN : '') +
        // 重新进入 alt screen；vim 的 rmcup 已使终端回到 main screen
        '\x1b[2J' +
        // 清屏（fullscreen 时现在处于 alt screen）
        '\x1b[H' +
        // 光标归位
        (this.altScreenMouseTracking ? ENABLE_MOUSE_TRACKING : '') +
        // 重新启用鼠标（设置 ZY_CODE_DISABLE_MOUSE 时跳过）
        (this.altScreenActive ? '' : '\x1b[?1049l') +
        // 退出 alt screen（仅非 fullscreen）
        '\x1b[?25l', // hide cursor (Ink manages)
    )
    this.resumeStdin()
    if (this.altScreenActive) {
      this.resetFramesForAltScreen()
      this.vtppReset?.()
    } else {
      this.repaint()
    }
    this.resume()
    // Re-enable focus reporting and extended key reporting — terminal
    // editors (vim, nano, etc.) write their own modifyOtherKeys level on
    // entry and reset it on exit, leaving us unable to distinguish
    // ctrl+shift+<letter> from ctrl+<letter>. Pop-before-push keeps the
    // Kitty stack balanced (a well-behaved editor restores our entry, so
    // without the pop we'd accumulate depth on each editor round-trip).
    this.options.stdout.write(
      '\x1b[?1004h' +
        (supportsExtendedKeys()
          ? DISABLE_KITTY_KEYBOARD + ENABLE_KITTY_KEYBOARD + ENABLE_MODIFY_OTHER_KEYS
          : ''),
    )
  }
  onRender() {
    if (this.isUnmounted || this.isPaused) {
      return
    }
    // Entering a render cancels any pending drain tick — this render will
    // handle the drain (and re-schedule below if needed). Prevents a
    // wheel-event-triggered render AND a drain-timer render both firing.
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer)
      this.drainTimer = null
    }

    // Flush deferred interaction-time update before rendering so we call
    // Date.now() at most once per frame instead of once per keypress.
    // Done before the render to avoid dirtying state that would trigger
    // an extra React re-render cycle.
    flushInteractionTime()
    const renderStart = performance.now()
    const { columns: terminalWidth, rows: terminalRows } = this.stdoutSize()
    const frame = this.renderer({
      frontFrame: this.frontFrame,
      backFrame: this.backFrame,
      isTTY: this.options.stdout.isTTY,
      terminalWidth,
      terminalRows,
      altScreen: this.altScreenActive,
      prevFrameContaminated: this.prevFrameContaminated,
      prevOverlayRect: this.prevOverlayRect,
    })
    const rendererMs = performance.now() - renderStart

    // Sticky/auto-follow scrolled the ScrollBox this frame. Translate the
    // selection by the same delta so the highlight stays anchored to the
    // TEXT (native terminal behavior — the selection walks up the screen
    // as content scrolls, eventually clipping at the top). frontFrame
    // still holds the PREVIOUS frame's screen (swap is at ~500 below), so
    // captureScrolledRows reads the rows that are about to scroll out
    // before they're overwritten — the text stays copyable until the
    // selection scrolls entirely off. During drag, focus tracks the mouse
    // (screen-local) so only anchor shifts — selection grows toward the
    // mouse as the anchor walks up. After release, both ends are text-
    // anchored and move as a block.
    const follow = consumeFollowScroll()
    if (
      follow &&
      this.selection.anchor &&
      // Only translate if the selection is ON scrollbox content. Selections
      // in the footer/prompt/StickyPromptHeader are on static text — the
      // scroll doesn't move what's under them. Without this guard, a
      // footer selection would be shifted by -delta then clamped to
      // viewportBottom, teleporting it into the scrollbox. Mirror the
      // bounds check the deleted check() in ScrollKeybindingHandler had.
      this.selection.anchor.row >= follow.viewportTop &&
      this.selection.anchor.row <= follow.viewportBottom
    ) {
      const { delta, viewportTop, viewportBottom } = follow
      // captureScrolledRows and shift* are a pair: capture grabs rows about
      // to scroll off, shift moves the selection endpoint so the same rows
      // won't intersect again next frame. Capturing without shifting leaves
      // the endpoint in place, so the SAME viewport rows re-intersect every
      // frame and scrolledOffAbove grows without bound — getSelectedText
      // then returns ever-growing text on each re-copy. Keep capture inside
      // each shift branch so the pairing can't be broken by a new guard.
      if (this.selection.isDragging) {
        if (hasSelection(this.selection)) {
          captureScrolledRows(
            this.selection,
            this.frontFrame.screen,
            viewportTop,
            viewportTop + delta - 1,
            'above',
          )
        }
        shiftAnchor(this.selection, -delta, viewportTop, viewportBottom)
      } else if (
        // Flag-3 guard: the anchor check above only proves ONE endpoint is
        // on scrollbox content. A drag from row 3 (scrollbox) into the
        // footer at row 6, then release, leaves focus outside the viewport
        // — shiftSelectionForFollow would clamp it to viewportBottom,
        // teleporting the highlight from static footer into the scrollbox.
        // Symmetric check: require BOTH ends inside to translate. A
        // straddling selection falls through to NEITHER shift NOR capture:
        // the footer endpoint pins the selection, text scrolls away under
        // the highlight, and getSelectedText reads the CURRENT screen
        // contents — no accumulation. Dragging branch doesn't need this:
        // shiftAnchor ignores focus, and the anchor DOES shift (so capture
        // is correct there even when focus is in the footer).
        !this.selection.focus ||
        (this.selection.focus.row >= viewportTop && this.selection.focus.row <= viewportBottom)
      ) {
        if (hasSelection(this.selection)) {
          captureScrolledRows(
            this.selection,
            this.frontFrame.screen,
            viewportTop,
            viewportTop + delta - 1,
            'above',
          )
        }
        const cleared = shiftSelectionForFollow(this.selection, -delta, viewportTop, viewportBottom)
        // Auto-clear (both ends overshot minRow) must notify React-land
        // so useHasSelection re-renders and the footer copy/escape hint
        // disappears. notifySelectionChange() would recurse into onRender;
        // fire the listeners directly — they schedule a React update for
        // LATER, they don't re-enter this frame.
        if (cleared) {
          for (const cb of this.selectionListeners) {
            cb()
          }
        }
      }
    }

    // selection overlay：直接反转 screen buffer 中的 cell 样式，
    // 使 diff 将选区识别为普通 cell 变化，让 LogUpdate 保持为纯 diff 引擎。
    //
    // Full-screen damage (PR #20120) is a correctness backstop for the
    // sibling-resize bleed: when flexbox siblings resize between frames
    // (spinner appears → bottom grows → scrollbox shrinks), the
    // cached-clear + clip-and-cull + setCellAt damage union can miss
    // transition cells at the boundary. But that only happens when layout
    // actually SHIFTS — didLayoutShift() tracks exactly this (any node's
    // cached yoga position/size differs from current, or a child was
    // removed). Steady-state frames (spinner rotate, clock tick, text
    // stream into fixed-height box) don't shift layout, so normal damage
    // bounds are correct and diffEach only compares the damaged region.
    //
    // Selection also requires full damage: overlay writes via setCellStyleId
    // which doesn't track damage, and prev-frame overlay cells need to be
    // compared when selection moves/clears. prevFrameContaminated covers
    // the frame-after-selection-clears case.
    let selActive = false
    let hlActive = false
    // 计算本帧 overlay 的行区间（用于 prevOverlayRect 和 damage 限定）
    let overlayMinRow = Infinity
    let overlayMaxRow = -1
    if (this.altScreenActive) {
      selActive = hasSelection(this.selection)
      if (selActive) {
        applySelectionOverlay(frame.screen, this.selection, this.stylePool)
        const b = selectionBounds(this.selection)
        if (b) {
          overlayMinRow = Math.min(overlayMinRow, b.start.row)
          overlayMaxRow = Math.max(overlayMaxRow, b.end.row)
        }
      }
      // scan highlight：反转所有可见匹配项（less/vim 风格）。
      // 下方的 position highlight 会在其上叠加 CURRENT（黄色）。
      const searchResult = applySearchHighlight(
        frame.screen,
        this.searchHighlightQuery,
        this.stylePool,
      )
      hlActive = searchResult !== null
      if (searchResult) {
        overlayMinRow = Math.min(overlayMinRow, searchResult.minRow)
        overlayMaxRow = Math.max(overlayMaxRow, searchResult.maxRow)
      }
      // 基于位置的 CURRENT：在 positions[currentIdx] + rowOffset 处写入黄色。
      // 无需扫描；positions 来自消息首次挂载时的先前扫描。
      // 消息相对位置 + rowOffset = 屏幕位置。
      if (this.searchPositions) {
        const sp = this.searchPositions
        const posBounds = applyPositionedHighlight(
          frame.screen,
          this.stylePool,
          sp.positions,
          sp.rowOffset,
          sp.currentIdx,
        )
        if (posBounds) {
          hlActive = true
          overlayMinRow = Math.min(overlayMinRow, posBounds.minRow)
          overlayMaxRow = Math.max(overlayMaxRow, posBounds.maxRow)
        }
      }
    }

    // Full-damage backstop: applies on BOTH alt-screen and main-screen.
    // Layout shifts (spinner appears, status line resizes) can leave stale
    // cells at sibling boundaries that per-node damage tracking misses.
    // prevFrameContaminated covers the cleanup frame for external pollution
    // (stderr, resize). Selection/highlight overlays use setCellStyleId
    // which already tracks damage via unionRect — no full-screen override needed.
    const layoutShifted = didLayoutShift()
    if (layoutShifted || this.prevFrameContaminated) {
      frame.screen.damage = {
        x: 0,
        y: 0,
        width: frame.screen.width,
        height: frame.screen.height,
      }
    }

    // Alt-screen: anchor the physical cursor to (0,0) before every diff.
    // All cursor moves in log-update are RELATIVE to prev.cursor; if tmux
    // (or any emulator) perturbs the physical cursor out-of-band (status
    // bar refresh, pane redraw, Cmd+K wipe), the relative moves drift and
    // content creeps up 1 row/frame. CSI H resets the physical cursor;
    // passing prev.cursor=(0,0) makes the diff compute from the same spot.
    // Self-healing against any external cursor manipulation. Main-screen
    // can't do this — cursor.y tracks scrollback rows CSI H can't reach.
    // The CSI H write is deferred until after the diff is computed so we
    // can skip it for empty diffs (no writes → physical cursor unused).
    // cursor 覆盖由 log.render 的 cursorOverride 参数直接传递，
    // 不再需要每帧构造 prevFrame 浅拷贝。后面 VtPlusPlus 走 main-screen 跳过此处。
    // 路径。VtPlusPlus 的整帧行级 diff 会放大 JediTerm 的 IME 重绘问题。
    if (this.frameSink && !this.altScreenActive) {
      const handled = this.frameSink(frame, this.stylePool)
      if (handled) {
        this.backFrame = this.frontFrame
        this.frontFrame = frame
        if (frame.scrollDrainPending && !this.drainTimer) {
          this.drainTimer = setTimeout(() => {
            this.drainTimer = null
            this.scheduleRender()
          }, FRAME_INTERVAL_MS)
        }
        this.displayCursor = null
        this.options.onFrame?.({ durationMs: performance.now() - renderStart, flickers: [] })
        return
      }
    }
    const tDiff = performance.now()
    // diff 与原生光标恢复都必须以同一份旧帧为基准。帧交换后
    // this.frontFrame 已指向新帧，不能再用它计算停靠光标的回退距离。
    const previousFrame = this.frontFrame
    const diff = this.log.render(
      previousFrame,
      frame,
      this.altScreenActive,
      // 同步输出与区域滚动是独立能力。JediTerm 支持 DEC 2026，
      // 但不支持此处的 DECSTBM + SU/SD；误启用会让物理画面与
      // 内存帧发生行偏移，最终表现为正文和状态栏重叠。
      DECSTBM_FAST_PATH_SUPPORTED,
      this.altScreenActive ? ALT_SCREEN_ANCHOR_CURSOR : undefined,
      this.usesWideCellRenderAnchor &&
        canAnchorWideCellsForFrame(layoutShifted, this.altScreenActive)
        ? layoutShifted && this.usesJediTermLayoutQuirks && this.altScreenActive
          ? JEDITERM_LAYOUT_SHIFT_QUIRKS
          : WIDE_CELL_RENDER_QUIRKS
        : undefined,
    )
    const diffMs = performance.now() - tDiff
    // 交换 buffer
    this.backFrame = previousFrame
    this.frontFrame = frame

    // 定期重置 char/hyperlink pool，防止长会话中无限增长。
    // 5 分钟一次足够稀疏，O(cells) 的迁移成本可以忽略；复用 renderStart 避免额外读取时钟。
    if (renderStart - this.lastPoolResetTime > 5 * 60 * 1000) {
      this.resetPools()
      this.lastPoolResetTime = renderStart
    }
    const flickers: FrameEvent['flickers'] = []
    for (const patch of diff) {
      if (patch.type === 'clearTerminal') {
        flickers.push({
          desiredHeight: frame.screen.height,
          availableHeight: frame.viewport.height,
          reason: patch.reason,
        })
        if (isDebugRepaintsEnabled() && patch.debug) {
          const chain = dom.findOwnerChainAtRow(this.rootNode, patch.debug.triggerY)
          logForDebugging(
            `[REPAINT] full reset · ${patch.reason} · row ${patch.debug.triggerY}\n` +
              `  prev: "${patch.debug.prevLine}"\n` +
              `  next: "${patch.debug.nextLine}"\n` +
              `  culprit: ${chain.length ? chain.join(' < ') : '(no owner chain captured)'}`,
            {
              level: 'warn',
            },
          )
        }
      }
    }
    const tOptimize = performance.now()
    const optimized = optimize(diff)
    const optimizeMs = performance.now() - tOptimize
    const hasDiff = optimized.length > 0
    if (this.altScreenActive && hasDiff) {
      // Prepend CSI H to anchor the physical cursor to (0,0) so
      // log-update's relative moves compute from a known spot (self-healing
      // against out-of-band cursor drift, see the ALT_SCREEN_ANCHOR_CURSOR
      // comment above). Append CSI row;1 H to park the cursor at the bottom
      // row (where the prompt input is) — without this, the cursor ends
      // wherever the last diff write landed (a different row every frame),
      // making iTerm2's cursor guide flicker as it chases the cursor.
      // BSU/ESU protects content atomicity but iTerm2's guide tracks cursor
      // position independently. Parking at bottom (not 0,0) keeps the guide
      // where the user's attention is.
      //
      // After resize, prepend ERASE_SCREEN too. The diff only writes cells
      // that changed; cells where new=blank and prev-buffer=blank get skipped
      // — but the physical terminal still has stale content there (shorter
      // lines at new width leave old-width text tails visible). ERASE inside
      // BSU/ESU is atomic: old content stays visible until the whole
      // erase+paint lands, then swaps in one go. Writing ERASE_SCREEN
      // synchronously in handleResize would blank the screen for the ~80ms
      // render() takes.
      if (this.needsEraseBeforePaint) {
        this.needsEraseBeforePaint = false
        optimized.unshift(ERASE_THEN_HOME_PATCH)
      } else {
        optimized.unshift(CURSOR_HOME_PATCH)
      }
      optimized.push(this.altScreenParkPatch)
    }

    // Native cursor positioning: park the terminal cursor at the declared
    // position so IME preedit text renders inline and screen readers /
    // magnifiers can follow the input. nodeCache holds the absolute screen
    // rect populated by renderNodeToOutput this frame (including scrollTop
    // translation) — if the declared node didn't render (stale declaration
    // after remount, or scrolled out of view), it won't be in the cache
    // and no move is emitted.
    const decl = this.cursorDeclaration
    const rect = decl !== null ? nodeCache.get(decl.node) : undefined
    const target =
      decl !== null && rect !== undefined
        ? {
            x: rect.x + decl.relativeX,
            y: rect.y + decl.relativeY,
          }
        : null
    const parked = this.displayCursor

    // 保留空 diff 的零写入快速路径：没有渲染内容且停放目标未变化时，跳过所有光标写入。
    const targetMoved =
      target !== null && (parked === null || parked.x !== target.x || parked.y !== target.y)
    const nativeCursorChanged =
      this.options.nativeCursor === true &&
      target !== null &&
      decl !== null &&
      (decl.visible || isEnvTruthy(process.env.ZY_CODE_ACCESSIBILITY)) !== this.nativeCursorVisible
    if (hasDiff || targetMoved || nativeCursorChanged || (target === null && parked !== null)) {
      // Main-screen preamble: log-update's relative moves assume the
      // physical cursor is at prevFrame.cursor. If last frame parked it
      // elsewhere, move back before the diff runs. Alt-screen's CSI H
      // already resets to (0,0) so no preamble needed.
      if (parked !== null && !this.altScreenActive && hasDiff) {
        const pdx = previousFrame.cursor.x - parked.x
        const pdy = previousFrame.cursor.y - parked.y
        if (pdx !== 0 || pdy !== 0) {
          optimized.unshift({
            type: 'stdout',
            content: cursorMove(pdx, pdy),
          })
        }
      }
      if (target !== null) {
        if (this.altScreenActive) {
          // 绝对 CUP（从 1 开始）；无论如何下一帧都会由 CSI H 重置。
          // 在 altScreenParkPatch 后发出，确保声明的位置生效。
          const row = Math.min(Math.max(target.y + 1, 1), terminalRows)
          const col = Math.min(Math.max(target.x + 1, 1), terminalWidth)
          optimized.push({
            type: 'stdout',
            content: cursorPosition(row, col),
          })
        } else {
          // After the diff (or preamble), cursor is at frame.cursor. If no
          // diff AND previously parked, it's still at the old park position
          // (log-update wrote nothing). Otherwise it's at frame.cursor.
          const from =
            !hasDiff && parked !== null
              ? parked
              : {
                  x: frame.cursor.x,
                  y: frame.cursor.y,
                }
          const dx = target.x - from.x
          const dy = target.y - from.y
          if (dx !== 0 || dy !== 0) {
            optimized.push({
              type: 'stdout',
              content: cursorMove(dx, dy),
            })
          }
        }
        if (decl?.eraseToEnd === true) {
          // JediTerm 用空格覆盖旧文本后仍会保留该逻辑行的最大宽度。
          // 在原生光标停靠到文本末尾后用 EL 真正截断行尾，避免后续
          // IME inline inlay 与不可见的旧列相加后触发软换行。
          optimized.push({
            type: 'stdout',
            content: eraseToEndOfLine(),
          })
        }
        this.displayCursor = target
        if (this.options.nativeCursor === true) {
          const shouldShow =
            decl?.visible === true || isEnvTruthy(process.env.ZY_CODE_ACCESSIBILITY)
          // 与 Claude Code 一致：先隐藏旧位置的原生光标，再在新的停靠
          // 位置显示，避免移动过程中留下 JediTerm 的组合装饰。
          if (this.nativeCursorVisible) {
            optimized.unshift({ type: 'cursorHide' })
          }
          if (shouldShow) {
            optimized.push({ type: 'cursorShow' })
          }
          this.nativeCursorVisible = shouldShow
        }
      } else {
        // Declaration cleared (input blur, unmount). Restore physical cursor
        // to frame.cursor before forgetting the park position — otherwise
        // displayCursor=null lies about where the cursor is, and the NEXT
        // frame's preamble (or log-update's relative moves) computes from a
        // wrong spot. The preamble above handles hasDiff; this handles
        // !hasDiff (e.g. accessibility mode where blur doesn't change
        // renderedValue since invert is identity).
        if (parked !== null && !this.altScreenActive && !hasDiff) {
          const rdx = frame.cursor.x - parked.x
          const rdy = frame.cursor.y - parked.y
          if (rdx !== 0 || rdy !== 0) {
            optimized.push({
              type: 'stdout',
              content: cursorMove(rdx, rdy),
            })
          }
        }
        this.displayCursor = null
        if (
          this.options.nativeCursor === true &&
          this.nativeCursorVisible &&
          !isEnvTruthy(process.env.ZY_CODE_ACCESSIBILITY)
        ) {
          optimized.unshift({ type: 'cursorHide' })
        }
        this.nativeCursorVisible = false
      }
    }
    const tWrite = performance.now()
    writeDiffToTerminal(this.terminal, optimized, this.altScreenActive && !SYNC_OUTPUT_SUPPORTED)
    const writeMs = performance.now() - tWrite

    // Update blit safety for the NEXT frame. The frame just rendered
    // becomes frontFrame (= next frame's prevScreen).
    // prevFrameContaminated is set by external events (stderr, resize, etc)
    // and NOT by overlay — overlay uses prevOverlayRect for per-node blit
    // exclusion instead, so non-overlay nodes can safely blit from prevScreen.
    this.prevFrameContaminated = false
    // 跟踪 overlay rect，供下一帧逐节点排除 blit。
    // 仅当 overlay 未覆盖全屏时有意义；null 表示没有 overlay。
    this.prevOverlayRect =
      (selActive || hlActive) && overlayMinRow <= overlayMaxRow
        ? {
            x: 0,
            y: overlayMinRow,
            width: frame.screen.width,
            height: overlayMaxRow - overlayMinRow + 1,
          }
        : null

    // A ScrollBox has pendingScrollDelta left to drain — schedule the next
    // frame. MUST NOT call this.scheduleRender() here: we're inside a
    // trailing-edge throttle invocation, timerId is undefined, and lodash's
    // debounce sees timeSinceLastCall >= wait (last call was at the start
    // of this window) → leadingEdge fires IMMEDIATELY → double render ~0.1ms
    // apart → jank. Use a plain timeout. If a wheel event arrives first,
    // its scheduleRender path fires a render which clears this timer at
    // the top of onRender — no double.
    //
    // Drain frames are cheap (DECSTBM + ~10 patches, ~200 bytes) so run at
    // quarter interval (~250fps, setTimeout practical floor) for max scroll
    // speed. Regular renders stay at FRAME_INTERVAL_MS via the throttle.
    if (frame.scrollDrainPending) {
      this.drainTimer = setTimeout(() => this.onRender(), FRAME_INTERVAL_MS >> 2)
    }
    const yogaMs = getLastYogaMs()
    const commitMs = getLastCommitMs()
    const yc = this.lastYogaCounters
    // 重置该值，避免仅执行 drain、没有 React commit 的帧重复使用旧值。
    resetProfileCounters()
    this.lastYogaCounters = {
      ms: 0,
      visited: 0,
      measured: 0,
      cacheHits: 0,
      live: 0,
    }
    this.options.onFrame?.({
      durationMs: performance.now() - renderStart,
      phases: {
        renderer: rendererMs,
        diff: diffMs,
        optimize: optimizeMs,
        write: writeMs,
        patches: diff.length,
        yoga: yogaMs,
        commit: commitMs,
        yogaVisited: yc.visited,
        yogaMeasured: yc.measured,
        yogaCacheHits: yc.cacheHits,
        yogaLive: yc.live,
      },
      flickers,
    })
  }
  pause(): void {
    // 暂停前刷新待处理的 React 更新并渲染。
    reconciler.flushSyncFromReconciler()
    this.onRender()
    this.isPaused = true
  }
  resume(): void {
    this.isPaused = false
    this.onRender()
  }

  /**
   * 重置 frame buffer，使下一次渲染从头写入整个屏幕。
   * 终端内容被外部进程（如 tmux、shell、fullscreen TUI）破坏时，
   * 应在 resume() 前调用此方法。
   */
  repaint(): void {
    this.frontFrame = emptyFrame(
      this.frontFrame.viewport.height,
      this.frontFrame.viewport.width,
      this.stylePool,
      this.charPool,
      this.hyperlinkPool,
    )
    this.backFrame = emptyFrame(
      this.backFrame.viewport.height,
      this.backFrame.viewport.width,
      this.stylePool,
      this.charPool,
      this.hyperlinkPool,
    )
    this.log.reset()
    // Physical cursor position is unknown after external terminal corruption.
    // Clear displayCursor so the cursor preamble doesn't emit a stale
    // relative move from where we last parked it.
    this.displayCursor = null
  }

  /**
   * 清除物理终端并强制完整重绘。
   *
   * 实现传统 readline ctrl+l 行为：清除可见屏幕并重绘当前内容。
   * 当终端被外部操作（macOS Cmd+K）清除，而 Ink diff 引擎认为未变化的 cell
   * 无需重绘时，也用作恢复路径。scrollback 会保留。
   */
  forceRedraw(): void {
    if (!this.options.stdout.isTTY || this.isUnmounted || this.isPaused) {
      return
    }
    this.options.stdout.write(ERASE_SCREEN + CURSOR_HOME)
    if (this.altScreenActive) {
      this.resetFramesForAltScreen()
    } else {
      this.repaint()
      // repaint() resets frontFrame to 0×0. Without this flag the next
      // frame's blit optimization copies from that empty screen and the
      // diff sees no content. onRender resets the flag at frame end.
      this.prevFrameContaminated = true
    }
    this.onRender()
  }

  /**
   * 将前一帧标记为不可信，禁止用于 blit，迫使下一次渲染执行 full-damage diff，
   * 而不是逐节点快速路径。
   *
   * 比 forceRedraw() 更轻量：不清屏，也不额外写入。卸载较高的 overlay 时，
   * 应从 useLayoutEffect cleanup 调用；blit 快速路径可能把 overlay 帧中的旧 cell
   * 复制到收缩后布局无法覆盖的行，留下标题或 divider 残影。
   * onRender 会在帧结束时重置标志，因此只生效一次。
   */
  invalidatePrevFrame(): void {
    this.prevFrameContaminated = true
  }

  /**
   * 由 <AlternateScreen> 组件在挂载和卸载时调用。
   * 控制 renderer 对 cursor.y 的钳制，并门控 SIGCONT/resize/unmount 处理器中
   * 感知 alt screen 的行为。状态变化时重绘，确保 alt screen 首帧以及退出后的
   * main screen 首帧都是完整重绘，不带旧 diff 状态。
   */
  setAltScreenActive(active: boolean, mouseTracking = false): void {
    if (this.altScreenActive === active) {
      return
    }
    this.altScreenActive = active
    this.altScreenMouseTracking = active && mouseTracking
    if (active) {
      this.resetFramesForAltScreen()
    } else {
      this.repaint()
    }
  }
  get isAltScreenActive(): boolean {
    return this.altScreenActive
  }

  /**
   * 出现间隔（stdin 静默超过 5 秒或 event loop 停顿）后重新声明终端模式。
   * 用于捕获 tmux detach→attach、ssh 重连和笔记本睡眠/唤醒；这些情况都不会发送 SIGCONT。
   * 终端可能在重连时重置 DEC private mode，此方法负责恢复。
   *
   * 始终重新声明扩展按键报告和鼠标跟踪。鼠标跟踪是幂等的：已设置 DEC private mode
   * 时再次设置不会产生效果；Kitty keyboard protocol 则不是，CSI >1u 会压栈，
   * 因此先 pop 以保持深度平衡。按规范，对空栈 pop 不执行操作，所以终端重置后仍能
   * 将深度从 0 恢复到 1。若不 pop，每次超过 5 秒的空闲间隔都会增加一个栈项，
   * 退出或 suspend 时的一次 pop 无法清空，shell 会留在 CSI u 模式，
   * Ctrl+C/Ctrl+D 会泄漏为 escape sequence。
   *
   * 重新进入 alt screen（ERASE_SCREEN + frame reset）不具幂等性，会清空屏幕，
   * 因此需通过 includeAltScreen 显式启用。stdin-gap 调用方会在普通的 5 秒以上空闲
   * 加按键后触发，不得清屏；event loop 停顿检测器只在真实的睡眠/唤醒时触发并启用它。
   * tmux attach / ssh 重连通常会发送 resize，handleResize 已覆盖其 alt screen 处理。
   */
  reassertTerminalModes = (includeAltScreen = false): void => {
    if (!this.options.stdout.isTTY) {
      return
    }
    // editor 交接期间不要修改终端；此处重新启用 Kitty keyboard 会抵消
    // enterAlternateScreen 的禁用操作，使 nano 再次收到 CSI-u sequence。
    if (this.isPaused) {
      return
    }
    // Extended keys — re-assert if enabled (App.tsx enables these on
    // allowlisted terminals at raw-mode entry; a terminal reset clears them).
    // Pop-before-push keeps Kitty stack depth at 1 instead of accumulating
    // on each call.
    if (supportsExtendedKeys()) {
      this.options.stdout.write(
        DISABLE_KITTY_KEYBOARD + ENABLE_KITTY_KEYBOARD + ENABLE_MODIFY_OTHER_KEYS,
      )
    }
    if (!this.altScreenActive) {
      return
    }
    // 鼠标跟踪是幂等的，可在每次 stdin 间隔后安全地重新声明。
    if (this.altScreenMouseTracking) {
      this.options.stdout.write(ENABLE_MOUSE_TRACKING)
    }
    // 重新进入 alt screen 是破坏性操作（ERASE_SCREEN），仅供有充分信号确认终端
    // 确实退出 mode 1049 的调用方使用。
    if (includeAltScreen) {
      this.reenterAltScreen()
    }
  }

  /**
   * 将此实例标记为已卸载，使后续 unmount() 调用直接返回。
   * gracefulShutdown 的 cleanupTerminalModes() 在发送 EXIT_ALT_SCREEN 后、
   * 其余终端重置序列之前调用此方法。
   * Without this, signal-exit's deferred ink.unmount() (triggered by
   * process.exit()) runs the full unmount path: onRender() + writeSync
   * cleanup block + updateContainerSync → AlternateScreen unmount cleanup.
   * The result is 2-3 redundant EXIT_ALT_SCREEN sequences landing on the
   * main screen AFTER printResumeHint(), which tmux (at least) interprets
   * as restoring the saved cursor position — clobbering the resume hint.
   */
  detachForShutdown(): void {
    this.isUnmounted = true
    // 取消待执行的 throttled render，避免它在 cleanupTerminalModes() 与 process.exit()
    // 之间触发并写入 main screen。
    this.scheduleRender.cancel?.()
    // Restore stdin from raw mode. unmount() used to do this via React
    // unmount (App.componentWillUnmount → handleSetRawMode(false)) but we're
    // short-circuiting that path. Must use this.options.stdin — NOT
    // process.stdin — because getStdinOverride() may have opened /dev/tty
    // when stdin is piped.
    const stdin = this.options.stdin as NodeJS.ReadStream & {
      isRaw?: boolean
      setRawMode?: (m: boolean) => void
    }
    this.drainStdin()
    if (stdin.isTTY && stdin.isRaw && stdin.setRawMode) {
      stdin.setRawMode(false)
    }
  }

  /** @see drainStdin */
  drainStdin(): void {
    drainStdin(this.options.stdin)
  }

  /**
   * 重新进入 alt screen、清屏、光标归位、重新启用鼠标跟踪并重置 frame buffer，
   * 使下一次渲染从头重绘。用于从 SIGCONT、resize、stdin 间隔或 event loop 停顿
   *（睡眠/唤醒）中自愈；这些情况都可能让终端回到 main screen，
   * 而 altScreenActive 仍为 true。已在 alt screen 时，ENTER_ALT_SCREEN 在终端侧无效果。
   */
  private reenterAltScreen(): void {
    if (isAlternateScreenDisabled()) {
      // 逻辑 alt-screen：跳过物理 DEC 1049，仅重置帧缓冲 + 鼠标
      if (this.altScreenMouseTracking) {
        this.options.stdout.write(ENABLE_MOUSE_TRACKING)
      }
      this.resetFramesForAltScreen()
      return
    }
    this.options.stdout.write(
      ENTER_ALT_SCREEN +
        ERASE_SCREEN +
        CURSOR_HOME +
        (this.altScreenMouseTracking ? ENABLE_MOUSE_TRACKING : ''),
    )
    this.resetFramesForAltScreen()
  }

  /**
   * Seed prev/back frames with full-size BLANK screens (rows×cols of empty
   * cells, not 0×0). In alt-screen mode, next.screen.height is always
   * terminalRows; if prev.screen.height is 0 (emptyFrame's default),
   * log-update sees heightDelta > 0 ('growing') and calls renderFrameSlice,
   * whose trailing per-row CR+LF at the last row scrolls the alt screen,
   * permanently desyncing the virtual and physical cursors by 1 row.
   *
   * With a rows×cols blank prev, heightDelta === 0 → standard diffEach
   * → moveCursorTo (CSI cursorMove, no LF, no scroll).
   *
   * viewport.height = rows + 1 matches the renderer's alt-screen output,
   * preventing a spurious resize trigger on the first frame. cursor.y = 0
   * matches the physical cursor after ENTER_ALT_SCREEN + CSI H (home).
   */
  private resetFramesForAltScreen(): void {
    const rows = this.terminalRows
    const cols = this.terminalColumns
    const blank = (): Frame => ({
      screen: createScreen(cols, rows, this.stylePool, this.charPool, this.hyperlinkPool),
      viewport: {
        width: cols,
        height: rows + 1,
      },
      cursor: {
        x: 0,
        y: 0,
        visible: true,
      },
    })
    this.frontFrame = blank()
    this.backFrame = blank()
    this.log.reset()
    // Defense-in-depth: alt-screen skips the cursor preamble anyway (CSI H
    // resets), but a stale displayCursor would be misleading if we later
    // exit to main-screen without an intervening render.
    this.displayCursor = null
    // Fresh frontFrame is blank rows×cols — blitting from it would copy
    // blanks over content. Next alt-screen frame must full-render.
    this.prevFrameContaminated = true
  }

  /**
   * 将当前选区复制到剪贴板，但不清除高亮。
   * 与 iTerm2 的 copy-on-select 行为一致：自动复制后选中区域仍然可见。
   */
  copySelectionNoClear(): string {
    if (!hasSelection(this.selection)) {
      return ''
    }
    const text = getSelectedText(this.selection, this.frontFrame.screen)
    if (text) {
      // Raw OSC 52, or DCS-passthrough-wrapped OSC 52 inside tmux (tmux
      // drops it silently unless allow-passthrough is on — no regression).
      void setClipboard(text).then((raw) => {
        if (raw) {
          this.options.stdout.write(raw)
        }
      })
    }
    return text
  }

  /**
   * 通过 OSC 52 将当前文本选区复制到系统剪贴板并清除选区。
   * 返回复制的文本；没有选区时返回空字符串。
   */
  copySelection(): string {
    if (!hasSelection(this.selection)) {
      return ''
    }
    const text = this.copySelectionNoClear()
    clearSelection(this.selection)
    this.notifySelectionChange()
    return text
  }

  /** 清除当前文本选区，但不复制。 */
  clearTextSelection(): void {
    if (!hasSelection(this.selection)) {
      return
    }
    clearSelection(this.selection)
    this.notifySelectionChange()
  }

  /**
   * Set the search highlight query. Non-empty → all visible occurrences
   * are inverted (SGR 7) on the next frame; first one also underlined.
   * Empty → clears (prevFrameContaminated handles the frame after). Same
   * damage-tracking machinery as selection — setCellStyleId doesn't track
   * damage, so the overlay forces full-frame damage while active.
   */
  setSearchHighlight(query: string): void {
    if (this.searchHighlightQuery === query) {
      return
    }
    this.searchHighlightQuery = query
    this.scheduleRender()
  }

  /** Paint an EXISTING DOM subtree to a fresh Screen at its natural
   *  height, scan for query. Returns positions relative to the element's
   *  bounding box (row 0 = element top).
   *
   *  The element comes from the MAIN tree — built with all real
   *  providers, yoga already computed. We paint it to a fresh buffer
   *  with offsets so it lands at (0,0). Same paint path as the main
   *  render. Zero drift. No second React root, no context bridge.
   *
   *  ~1-2ms (paint only, no reconcile — the DOM is already built). */
  scanElementSubtree(el: dom.DOMElement): MatchPosition[] {
    if (!this.searchHighlightQuery || !el.yogaNode) {
      return []
    }
    const width = Math.ceil(el.yogaNode.getComputedWidth())
    const height = Math.ceil(el.yogaNode.getComputedHeight())
    if (width <= 0 || height <= 0) {
      return []
    }
    // renderNodeToOutput adds el's OWN computedLeft/Top to offsetX/Y.
    // Passing -elLeft/-elTop nets to 0 → paints at (0,0) in our buffer.
    const elLeft = el.yogaNode.getComputedLeft()
    const elTop = el.yogaNode.getComputedTop()
    const screen = createScreen(width, height, this.stylePool, this.charPool, this.hyperlinkPool)
    const output = new Output({
      width,
      height,
      stylePool: this.stylePool,
      screen,
    })
    renderNodeToOutput(el, output, {
      offsetX: -elLeft,
      offsetY: -elTop,
      prevScreen: undefined,
    })
    const rendered = output.get()
    // renderNodeToOutput wrote our offset positions to nodeCache —
    // corrupts the main render (it'd blit from wrong coords). Mark the
    // subtree dirty so the next main render repaints + re-caches
    // correctly. One extra paint of this message, but correct > fast.
    dom.markDirty(el)
    const positions = scanPositions(rendered, this.searchHighlightQuery)
    logForDebugging(
      `scanElementSubtree: q='${this.searchHighlightQuery}' ` +
        `el=${width}x${height}@(${elLeft},${elTop}) n=${positions.length} ` +
        `[${positions
          .slice(0, 10)
          .map((p) => `${p.row}:${p.col}`)
          .join(',')}` +
        `${positions.length > 10 ? ',…' : ''}]`,
    )
    return positions
  }

  /** Set the position-based highlight state. Every frame, writes CURRENT
   *  style at positions[currentIdx] + rowOffset. null clears. The scan-
   *  highlight (inverse on all matches) still runs — this overlays yellow
   *  on top. rowOffset changes as the user scrolls (= message's current
   *  screen-top); positions stay stable (message-relative). */
  setSearchPositions(
    state: {
      positions: MatchPosition[]
      rowOffset: number
      currentIdx: number
    } | null,
  ): void {
    this.searchPositions = state
    this.scheduleRender()
  }

  /**
   * Set the selection highlight background color. Replaces the per-cell
   * SGR-7 inverse with a solid theme-aware bg (matches native terminal
   * selection). Accepts the same color formats as Text backgroundColor
   * (rgb(), ansi:name, #hex, ansi256()) — colorize() routes through
   * chalk so the tmux/xterm.js level clamps in colorize.ts apply and
   * the emitted SGR is correct for the current terminal.
   *
   * Called by React-land once theme is known (ScrollKeybindingHandler's
   * useEffect watching useTheme). Before that call, withSelectionBg
   * falls back to withInverse so selection still renders on the first
   * frame; the effect fires before any mouse input so the fallback is
   * unobservable in practice.
   */
  setSelectionBgColor(color: string): void {
    // Wrap a NUL marker, then split on it to extract the open/close SGR.
    // colorize returns the input unchanged if the color string is bad —
    // no NUL-split then, so fall through to null (inverse fallback).
    const wrapped = colorize('\0', color, 'background')
    const nul = wrapped.indexOf('\0')
    if (nul <= 0 || nul === wrapped.length - 1) {
      this.stylePool.setSelectionBg(null)
      return
    }
    this.stylePool.setSelectionBg({
      type: 'ansi',
      code: wrapped.slice(0, nul),
      endCode: wrapped.slice(nul + 1), // always \x1b[49m for bg
    })
    // No scheduleRender: this is called from a React effect that already
    // runs inside the render cycle, and the bg only matters once a
    // selection exists (which itself triggers a full-damage frame).
  }

  /**
   * Capture text from rows about to scroll out of the viewport during
   * drag-to-scroll. Must be called BEFORE the ScrollBox scrolls so the
   * screen buffer still holds the outgoing content. Accumulated into
   * the selection state and joined back in by getSelectedText.
   */
  captureScrolledRows(firstRow: number, lastRow: number, side: 'above' | 'below'): void {
    captureScrolledRows(this.selection, this.frontFrame.screen, firstRow, lastRow, side)
  }

  /**
   * Shift anchor AND focus by dRow, clamped to [minRow, maxRow]. Used by
   * keyboard scroll handlers (PgUp/PgDn etc.) so the highlight tracks the
   * content instead of disappearing. Unlike shiftAnchor (drag-to-scroll),
   * this moves BOTH endpoints — the user isn't holding the mouse at one
   * edge. Supplies screen.width for the col-reset-on-clamp boundary.
   */
  shiftSelectionForScroll(dRow: number, minRow: number, maxRow: number): void {
    const hadSel = hasSelection(this.selection)
    shiftSelection(this.selection, dRow, minRow, maxRow, this.frontFrame.screen.width)
    // shiftSelection clears when both endpoints overshoot the same edge
    // (Home/g/End/G page-jump past the selection). Notify subscribers so
    // useHasSelection updates. Safe to call notifySelectionChange here —
    // this runs from keyboard handlers, not inside onRender().
    if (hadSel && !hasSelection(this.selection)) {
      this.notifySelectionChange()
    }
  }

  /**
   * Keyboard selection extension (shift+arrow/home/end). Moves focus;
   * anchor stays fixed so the highlight grows or shrinks relative to it.
   * Left/right wrap across row boundaries — native macOS text-edit
   * behavior: shift+left at col 0 wraps to end of the previous row.
   * Up/down clamp at viewport edges (no scroll-to-extend yet). Drops to
   * char mode. No-op outside alt-screen or without an active selection.
   */
  moveSelectionFocus(move: FocusMove): void {
    if (!this.altScreenActive) {
      return
    }
    const { focus } = this.selection
    if (!focus) {
      return
    }
    const { width, height } = this.frontFrame.screen
    const maxCol = width - 1
    const maxRow = height - 1
    let { col, row } = focus
    switch (move) {
      case 'left':
        if (col > 0) {
          col--
        } else if (row > 0) {
          col = maxCol
          row--
        }
        break
      case 'right':
        if (col < maxCol) {
          col++
        } else if (row < maxRow) {
          col = 0
          row++
        }
        break
      case 'up':
        if (row > 0) {
          row--
        }
        break
      case 'down':
        if (row < maxRow) {
          row++
        }
        break
      case 'lineStart':
        col = 0
        break
      case 'lineEnd':
        col = maxCol
        break
    }
    if (col === focus.col && row === focus.row) {
      return
    }
    moveFocus(this.selection, col, row)
    this.notifySelectionChange()
  }

  /** 是否存在活动文本选区。 */
  hasTextSelection(): boolean {
    return hasSelection(this.selection)
  }

  /**
   * 订阅选区状态变化。开始、更新、清除或复制选区时触发。
   * 返回 unsubscribe 函数。
   */
  subscribeToSelectionChange(cb: () => void): () => void {
    this.selectionListeners.add(cb)
    return () => this.selectionListeners.delete(cb)
  }
  private notifySelectionChange(): void {
    // 清除既有选区时，上一帧仍保存着 overlay 改写后的 styleId。
    // 局部 blit 防护无法覆盖所有终端 diff/滚动路径，因此只在这个
    // 状态转换上禁用一次 prevScreen 复用；拖拽期间仍保留增量渲染。
    if (this.prevOverlayRect && !hasSelection(this.selection)) {
      this.prevFrameContaminated = true
    }
    this.onRender()
    for (const cb of this.selectionListeners) {
      cb()
    }
  }

  /**
   * 修正 JediTerm 的鼠标列坐标。JediTerm 将宽字符计为 1 列，
   * 而屏幕缓冲区使用 2 单元格模型。通过扫描行中的宽字符数量来补偿偏移。
   * 非 JediTerm 终端直接返回原值（零成本）。
   */
  private correctCol(col: number, row: number): number {
    if (!this.isJetBrainsTerminal || col <= 0) {
      return col
    }
    return col + countWideCellsInRowBefore(this.frontFrame.screen, row, col)
  }

  /**
   * Hit-test the rendered DOM tree at (col, row) and bubble a ClickEvent
   * from the deepest hit node up through ancestors with onClick handlers.
   * Returns true if a DOM handler consumed the click. Gated on
   * altScreenActive — clicks only make sense with a fixed viewport where
   * nodeCache rects map 1:1 to terminal cells (no scrollback offset).
   */
  dispatchClick(col: number, row: number): boolean {
    if (!this.altScreenActive) {
      return false
    }
    col = this.correctCol(col, row)
    const blank = isEmptyCellAt(this.frontFrame.screen, col, row)
    return dispatchClick(this.rootNode, col, row, blank)
  }
  dispatchHover(col: number, row: number): void {
    if (!this.altScreenActive) {
      return
    }
    col = this.correctCol(col, row)
    // sticky 顶栏：行号命中区优先驱动 hover（不依赖 DOM hit-test）
    const zone = this.stickyHeaderZone
    if (zone?.setHover) {
      const inZone = row >= zone.y && row < zone.y + zone.height
      zone.setHover(inZone)
      if (inZone) {
        return
      }
    }
    dispatchHover(this.rootNode, col, row, this.hoveredNodes)
  }

  /** sticky 顶栏是否覆盖该屏幕行（0-based）。 */
  isStickyHeaderRow(row: number): boolean {
    const z = this.stickyHeaderZone
    return !!z && row >= z.y && row < z.y + z.height
  }

  /** 激活 sticky 顶栏跳转；成功返回 true。 */
  activateStickyHeader(): boolean {
    const z = this.stickyHeaderZone
    if (!z) {
      return false
    }
    z.scrollTo()
    return true
  }
  dispatchKeyboardEvent(parsedKey: ParsedKey): void {
    const target = this.focusManager.activeElement ?? this.rootNode
    const event = new KeyboardEvent(parsedKey)
    dispatcher.dispatchDiscrete(target, event)

    // Tab 循环是默认动作，仅在没有处理器调用 preventDefault() 时触发。
    // 与浏览器行为一致。
    if (!event.defaultPrevented && parsedKey.name === 'tab' && !parsedKey.ctrl && !parsedKey.meta) {
      if (parsedKey.shift) {
        this.focusManager.focusPrevious(this.rootNode)
      } else {
        this.focusManager.focusNext(this.rootNode)
      }
    }
  }
  /**
   * Look up the URL at (col, row) in the current front frame. Checks for
   * an OSC 8 hyperlink first, then falls back to scanning the row for a
   * plain-text URL (mouse tracking intercepts the terminal's native
   * Cmd+Click URL detection, so we replicate it). This is a pure lookup
   * with no side effects — call it synchronously at click time so the
   * result reflects the screen the user actually clicked on, then defer
   * the browser-open action via a timer.
   */
  getHyperlinkAt(col: number, row: number): string | undefined {
    if (!this.altScreenActive) {
      return undefined
    }
    col = this.correctCol(col, row)
    const screen = this.frontFrame.screen
    const cell = cellAt(screen, col, row)
    let url = cell?.hyperlink
    // SpacerTail cell（宽字符/CJK/Emoji 的右半部分）将 hyperlink 存在 col-1 的头部 cell 上。
    if (!url && cell?.width === CellWidth.SpacerTail && col > 0) {
      url = cellAt(screen, col - 1, row)?.hyperlink
    }
    return url ?? findPlainTextUrlAt(screen, col, row)
  }

  /**
   * Optional callback fired when clicking an OSC 8 hyperlink in fullscreen
   * mode. Set by FullscreenLayout via useLayoutEffect.
   */
  onHyperlinkClick: ((url: string) => void) | undefined

  /**
   * 双击让权钩子。仅当返回 true 时跳过默认选词。
   * 当前用途：顶部 sticky 用户消息条 → 滚回该条对话起始位置。
   * scrollback 内普通消息双击必须返回 false，保持选词。
   * 由 FullscreenLayout 通过 useLayoutEffect 挂载。
   */
  onDoubleClickAt: ((col: number, row: number) => boolean) | undefined

  /**
   * 顶部 sticky 用户消息条的屏幕命中区（0-based row）。
   * 不依赖 DOM hit-test：Windows Terminal / JetBrains 上 sticky 头
   * 常因布局缓存问题点不中；改用行号区域判定。
   * FullscreenLayout 在 sticky 显示时写入，隐藏时清空。
   */
  stickyHeaderZone: {
    y: number
    height: number
    scrollTo: () => void
    setHover?: (hover: boolean) => void
  } | null = null

  /**
   * Stable prototype wrapper for onHyperlinkClick. Passed to <App> as
   * onOpenHyperlink so the prop is a bound method (autoBind'd) that reads
   * the mutable field at call time — not the undefined-at-render value.
   */
  openHyperlink(url: string): void {
    this.onHyperlinkClick?.(url)
  }

  /**
   * 命中测试 DOM（屏幕坐标 0-based，会校正 JetBrains 宽字符）。
   * 供双击/删除选区时定位消息行。
   */
  hitTestAt(col: number, row: number): dom.DOMElement | null {
    if (!this.altScreenActive) {
      return null
    }
    col = this.correctCol(col, row)
    return hitTest(this.rootNode, col, row)
  }

  /**
   * 读取当前选区纯文本（不写剪贴板、不清选区）。
   */
  getSelectedText(): string {
    if (!hasSelection(this.selection)) {
      return ''
    }
    return getSelectedText(this.selection, this.frontFrame.screen)
  }

  /**
   * 处理 (col, row) 处的双击或三击：读取当前 screen buffer，选中光标下的 word 或 line。
   * 在 PRESS 而非 release 时调用，使高亮立即出现，拖动也能逐 word/line 扩展选区。
   * 点击落在 noSelect cell 上时，回退到 char 模式的 startSelection。
   *
   * 双击：业务 onDoubleClickAt 返回 true 时才让权（如 sticky 头部跳转）；
   * 返回 false/未挂载 → 默认选词。三击永不让权。
   */
  handleMultiClick(col: number, row: number, count: 2 | 3): void {
    if (!this.altScreenActive) {
      return
    }
    col = this.correctCol(col, row)

    // 仅 count===2 询问业务；false → 继续选词（含 scrollback 用户消息）
    if (count === 2 && this.onDoubleClickAt?.(col, row) === true) {
      clearSelection(this.selection)
      this.notifySelectionChange()
      return
    }

    const screen = this.frontFrame.screen
    // selectWordAt/selectLineAt no-op on noSelect/out-of-bounds. Seed with
    // a char-mode selection so the press still starts a drag even if the
    // word/line scan finds nothing selectable.
    startSelection(this.selection, col, row)
    if (count === 2) {
      selectWordAt(this.selection, screen, col, row)
    } else {
      selectLineAt(this.selection, screen, row)
    }
    // Ensure hasSelection is true so release doesn't re-dispatch onClickAt.
    // selectWordAt no-ops on noSelect; selectLineAt no-ops out-of-bounds.
    if (!this.selection.focus) {
      this.selection.focus = this.selection.anchor
    }
    this.notifySelectionChange()
  }

  /**
   * 处理 (col, row) 处的拖动。在 char 模式下将 focus 更新到准确 cell；
   * 在 word/line 模式下吸附到 word/line 边界，使选区像 macOS 原生行为一样逐单位扩展。
   * 与 dispatchClick 原因相同，受 altScreenActive 门控。
   */
  handleSelectionDrag(col: number, row: number): void {
    if (!this.altScreenActive) {
      return
    }
    col = this.correctCol(col, row)
    const sel = this.selection
    if (sel.anchorSpan) {
      extendSelection(sel, this.frontFrame.screen, col, row)
    } else {
      updateSelection(sel, col, row)
    }
    this.notifySelectionChange()
  }

  // 为外部 editor 正确暂停 stdin 的方法
  // 防止外部 editor 活跃时 Ink 吞掉按键
  private stdinListeners: Array<{
    event: string
    listener: (...args: unknown[]) => void
  }> = []
  private wasRawMode = false
  suspendStdin(): void {
    const stdin = this.options.stdin
    if (!stdin.isTTY) {
      return
    }

    // 暂存并移除所有 'readable' 事件监听器，防止 editor 活跃时 Ink 消费 stdin
    const readableListeners = stdin.listeners('readable')
    logForDebugging(
      `[stdin] suspendStdin: removing ${readableListeners.length} readable listener(s), wasRawMode=${
        (
          stdin as NodeJS.ReadStream & {
            isRaw?: boolean
          }
        ).isRaw ?? false
      }`,
    )
    readableListeners.forEach((listener) => {
      this.stdinListeners.push({
        event: 'readable',
        listener: listener as (...args: unknown[]) => void,
      })
      stdin.removeListener('readable', listener as (...args: unknown[]) => void)
    })

    // raw mode 已启用时暂时关闭
    const stdinWithRaw = stdin as NodeJS.ReadStream & {
      isRaw?: boolean
      setRawMode?: (mode: boolean) => void
    }
    if (stdinWithRaw.isRaw && stdinWithRaw.setRawMode) {
      stdinWithRaw.setRawMode(false)
      this.wasRawMode = true
    }
  }
  resumeStdin(): void {
    const stdin = this.options.stdin
    if (!stdin.isTTY) {
      return
    }

    // 重新挂载所有已保存的监听器
    if (this.stdinListeners.length === 0 && !this.wasRawMode) {
      logForDebugging(
        '[stdin] resumeStdin: called with no stored listeners and wasRawMode=false (possible desync)',
        {
          level: 'warn',
        },
      )
    }
    logForDebugging(
      `[stdin] resumeStdin: re-attaching ${this.stdinListeners.length} listener(s), wasRawMode=${this.wasRawMode}`,
    )
    this.stdinListeners.forEach(({ event, listener }) => {
      stdin.addListener(event, listener)
    })
    this.stdinListeners = []

    // 若 raw mode 之前已启用，则重新启用
    if (this.wasRawMode) {
      const stdinWithRaw = stdin as NodeJS.ReadStream & {
        setRawMode?: (mode: boolean) => void
      }
      if (stdinWithRaw.setRawMode) {
        stdinWithRaw.setRawMode(true)
      }
      this.wasRawMode = false
    }
  }

  // Stable identity for TerminalWriteContext. An inline arrow here would
  // change on every render() call (initial mount + each resize), which
  // cascades through useContext → <AlternateScreen>'s useLayoutEffect dep
  // array → spurious exit+re-enter of the alt screen on every SIGWINCH.
  private writeRaw(data: string): void {
    this.options.stdout.write(data)
  }
  private setCursorDeclaration: CursorDeclarationSetter = (decl, clearIfNode) => {
    if (
      decl === null &&
      clearIfNode !== undefined &&
      this.cursorDeclaration?.node !== clearIfNode
    ) {
      return
    }
    this.cursorDeclaration = decl
  }
  render(node: ReactNode): void {
    this.currentNode = node
    const tree = (
      <App
        stdin={this.options.stdin}
        stdout={this.options.stdout}
        stderr={this.options.stderr}
        exitOnCtrlC={this.options.exitOnCtrlC}
        onExit={this.unmount}
        terminalColumns={this.terminalColumns}
        terminalRows={this.terminalRows}
        selection={this.selection}
        onSelectionChange={this.notifySelectionChange}
        onClickAt={this.dispatchClick}
        onHoverAt={this.dispatchHover}
        getHyperlinkAt={this.getHyperlinkAt}
        onOpenHyperlink={this.openHyperlink}
        onMultiClick={this.handleMultiClick}
        onSelectionDrag={this.handleSelectionDrag}
        correctSelectionCol={(col, row) => this.correctCol(col, row)}
        onStdinResume={this.reassertTerminalModes}
        onCursorDeclaration={this.setCursorDeclaration}
        nativeCursor={this.options.nativeCursor === true}
        dispatchKeyboardEvent={this.dispatchKeyboardEvent}
      >
        <TerminalWriteProvider value={this.writeRaw}>{node}</TerminalWriteProvider>
      </App>
    )

    reconciler.updateContainerSync(tree, this.container, null, noop)
    reconciler.flushSyncWork()
  }
  unmount(error?: Error | number | null): void {
    if (this.isUnmounted) {
      return
    }
    this.onRender()
    this.unsubscribeExit()
    if (typeof this.restoreConsole === 'function') {
      this.restoreConsole()
    }
    this.restoreStderr?.()
    this.unsubscribeTTYHandlers?.()

    // 非 TTY 环境无法妥善处理擦除 ANSI escape，因此非静态输出最好只渲染最后一帧
    const diff = this.log.renderPreviousOutput_DEPRECATED(
      this.frontFrame,
      this.altScreenActive ? null : this.displayCursor,
    )
    writeDiffToTerminal(this.terminal, optimize(diff))
    this.displayCursor = null

    // Clean up terminal modes synchronously before process exit.
    // React's componentWillUnmount won't run in time when process.exit() is called,
    // so we must reset terminal modes here to prevent escape sequence leakage.
    // Use writeSync to stdout (fd 1) to ensure writes complete before exit.
    // We unconditionally send all disable sequences because terminal detection
    // may not work correctly (e.g., in tmux, screen) and these are no-ops on
    // terminals that don't support them.
    /* eslint-disable custom-rules/no-sync-fs -- process exiting; async writes would be dropped */
    if (this.options.stdout.isTTY) {
      if (this.altScreenActive && !isAlternateScreenDisabled()) {
        // <AlternateScreen>'s unmount effect won't run during signal-exit.
        // Exit alt screen FIRST so other cleanup sequences go to the main screen.
        writeSync(1, EXIT_ALT_SCREEN)
      }
      // Disable mouse tracking — unconditional because altScreenActive can be
      // stale if AlternateScreen's unmount (which flips the flag) raced a
      // blocked event loop + SIGINT. No-op if tracking was never enabled.
      writeSync(1, DISABLE_MOUSE_TRACKING)
      // Drain stdin so in-flight mouse events don't leak to the shell
      this.drainStdin()
      // Disable extended key reporting (both kitty and modifyOtherKeys)
      writeSync(1, DISABLE_MODIFY_OTHER_KEYS)
      writeSync(1, DISABLE_KITTY_KEYBOARD)
      // Disable focus events (DECSET 1004)
      writeSync(1, DFE)
      // Disable bracketed paste mode
      writeSync(1, DBP)
      // Show cursor
      writeSync(1, SHOW_CURSOR)
      // Clear iTerm2 progress bar
      writeSync(1, CLEAR_ITERM2_PROGRESS)
      // Clear tab status (OSC 21337) so a stale dot doesn't linger
      if (supportsTabStatus()) {
        writeSync(1, wrapForMultiplexer(CLEAR_TAB_STATUS))
      }
    }
    /* eslint-enable custom-rules/no-sync-fs */

    this.isUnmounted = true

    // 取消待执行的 throttled render，避免访问已释放的 Yoga 节点
    this.scheduleRender.cancel?.()
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer)
      this.drainTimer = null
    }

    reconciler.updateContainerSync(null, this.container, null, noop)
    reconciler.flushSyncWork()
    instances.delete(this.options.stdout)

    // Free the root yoga node, then clear its reference. Children are already
    // freed by the reconciler's removeChildFromContainer; using .free() (not
    // .freeRecursive()) avoids double-freeing them.
    this.rootNode.yogaNode?.free()
    this.rootNode.yogaNode = undefined
    if (error instanceof Error) {
      this.rejectExitPromise(error)
    } else {
      this.resolveExitPromise()
    }
  }
  async waitUntilExit(): Promise<void> {
    this.exitPromise ||= new Promise((resolve, reject) => {
      this.resolveExitPromise = resolve
      this.rejectExitPromise = reject
    })
    return this.exitPromise
  }
  resetLineCount(): void {
    if (this.options.stdout.isTTY) {
      // 交换 buffer，使旧 front 成为可复用的 back，再重置 front
      this.backFrame = this.frontFrame
      this.frontFrame = emptyFrame(
        this.frontFrame.viewport.height,
        this.frontFrame.viewport.width,
        this.stylePool,
        this.charPool,
        this.hyperlinkPool,
      )
      this.log.reset()
      // frontFrame is reset, so frame.cursor on the next render is (0,0).
      // Clear displayCursor so the preamble doesn't compute a stale delta.
      this.displayCursor = null
    }
  }

  /**
   * 用新实例替换 char/hyperlink pool，防止长会话中无限增长。
   * 将 front frame 的 screen ID 迁移到新 pool，保证 diff 正确。
   * back frame 无需迁移；resetScreen 会在读取前将其清零。
   *
   * 在对话轮次之间或定期调用。
   */
  resetPools(): void {
    this.charPool = new CharPool()
    this.hyperlinkPool = new HyperlinkPool()
    migrateScreenPools(this.frontFrame.screen, this.charPool, this.hyperlinkPool)
    // 只对 backFrame 缩容（frontFrame 内容是有效的前帧渲染结果，
    // 重建空 TypedArray 会丢失内容导致下一帧 blit 复制空单元格）。
    // backFrame 的 TypedArray 在下一帧会被 resetScreen 整缓冲归零，
    // 缩容安全且不丢失数据。
    shrinkScreenIfOversized(this.backFrame.screen)
    // back frame 的 pool ref 必须指向新 pool，使 renderer 将字符/hyperlink
    // intern 到与 front frame 相同的 pool 中。
    this.backFrame.screen.charPool = this.charPool
    this.backFrame.screen.hyperlinkPool = this.hyperlinkPool

    // StylePool：释放派生缓存（transitionCache 等），不修改 styles/ids。
    // styles[] 是 append-only 但线性增长（O(N)，典型 <1000 条目）；
    // transitionCache 是 O(N²)，是长会话内存增长的主因。
    // 定期清理缓存即可有效控制内存，且完全不涉及 ID 重映射——
    // 渲染器和屏幕缓冲区中的 style ID 始终有效。
    this.stylePool.clearCaches()

    if (isEnvTruthy(process.env.ZY_CODE_LIVE_COUNTS)) {
      const liveCount = collectLiveStyleIds(this.frontFrame.screen).size
      logForDebugging(
        `[LIVE_COUNTS] char=${this.charPool.poolSize()} hyperlink=${this.hyperlinkPool.poolSize()} style=${this.stylePool.poolSize()} styleLive=${liveCount}`,
      )
    }
  }
  patchConsole(): () => void {
    // biome-ignore lint/suspicious/noConsole: intentionally patching global console
    const con = console
    const originals: Partial<Record<keyof Console, Console[keyof Console]>> = {}
    // 降级为 verbose：console.log 只说明"有代码打了一行日志"，没有调用点
    // 信息，默认 debug 级别下只会淹没有用输出（第三方库的 console.log 也会
    // 被捕获）。需要排查时用 ZY_CODE_DEBUG_LOG_LEVEL=verbose 恢复。
    const toDebug = (...args: unknown[]) =>
      logForDebugging(`console.log: ${format(...args)}`, { level: 'verbose' })
    const toError = (...args: unknown[]) => logError(new Error(`console.error: ${format(...args)}`))
    for (const m of CONSOLE_STDOUT_METHODS) {
      originals[m] = con[m]
      con[m] = toDebug
    }
    for (const m of CONSOLE_STDERR_METHODS) {
      originals[m] = con[m]
      con[m] = toError
    }
    originals.assert = con.assert
    con.assert = (condition: unknown, ...args: unknown[]) => {
      if (!condition) {
        toError(...args)
      }
    }
    return () => Object.assign(con, originals)
  }

  /**
   * Intercept process.stderr.write so stray writes (config.ts, hooks.ts,
   * third-party deps) don't corrupt the alt-screen buffer. patchConsole only
   * hooks console.* methods — direct stderr writes bypass it, land at the
   * parked cursor, scroll the alt-screen, and desync frontFrame from the
   * physical terminal. Next diff writes only changed-in-React cells at
   * absolute coords → interleaved garbage.
   *
   * Swallows the write (routes text to the debug log) and, in alt-screen,
   * forces a full-damage repaint as a defensive recovery. Not patching
   * process.stdout — Ink itself writes there.
   */
  private patchStderr(): () => void {
    const stderr = process.stderr
    const originalWrite = stderr.write
    let reentered = false
    const intercept = (
      chunk: Uint8Array | string,
      encodingOrCb?: BufferEncoding | ((err?: Error) => void),
      cb?: (err?: Error) => void,
    ): boolean => {
      const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb
      // Reentrancy guard: logForDebugging → writeToStderr → here. Pass
      // through to the original so --debug-to-stderr still works and we
      // don't stack-overflow.
      if (reentered) {
        const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined
        return originalWrite.call(
          stderr,
          chunk,
          encoding,
          callback as ((err?: Error | null) => void) | undefined,
        )
      }
      reentered = true
      try {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
        logForDebugging(`[stderr] ${text}`, {
          level: 'warn',
        })
        if (this.altScreenActive && !this.isUnmounted && !this.isPaused) {
          this.prevFrameContaminated = true
          this.scheduleRender()
        }
      } finally {
        reentered = false
        callback?.()
      }
      return true
    }
    stderr.write = intercept
    return () => {
      if (stderr.write === intercept) {
        stderr.write = originalWrite
      }
    }
  }
}

/**
 * 丢弃待处理的 stdin 字节，避免正在传输的 escape sequence（鼠标跟踪报告、
 * bracketed-paste 标记）在退出后泄漏到 shell。
 *
 * 此处有两层复杂性：
 *
 * 1. setRawMode is termios, not fcntl — the stdin fd stays blocking, so
 *    readSync on it would hang forever. Node doesn't expose fcntl, so we
 *    open /dev/tty fresh with O_NONBLOCK (all fds to the controlling
 *    terminal share one line-discipline input queue).
 *
 * 2. By the time forceExit calls this, detachForShutdown has already put
 *    the TTY back in cooked (canonical) mode. Canonical mode line-buffers
 *    input until newline, so O_NONBLOCK reads return EAGAIN even when
 *    mouse bytes are sitting in the buffer. We briefly re-enter raw mode
 *    so reads return any available bytes, then restore cooked mode.
 *
 * 可安全地多次调用。应在退出路径中尽可能晚地调用：DISABLE_MOUSE_TRACKING
 * 存在终端往返延迟，写入后几毫秒内仍可能有事件到达。
 */
/* eslint-disable custom-rules/no-sync-fs -- must be sync; called from signal handler / unmount */
export function drainStdin(stdin: NodeJS.ReadStream = process.stdin): void {
  if (!stdin.isTTY) {
    return
  }
  // 排空 Node stream buffer（libuv 已读入的字节）。为空时 read() 返回 null，不会阻塞。
  try {
    while (stdin.read() !== null) {
      /* 丢弃 */
    }
  } catch {
    /* stream 可能已销毁 */
  }
  // Windows 没有 /dev/tty，CONIN$ 不支持 O_NONBLOCK 语义；
  // Windows Terminal 缓冲鼠标报告的方式也不同。
  if (process.platform === 'win32') {
    return
  }
  // termios 按设备生效：将 stdin 切为 raw，避免 canonical mode 的行缓冲
  // 对非阻塞读取隐藏部分输入；在 finally 块中恢复。
  const tty = stdin as NodeJS.ReadStream & {
    isRaw?: boolean
    setRawMode?: (raw: boolean) => void
  }
  const wasRaw = tty.isRaw === true
  // 通过新的 O_NONBLOCK fd 排空内核 TTY buffer。最多读取 64 次（64KB）；
  // 真实的鼠标事件突发只有几百字节，此上限用于防范忽略 O_NONBLOCK 的终端。
  let fd = -1
  try {
    // setRawMode inside try: on revoked TTY (SIGHUP/SSH disconnect) the
    // ioctl throws EBADF — same recovery path as openSync/readSync below.
    if (!wasRaw) {
      tty.setRawMode?.(true)
    }
    fd = openSync('/dev/tty', fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
    const buf = Buffer.alloc(1024)
    for (let i = 0; i < 64; i++) {
      if (readSync(fd, buf, 0, buf.length, null) <= 0) {
        break
      }
    }
  } catch {
    // EAGAIN（buffer 为空，符合预期）、ENXIO/ENOENT（没有 controlling tty）、
    // EBADF/EIO（TTY 被撤销，如 SIGHUP、SSH 断开）
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd)
      } catch {
        /* 忽略 */
      }
    }
    if (!wasRaw) {
      try {
        tty.setRawMode?.(false)
      } catch {
        /* TTY 可能已消失 */
      }
    }
  }
}
/* eslint-enable custom-rules/no-sync-fs */

const CONSOLE_STDOUT_METHODS = [
  'log',
  'info',
  'debug',
  'dir',
  'dirxml',
  'count',
  'countReset',
  'group',
  'groupCollapsed',
  'groupEnd',
  'table',
  'time',
  'timeEnd',
  'timeLog',
] as const
const CONSOLE_STDERR_METHODS = ['warn', 'error', 'trace'] as const
