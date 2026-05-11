import React, { PureComponent, type ReactNode } from 'react'
import { updateLastInteractionTime } from '../../bootstrap/state.js'
import { logForDebugging } from '../../utils/debug.js'
import { stopCapturingEarlyInput } from '../../utils/earlyInput.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isMouseClicksDisabled } from '../../utils/fullscreen.js'
import { logError } from '../../utils/log.js'
import { EventEmitter } from '../events/emitter.js'
import { InputEvent } from '../events/input-event.js'
import { TerminalFocusEvent } from '../events/terminal-focus-event.js'
import {
  INITIAL_STATE,
  type ParsedInput,
  type ParsedKey,
  type ParsedMouse,
  parseMultipleKeypresses,
} from '../parse-keypress.js'
import reconciler from '../reconciler.js'
import { finishSelection, hasSelection, type SelectionState, startSelection } from '../selection.js'
import { isXtermJs, setXtversionName, supportsExtendedKeys } from '../terminal.js'
import { getTerminalFocused, setTerminalFocused } from '../terminal-focus-state.js'
import { TerminalQuerier, xtversion } from '../terminal-querier.js'
import {
  DISABLE_KITTY_KEYBOARD,
  DISABLE_MODIFY_OTHER_KEYS,
  ENABLE_KITTY_KEYBOARD,
  ENABLE_MODIFY_OTHER_KEYS,
  FOCUS_IN,
  FOCUS_OUT,
} from '../termio/csi.js'
import {
  DBP,
  DFE,
  DISABLE_MOUSE_TRACKING,
  EBP,
  EFE,
  HIDE_CURSOR,
  SHOW_CURSOR,
} from '../termio/dec.js'
import AppContext from './AppContext.js'
import { ClockProvider } from './ClockContext.js'
import CursorDeclarationContext, {
  type CursorDeclarationSetter,
} from './CursorDeclarationContext.js'
import ErrorOverview from './ErrorOverview.js'
import StdinContext from './StdinContext.js'
import { TerminalFocusProvider } from './TerminalFocusContext.js'
import { TerminalSizeContext } from './TerminalSizeContext.js'

// 支持 Unix 风格进程暂停 (SIGSTOP/SIGCONT) 的平台
const SUPPORTS_SUSPEND = process.platform !== 'win32'

// 超过这个毫秒数的 stdin 静默后，下一个数据块将触发
// 终端模式重新声明（鼠标跟踪）。可捕获 tmux 分离→重新附加、
// ssh 重连、以及笔记本唤醒——终端会重置 DEC 私有模式，
// 但我们收不到任何信号。5s 远高于正常击键间隔，
// 但足够短，确保重新附加后的第一次滚动生效。
const STDIN_RESUME_GAP_MS = 5000
type Props = {
  readonly children: ReactNode
  readonly stdin: NodeJS.ReadStream
  readonly stdout: NodeJS.WriteStream
  readonly stderr: NodeJS.WriteStream
  readonly exitOnCtrlC: boolean
  readonly onExit: (error?: Error) => void
  readonly terminalColumns: number
  readonly terminalRows: number
  // 文本选择状态。App 直接在鼠标事件中修改此状态，
  // 并调用 onSelectionChange 触发重绘。鼠标事件仅在
  // <AlternateScreen>（或类似组件）启用鼠标跟踪时才会
  // 到达，因此处理程序始终已连接，但在跟踪开启前处于休眠状态。
  readonly selection: SelectionState
  readonly onSelectionChange: () => void
  // 在 (col, row) 处分发点击事件——对 DOM 树进行命中测试并冒泡
  // onClick 处理程序。如果 DOM 处理程序消耗了点击则返回 true。
  // 在全屏模式外为空操作（Ink.dispatchClick 会检查 altScreenActive）。
  readonly onClickAt: (col: number, row: number) => boolean
  // 当指针在 DOM 元素上移动时分发悬停事件（onMouseEnter/onMouseLeave）。
  // 在没有按住按钮的情况下为 mode-1003 移动事件调用。
  // 在全屏模式外为空操作（Ink.dispatchHover 会检查 altScreenActive）。
  readonly onHoverAt: (col: number, row: number) => void
  // 在点击时同步查找 (col, row) 处的 OSC 8 超链接。
  // 返回 URL 或 undefined。浏览器打开操作被延迟
  // MULTI_CLICK_TIMEOUT_MS 毫秒，以便双击可以取消它。
  readonly getHyperlinkAt: (col: number, row: number) => string | undefined
  // 在浏览器中打开超链接 URL。定时器触发时调用。
  readonly onOpenHyperlink: (url: string) => void
  // 在 (col, row) 处双击/三击按下时调用。count=2 选择
  // 光标下的单词；count=3 选择整行。Ink 读取屏幕缓冲区
  // 来查找单词/行边界并修改 selection，
  // 设置 isDragging=true 以便后续拖拽按单词/行扩展选择。
  readonly onMultiClick: (col: number, row: number, count: 2 | 3) => void
  // 拖拽移动时调用。具备模式感知：字符模式更新焦点到
  // 精确单元格；单词/行模式吸附到单词/行边界。需要
  // 访问屏幕缓冲区（单词边界）因此位于 Ink 上，而不是这里。
  readonly onSelectionDrag: (col: number, row: number) => void
  // stdin 数据到达后调用（在超过 STDIN_RESUME_GAP_MS 间隔之后）。
  // Ink 重新声明终端模式：扩展键报告，以及（全屏时）
  // 重新进入备用屏幕+鼠标跟踪。在终端侧是幂等的。
  // 可选的，因此 testing.tsx 不需要模拟它。
  readonly onStdinResume?: () => void
  // 接收来自 useDeclaredCursor 声明的原生光标位置，
  // 以便 ink.tsx 可以在每帧后将终端光标停在那里。
  // 在输入光标处启用 IME 组合，并让屏幕阅读器/
  // 放大镜跟踪输入。可选的，因此 testing.tsx 不模拟它。
  readonly onCursorDeclaration?: CursorDeclarationSetter
  // 通过 DOM 树分发键盘事件。每个解析后的键都会调用，
  // 与传统的 EventEmitter 路径并行。
  readonly dispatchKeyboardEvent: (parsedKey: ParsedKey) => void
}

// 多击检测阈值。500ms 是 macOS 默认值；小的
// 位置容差允许触控板在点击之间产生抖动。
const MULTI_CLICK_TIMEOUT_MS = 500
const MULTI_CLICK_DISTANCE = 1
type State = {
  readonly error?: Error
}

// Ink 应用的根组件
// 渲染 stdin 和 stdout 上下文，以便子组件在需要时可以访问它们
// 还处理 Ctrl+C 退出和光标可见性
export default class App extends PureComponent<Props, State> {
  static displayName = 'InternalApp'
  static getDerivedStateFromError(error: Error) {
    return {
      error,
    }
  }
  override state: State = {
    error: undefined,
  }

  // 统计有多少个组件启用了 raw 模式，以避免
  // 在所有组件都不再需要之前禁用 raw 模式
  rawModeEnabledCount = 0
  internal_eventEmitter = new EventEmitter()
  keyParseState = INITIAL_STATE
  // 不完整转义序列的刷新定时器
  incompleteEscapeTimer: NodeJS.Timeout | null = null
  // 不完整序列的超时时间（毫秒）
  readonly NORMAL_TIMEOUT = 50 // 常规转义序列的短超时
  readonly PASTE_TIMEOUT = 500 // 粘贴操作的较长超时

  // 终端查询/响应分发。响应通过 stdin 到达（由
  // parse-keypress 解析）并路由到待处理的 promise 解析器。
  querier = new TerminalQuerier(this.props.stdout)

  // 双击/三击文本选择的多击跟踪。在
  // MULTI_CLICK_TIMEOUT_MS 和 MULTI_CLICK_DISTANCE 范围内的点击会递增 clickCount；否则重置为 1。
  lastClickTime = 0
  lastClickCol = -1
  lastClickRow = -1
  clickCount = 0
  // 延迟的超链接打开定时器——如果在 MULTI_CLICK_TIMEOUT_MS 内
  // 有第二次点击则取消（这样双击超链接可以选择
  // 单词而不会同时打开浏览器）。DOM onClick 分发
  // 不会延迟——它从 onClickAt 返回 true 并跳过此定时器。
  pendingHyperlinkTimer: ReturnType<typeof setTimeout> | null = null
  // 最后 mode-1003 移动位置。终端已经对单元格粒度做了去重，
  // 但这也能让我们在重复事件时完全跳过 dispatchHover
  //（在同一单元格处拖拽后释放等）。
  lastHoverCol = -1
  lastHoverRow = -1

  // 最后一个 stdin 数据块的时间戳。用于检测长时间间隔（tmux 附加、
  // ssh 重连、笔记本唤醒）并触发终端模式重新声明。
  // 初始化为当前时间，因此启动时不会误触发。
  lastStdinTime = Date.now()

  // 判断提供的 stdin 是否支持 TTY
  isRawModeSupported(): boolean {
    return this.props.stdin.isTTY
  }
  override render() {
    return (
      <TerminalSizeContext.Provider
        value={{
          columns: this.props.terminalColumns,
          rows: this.props.terminalRows,
        }}
      >
        <AppContext.Provider
          value={{
            exit: this.handleExit,
          }}
        >
          <StdinContext.Provider
            value={{
              stdin: this.props.stdin,
              setRawMode: this.handleSetRawMode,
              isRawModeSupported: this.isRawModeSupported(),
              internal_exitOnCtrlC: this.props.exitOnCtrlC,
              internal_eventEmitter: this.internal_eventEmitter,
              internal_querier: this.querier,
            }}
          >
            <TerminalFocusProvider
              isTerminalFocused={false}
              terminalFocusState={'unfocused' as any}
            >
              <ClockProvider>
                <CursorDeclarationContext.Provider
                  value={this.props.onCursorDeclaration ?? (() => {})}
                >
                  {this.state.error ? (
                    <ErrorOverview error={this.state.error as Error} />
                  ) : (
                    this.props.children
                  )}
                </CursorDeclarationContext.Provider>
              </ClockProvider>
            </TerminalFocusProvider>
          </StdinContext.Provider>
        </AppContext.Provider>
      </TerminalSizeContext.Provider>
    )
  }
  override componentDidMount() {
    // 在辅助功能模式下，保持原生光标可见，供屏幕放大镜等工具使用
    if (this.props.stdout.isTTY && !isEnvTruthy(process.env.ZY_CODE_ACCESSIBILITY)) {
      this.props.stdout.write(HIDE_CURSOR)
    }
  }
  override componentWillUnmount() {
    if (this.props.stdout.isTTY) {
      this.props.stdout.write(SHOW_CURSOR)
    }

    // 清除任何待处理的定时器
    if (this.incompleteEscapeTimer) {
      clearTimeout(this.incompleteEscapeTimer)
      this.incompleteEscapeTimer = null
    }
    if (this.pendingHyperlinkTimer) {
      clearTimeout(this.pendingHyperlinkTimer)
      this.pendingHyperlinkTimer = null
    }
    // 避免在无法调用的 stdin 上调用 setRawMode
    if (this.isRawModeSupported()) {
      this.handleSetRawMode(false)
    }
  }
  override componentDidCatch(error: Error) {
    this.handleExit(error)
  }
  handleSetRawMode = (isEnabled: boolean): void => {
    const { stdin } = this.props
    if (!this.isRawModeSupported()) {
      if (stdin === process.stdin) {
        throw new Error(
          'Raw mode is not supported on the current process.stdin, which Ink uses as input stream by default.\nRead about how to prevent this error on https://github.com/vadimdemedes/ink/#israwmodesupported',
        )
      } else {
        throw new Error(
          'Raw mode is not supported on the stdin provided to Ink.\nRead about how to prevent this error on https://github.com/vadimdemedes/ink/#israwmodesupported',
        )
      }
    }
    stdin.setEncoding('utf8')
    if (isEnabled) {
      // 确保 raw 模式仅启用一次
      if (this.rawModeEnabledCount === 0) {
        // 在我们添加自己的 readable 处理程序之前，立即停止早期输入捕获。
        // 两者使用相同的 stdin 'readable' + read() 模式，因此它们不能
        // 共存——我们的处理程序会在 Ink 的处理程序之前排空 stdin。
        // 缓冲的文本通过 consumeEarlyInput() 保留给 REPL.tsx 使用。
        stopCapturingEarlyInput()
        stdin.ref()
        stdin.setRawMode(true)
        stdin.addListener('readable', this.handleReadable)
        // 启用括号粘贴模式
        this.props.stdout.write(EBP)
        // 启用终端焦点报告 (DECSET 1004)
        this.props.stdout.write(EFE)
        // 启用扩展键报告，使 ctrl+shift+<字母> 与
        // ctrl+<字母> 可区分。我们同时写入 kitty 栈
        // 推送 (CSI >1u) 和 xterm modifyOtherKeys 级别 2 (CSI >4;2m)——
        // 终端会实现它们支持的任何一个（tmux 只接受后者）。
        if (supportsExtendedKeys()) {
          this.props.stdout.write(ENABLE_KITTY_KEYBOARD)
          this.props.stdout.write(ENABLE_MODIFY_OTHER_KEYS)
        }
        // 探测终端身份。XTVERSION 能通过 SSH 存活（查询/回复走
        // pty），与 TERM_PROGRAM 不同。当环境变量缺失时用于
        // 滚轮滚动基础检测。发后不理：DA1
        // 哨兵边界化往返，如果终端忽略查询，
        // flush() 仍然会解析，名称保持 undefined。
        // 延迟到下一个 tick，以便它在当前同步
        // 初始化序列完成之后触发——避免与可能在同一渲染周期
        // 发生的备用屏幕/鼠标跟踪启用写入交错。
        setImmediate(() => {
          void Promise.all([this.querier.send(xtversion()), this.querier.flush()]).then(([r]) => {
            if (r) {
              setXtversionName(r.name)
              logForDebugging(`XTVERSION: terminal identified as "${r.name}"`)
            } else {
              logForDebugging('XTVERSION: no reply (terminal ignored query)')
            }
          })
        })
      }
      this.rawModeEnabledCount++
      return
    }

    // 仅在没有任何组件使用 raw 模式时才禁用
    if (--this.rawModeEnabledCount === 0) {
      this.props.stdout.write(DISABLE_MODIFY_OTHER_KEYS)
      this.props.stdout.write(DISABLE_KITTY_KEYBOARD)
      // 禁用终端焦点报告 (DECSET 1004)
      this.props.stdout.write(DFE)
      // 禁用括号粘贴模式
      this.props.stdout.write(DBP)
      stdin.setRawMode(false)
      stdin.removeListener('readable', this.handleReadable)
      stdin.unref()
    }
  }

  // 刷新不完整转义序列的辅助方法
  flushIncomplete = (): void => {
    // 清除定时器引用
    this.incompleteEscapeTimer = null

    // 仅在有不完整序列时继续
    if (!this.keyParseState.incomplete) return

    // 全屏模式：如果 stdin 有数据等待，几乎肯定是
    // 缓冲序列的后续部分（例如在独立 ESC 之后的 `[<64;74;16M`）。
    // Node 的事件循环在 poll 阶段之前运行 timers 阶段，因此当
    // 重度渲染阻塞事件循环超过 50ms 时，这个定时器
    // 会在排队的 readable 事件之前触发，即使字节已经缓冲。
    // 重新设置定时器而不是刷新：handleReadable 将
    // 排空 stdin 并清除此定时器。防止虚假的
    // Escape 键和丢失的滚动事件。
    if (this.props.stdin.readableLength > 0) {
      this.incompleteEscapeTimer = setTimeout(this.flushIncomplete, this.NORMAL_TIMEOUT)
      return
    }

    // 将不完整序列作为刷新操作处理 (input=null)
    // 复用所有现有的解析逻辑
    this.processInput(null)
  }

  // 通过解析器处理输入并处理结果
  processInput = (input: string | Buffer | null): void => {
    // 使用状态机解析输入
    const [keys, newState] = parseMultipleKeypresses(this.keyParseState, input)
    this.keyParseState = newState

    // 在单个 discreteUpdates 调用中处理所有键，以防止
    // "Maximum update depth exceeded" 错误，当一次大量键到达时
    //（例如，粘贴操作或快速按住键）。
    // 这会将 handleInput 的所有状态更新和所有 useInput
    // 监听器在一个高优先级更新上下文中批处理在一起。
    if (keys.length > 0) {
      reconciler.discreteUpdates(processKeysInBatch, this, keys, undefined, undefined)
    }

    // 如果有不完整的转义序列，设置定时器刷新它们
    if (this.keyParseState.incomplete) {
      // 先取消任何现有的定时器
      if (this.incompleteEscapeTimer) {
        clearTimeout(this.incompleteEscapeTimer)
      }
      this.incompleteEscapeTimer = setTimeout(
        this.flushIncomplete,
        this.keyParseState.mode === 'IN_PASTE' ? this.PASTE_TIMEOUT : this.NORMAL_TIMEOUT,
      )
    }
  }
  handleReadable = (): void => {
    // 检测长时间 stdin 间隔（tmux 附加、ssh 重连、笔记本唤醒）。
    // 终端可能已重置 DEC 私有模式；重新声明鼠标
    // 跟踪。在读取循环之前检查，这样一次 Date.now() 覆盖
    // 此 readable 事件中的所有数据块。
    const now = Date.now()
    if (now - this.lastStdinTime > STDIN_RESUME_GAP_MS) {
      this.props.onStdinResume?.()
    }
    this.lastStdinTime = now
    try {
      let chunk
      while ((chunk = this.props.stdin.read() as string | null) !== null) {
        // 处理输入数据块
        this.processInput(chunk)
      }
    } catch (error) {
      // 在 Bun 中，流 'readable' 处理程序中未捕获的抛出可能会
      // 永久阻塞流：数据保持缓冲且 'readable'
      // 不再发射。在此处捕获可确保流保持健康，以便
      // 后续击键仍然能够传递。
      logError(error)

      // 重新附加监听器，以防异常将其分离。
      // Bun 可能在错误后移除监听器；如果没有这一步，
      // 会话将永久冻结（stdin 读取器死亡，事件循环仍然存活）。
      const { stdin } = this.props
      if (
        this.rawModeEnabledCount > 0 &&
        !stdin.listeners('readable').includes(this.handleReadable)
      ) {
        logForDebugging(
          'handleReadable: re-attaching stdin readable listener after error recovery',
          {
            level: 'warn',
          },
        )
        stdin.addListener('readable', this.handleReadable)
      }
    }
  }
  handleInput = (input: string | undefined): void => {
    // 在 Ctrl+C 时退出
    if (input === '\x03' && this.props.exitOnCtrlC) {
      this.handleExit()
    }

    // 注意：Ctrl+Z（暂停）现在在 processKeysInBatch 中使用
    // 解析后的键来处理，以支持原始格式 (\x1a) 和
    // CSI u 格式（来自 Kitty 键盘协议终端：Ghostty、iTerm2、kitty、WezTerm）
  }
  handleExit = (error?: Error): void => {
    if (this.isRawModeSupported()) {
      this.handleSetRawMode(false)
    }
    this.props.onExit(error)
  }
  handleTerminalFocus = (isFocused: boolean): void => {
    // setTerminalFocused 通知订阅者：TerminalFocusProvider（上下文）
    // 和 Clock（间隔速度）——不需要 App setState。
    setTerminalFocused(isFocused)
  }
  handleSuspend = (): void => {
    if (!this.isRawModeSupported()) {
      return
    }

    // 存储暂停前的精确 raw 模式计数以便正确恢复
    const rawModeCountBeforeSuspend = this.rawModeEnabledCount

    // 在暂停前完全禁用 raw 模式
    while (this.rawModeEnabledCount > 0) {
      this.handleSetRawMode(false)
    }

    // 暂停前显示光标，禁用焦点报告和鼠标跟踪。
    // 如果未启用跟踪，DISABLE_MOUSE_TRACKING 为空操作，
    // 因此无条件发出是安全的——没有它，SGR 鼠标序列
    // 在暂停期间会在 shell 提示符下显示为乱码文本。
    if (this.props.stdout.isTTY) {
      this.props.stdout.write(SHOW_CURSOR + DFE + DISABLE_MOUSE_TRACKING)
    }

    // 为 ZY Code 发射暂停事件。主要用于通知
    this.internal_eventEmitter.emit('suspend')

    // 设置恢复处理程序
    const resumeHandler = () => {
      // 恢复 raw 模式到暂停前的精确状态
      for (let i = 0; i < rawModeCountBeforeSuspend; i++) {
        if (this.isRawModeSupported()) {
          this.handleSetRawMode(true)
        }
      }

      // 显示光标（除非处于辅助功能模式）并在恢复后重新启用焦点报告
      if (this.props.stdout.isTTY) {
        if (!isEnvTruthy(process.env.ZY_CODE_ACCESSIBILITY)) {
          this.props.stdout.write(HIDE_CURSOR)
        }
        // 重新启用焦点报告以恢复终端状态
        this.props.stdout.write(EFE)
      }

      // 为 ZY Code 发射恢复事件
      this.internal_eventEmitter.emit('resume')
      process.removeListener('SIGCONT', resumeHandler)
    }
    process.on('SIGCONT', resumeHandler)
    process.kill(process.pid, 'SIGSTOP')
  }
}

// 在单个离散更新上下文中处理所有键的辅助函数。
// discreteUpdates 期望 (fn, a, b, c, d) -> fn(a, b, c, d)
function processKeysInBatch(
  app: App,
  items: ParsedInput[],
  _unused1: undefined,
  _unused2: undefined,
): void {
  // 更新通知超时跟踪的交互时间。
  // 从中央输入处理程序调用，避免多个
  // stdin 监听器可能导致竞态条件和输入丢失。
  // 终端响应 (kind: 'response') 是自动的，不是用户输入。
  // mode-1003 无按钮移动也被排除——被动的光标漂移不
  // 算交互（会抑制空闲通知+延迟内务处理）。
  if (
    items.some(
      (i) =>
        i.kind === 'key' ||
        (i.kind === 'mouse' && !((i.button & 0x20) !== 0 && (i.button & 0x03) === 3)),
    )
  ) {
    updateLastInteractionTime()
  }
  for (const item of items) {
    // 终端响应（DECRPM、DA1、OSC 回复等）不是用户
    // 输入——将它们路由到 querier 以解析待处理的 promise。
    if (item.kind === 'response') {
      app.querier.onResponse(item.response)
      continue
    }

    // 鼠标点击/拖拽事件更新选择状态（仅全屏模式）。
    // 终端发送 1 索引的 col/row；转换为 0 索引用于
    // 屏幕缓冲区。按钮位 0x20 = 拖拽（按住按钮时移动）。
    if (item.kind === 'mouse') {
      handleMouseEvent(app, item)
      continue
    }
    const sequence = item.sequence

    // 处理终端焦点事件 (DECSET 1004)
    if (sequence === FOCUS_IN) {
      app.handleTerminalFocus(true)
      const event = new TerminalFocusEvent('terminalfocus')
      app.internal_eventEmitter.emit('terminalfocus', event)
      continue
    }
    if (sequence === FOCUS_OUT) {
      app.handleTerminalFocus(false)
      // 防御性：如果丢失了释放事件（在终端窗口外释放鼠标——
      // 某些模拟器没有捕获指针），焦点丢失是下一个可观察到的
      // 拖拽已结束的信号。没有这一步，拖拽滚动的定时器会运行
      // 直到触及滚动边界。
      if (app.props.selection.isDragging) {
        finishSelection(app.props.selection)
        app.props.onSelectionChange()
      }
      const event = new TerminalFocusEvent('terminalblur')
      app.internal_eventEmitter.emit('terminalblur', event)
      continue
    }

    // 安全保障：如果我们收到了输入，终端必须已聚焦
    if (!getTerminalFocused()) {
      setTerminalFocused(true)
    }

    // 处理 Ctrl+Z（暂停），使用解析后的键以支持原始格式 (\x1a) 和
    // CSI u 格式 (\x1b[122;5u)，来自 Kitty 键盘协议终端
    if (item.name === 'z' && item.ctrl && SUPPORTS_SUSPEND) {
      app.handleSuspend()
      continue
    }
    app.handleInput(sequence)
    const event = new InputEvent(item)
    app.internal_eventEmitter.emit('input', event)

    // 同时通过 DOM 树分发，使 onKeyDown 处理程序也能触发
    app.props.dispatchKeyboardEvent(item)
  }
}

/** 导出用于测试。修改 app.props.selection 和点击/悬停状态。 */
export function handleMouseEvent(app: App, m: ParsedMouse): void {
  // 允许禁用点击处理，同时保持滚轮滚动（滚轮通过
  // 键绑定系统作为 'wheelup'/'wheeldown' 传递，不走这里）。
  if (isMouseClicksDisabled()) return
  const sel = app.props.selection
  // 终端坐标是 1 索引的；屏幕缓冲区是 0 索引的
  const col = m.col - 1
  const row = m.row - 1
  const baseButton = m.button & 0x03
  if (m.action === 'press') {
    if ((m.button & 0x20) !== 0 && baseButton === 3) {
      // mode-1003 没有按住按钮的移动。分发悬停事件；跳过
      // 此处理程序的其余部分（无选择、无点击计数副作用）。
      // 丢失释放的恢复：isDragging=true 时的无按钮移动意味着
      // 释放发生在终端窗口之外（iTerm2 不
      // 将指针捕获到窗口边界之外，因此 SGR 'm' 永远
      // 不会到达）。在这里完成选择，使复制-选择触发。
      // FOCUS_OUT 处理程序覆盖"切换应用"的情况，但不覆盖"在边缘
      // 释放后回来"——tmux 会丢弃焦点事件，除非
      // 设置了 `focus-events on`，所以这是更可靠的信号。
      if (sel.isDragging) {
        finishSelection(sel)
        app.props.onSelectionChange()
      }
      if (col === app.lastHoverCol && row === app.lastHoverRow) return
      app.lastHoverCol = col
      app.lastHoverRow = row
      app.props.onHoverAt(col, row)
      return
    }
    if (baseButton !== 0) {
      // 非左键按下中断多击链。
      app.clickCount = 0
      return
    }
    if ((m.button & 0x20) !== 0) {
      // 拖拽移动：模式感知扩展（字符/单词/行）。onSelectionDrag
      // 在内部调用 notifySelectionChange——无需额外的 onSelectionChange。
      app.props.onSelectionDrag(col, row)
      return
    }
    // mode-1002 终端的丢失释放回退：isDragging=true 时的新
    // 按下意味着之前的释放被丢弃（光标离开了窗口）。
    // 完成该选择，使复制-选择触发，然后再被
    // startSelection/onMultiClick 覆盖。mode-1003 终端
    // 会走上面的无按钮移动恢复路径，所以这种情况很罕见。
    if (sel.isDragging) {
      finishSelection(sel)
      app.props.onSelectionChange()
    }
    // 新的左键按下。在这里检测多击（而不是在释放时），
    // 这样单词/行高亮会立即出现，且随后的拖拽可以
    // 像原生 macOS 一样按单词/行扩展。之前在
    // 释放时检测，这意味着 (a) 单词高亮前有可见延迟
    // 和 (b) 双击+拖拽会退化为字符模式选择。
    const now = Date.now()
    const nearLast =
      now - app.lastClickTime < MULTI_CLICK_TIMEOUT_MS &&
      Math.abs(col - app.lastClickCol) <= MULTI_CLICK_DISTANCE &&
      Math.abs(row - app.lastClickRow) <= MULTI_CLICK_DISTANCE
    app.clickCount = nearLast ? app.clickCount + 1 : 1
    app.lastClickTime = now
    app.lastClickCol = col
    app.lastClickRow = row
    if (app.clickCount >= 2) {
      // 取消第一次点击的待处理超链接打开——这是
      // 双击，不是链接上的单击。
      if (app.pendingHyperlinkTimer) {
        clearTimeout(app.pendingHyperlinkTimer)
        app.pendingHyperlinkTimer = null
      }
      // 限制最多为 3（行选择）用于四次及以上点击。
      const count = app.clickCount === 2 ? 2 : 3
      app.props.onMultiClick(col, row, count)
      return
    }
    startSelection(sel, col, row)
    // SGR 位 0x08 = alt（xterm.js 在这里连接 altKey，而不是 metaKey——见
    // 下方超链接打开守卫处的注释）。在 macOS xterm.js 上，
    // 收到 alt 意味着 macOptionClickForcesSelection 已关闭（否则
    // xterm.js 会消耗事件用于原生选择）。
    sel.lastPressHadAlt = (m.button & 0x08) !== 0
    app.props.onSelectionChange()
    return
  }

  // 释放：即使是非零按钮代码也要结束拖拽。某些终端
  // 用移动位或 button=3 "无按钮" 编码释放（继承
  // 自 SGR 之前的 X10 编码）——过滤这些会导致
  // isDragging=true 孤立，使拖拽滚动的定时器运行直到
  // 滚动边界。仅在我们正在拖拽时对非左释放执行操作
  //（这样不相关的中键/右键释放不会影响选择）。
  if (baseButton !== 0) {
    if (!sel.isDragging) return
    finishSelection(sel)
    app.props.onSelectionChange()
    return
  }
  finishSelection(sel)
  // 注意：与旧的基于释放的检测不同，我们不会在拖拽后
  // 的释放时重置 clickCount。这符合 NSEvent.clickCount 语义：
  // 中间的拖拽不会中断点击链。实际好处：
  // 预期双击（按下→抖动→释放→按下）期间的触控板抖动
  // 现在能正确解析为单词选择，而不是断开为新的单击。
  // nearLast 窗口（500ms，1 个单元格）限制了效果范围——
  // 超出该范围的有意拖拽只会开始新的链。
  // 字符模式下无拖拽的按下+释放是单击：设置锚点，
  // 焦点为空 → hasSelection 为 false。在单词/行模式下，按下已经
  // 设置了锚点+焦点（hasSelection 为 true），所以释放只保持高亮。
  // 锚点检查防止孤立的释放（没有之前的按下——例如
  // 启用鼠标跟踪时按钮被按住）。
  if (!hasSelection(sel) && sel.anchor) {
    // 单击：立即分发 DOM 点击（光标重新定位
    // 等对延迟敏感）。如果没有 DOM 处理程序消耗它，
    // 延迟超链接检查，使第二次点击可以取消它。
    if (!app.props.onClickAt(col, row)) {
      // 在屏幕缓冲区仍反映用户点击内容时同步解析超链接 URL——
      // 仅延迟浏览器打开，使双击可以取消它。
      const url = app.props.getHyperlinkAt(col, row)
      // xterm.js（VS Code、Cursor、Windsurf 等）有自己的 OSC 8 链接
      // 处理程序，在 Cmd+点击时触发*不消耗鼠标事件*
      //（Linkifier._handleMouseUp 调用 link.activate() 但从不
      // preventDefault/stopPropagation）。点击也会作为 SGR 转发到
      // pty，因此 VS Code 的 terminalLinkManager 和我们的处理程序
      // 都会打开 URL——两次。我们不能按 Cmd 过滤：xterm.js
      // 在 SGR 编码之前丢弃 metaKey（ICoreMouseEvent 没有 meta
      // 字段；我们称为 'meta' 的 SGR 位连接到 alt）。让 xterm.js
      // 处理链接打开；Cmd+点击在那里的原生体验就是这样。
      // TERM_PROGRAM 是同步快速路径；isXtermJs() 是 XTVERSION
      // 探测结果（捕获 SSH + 非 VS Code 嵌入者如 Hyper）。
      if (url && process.env.TERM_PROGRAM !== 'vscode' && !isXtermJs()) {
        // 清除任何先前的待处理定时器——点击第二个链接会
        // 取代第一个（只有最新的点击才会打开）。
        if (app.pendingHyperlinkTimer) {
          clearTimeout(app.pendingHyperlinkTimer)
        }
        app.pendingHyperlinkTimer = setTimeout(
          (app, url) => {
            app.pendingHyperlinkTimer = null
            app.props.onOpenHyperlink(url)
          },
          MULTI_CLICK_TIMEOUT_MS,
          app,
          url,
        )
      }
    }
  }
  app.props.onSelectionChange()
}
