/**
 * 键盘输入解析器 - 将终端输入转换为按键事件
 *
 * 使用 termio 分词器进行转义序列边界检测，
 * 然后将序列解析为按键事件。
 */
import { Buffer } from 'node:buffer'
import { PASTE_END, PASTE_START } from './termio/csi.js'
import { createTokenizer, type Tokenizer } from './termio/tokenize.js'

// eslint-disable-next-line no-control-regex
const META_KEY_CODE_RE = /^(?:\x1b)([a-zA-Z0-9])$/

// eslint-disable-next-line no-control-regex
const FN_KEY_RE =
  // eslint-disable-next-line no-control-regex
  /^(?:\x1b+)(O|N|\[|\[\[)(?:(\d+)(?:;(\d+))?([~^$])|(?:1;)?(\d+)?([a-zA-Z]))/

// CSI u（kitty 键盘协议）：ESC [ 码点 [; 修饰键] u
// 例如：ESC[13;2u = Shift+Enter，ESC[27u = Escape（无修饰键）
// 修饰键为可选 — 不存在时默认为 1（无修饰键）
// eslint-disable-next-line no-control-regex
const CSI_U_RE = /^\x1b\[(\d+)(?:;(\d+))?u/

// xterm modifyOtherKeys：ESC [ 27 ; 修饰键 ; 键码 ~
// 例如：ESC[27;2;13~ = Shift+Enter。由 Ghostty/tmux/xterm 在
// modifyOtherKeys=2 激活时或通过用户按键绑定发出，通常在 SSH 环境下使用，
// 因为 TERM 探测无法识别 Ghostty，我们也从未推送 Kitty 键盘模式。
// 注意参数顺序与 CSI u 相反（修饰键在前，键码在后）。
// eslint-disable-next-line no-control-regex
const MODIFY_OTHER_KEYS_RE = /^\x1b\[27;(\d+);(\d+)~/

// -- 终端响应序列（来自终端本身的入站序列） --
// DECRPM: CSI ? Ps ; Pm $ y  — 对 DECRQM（请求模式）的响应
// eslint-disable-next-line no-control-regex
const DECRPM_RE = /^\x1b\[\?(\d+);(\d+)\$y$/
// DA1: CSI ? Ps ; ... c  — 主设备属性响应
// eslint-disable-next-line no-control-regex
const DA1_RE = /^\x1b\[\?([\d;]*)c$/
// DA2: CSI > Ps ; ... c  — 次设备属性响应
// eslint-disable-next-line no-control-regex
const DA2_RE = /^\x1b\[>([\d;]*)c$/
// Kitty 键盘标志位：CSI ? flags u  — 对 CSI ? u 查询的响应
// （私有 ? 标记用于与 CSI u 按键事件区分）
// eslint-disable-next-line no-control-regex
const KITTY_FLAGS_RE = /^\x1b\[\?(\d+)u$/
// DECXCPR 光标位置：CSI ? row ; col R
// ? 标记用于与修饰过的 F3 键区分（Shift+F3 = CSI 1;2 R，
// Ctrl+F3 = CSI 1;5 R 等）— 普通的 CSI row;col R 确实存在歧义。
// eslint-disable-next-line no-control-regex
const CURSOR_POSITION_RE = /^\x1b\[\?(\d+);(\d+)R$/
// OSC 响应：OSC 代码 ; 数据 (BEL|ST)
// eslint-disable-next-line no-control-regex
const OSC_RESPONSE_RE = /^\x1b\](\d+);(.*?)(?:\x07|\x1b\\)$/s
// XTVERSION：DCS > | 名称 ST  — 终端名称/版本字符串（对 CSI > 0 q 的响应）。
// xterm.js 返回 "xterm.js(X.Y.Z)"；Ghostty、kitty、iTerm2 等返回各自的名称。
// 与 TERM_PROGRAM 不同，该信息在 SSH 环境下依然有效，因为查询/响应
// 走的是 pty，而非环境变量。
// eslint-disable-next-line no-control-regex
const XTVERSION_RE = /^\x1bP>\|(.*?)(?:\x07|\x1b\\)$/s
// SGR 鼠标事件：CSI < 按钮 ; 列 ; 行 M（按下）或 m（释放）
// 按钮编码：64=滚轮上，65=滚轮下（0x40 | 滚轮位）。
// 按钮 32=左键拖拽（0x20 | 移动位）。普通 0/1/2 = 左/中/右键点击。
// eslint-disable-next-line no-control-regex
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/

function createPasteKey(content: string): ParsedKey {
  return {
    kind: 'key',
    name: '',
    fn: false,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: content,
    raw: content,
    isPasted: true,
  }
}

/** DECRPM 状态值（对 DECRQM 的响应） */
export const DECRPM_STATUS = {
  NOT_RECOGNIZED: 0,
  SET: 1,
  RESET: 2,
  PERMANENTLY_SET: 3,
  PERMANENTLY_RESET: 4,
} as const

/**
 * 从终端接收到的响应序列（非按键事件）。
 * 用于回答 DECRQM、DA1、OSC 11 等查询。
 */
export type TerminalResponse =
  /** DECRPM：对 DECRQM（请求 DEC 私有模式状态）的应答 */
  | { type: 'decrpm'; mode: number; status: number }
  /** DA1：主设备属性（用作通用哨兵） */
  | { type: 'da1'; params: number[] }
  /** DA2：次设备属性（终端版本信息） */
  | { type: 'da2'; params: number[] }
  /** Kitty 键盘协议：当前标志位（对 CSI ? u 的应答） */
  | { type: 'kittyKeyboard'; flags: number }
  /** DSR：光标位置报告（对 CSI 6 n 的应答） */
  | { type: 'cursorPosition'; row: number; col: number }
  /** OSC 响应：通用操作系统命令应答（例如 OSC 11 背景色） */
  | { type: 'osc'; code: number; data: string }
  /** XTVERSION：终端名称/版本字符串（对 CSI > 0 q 的应答）。
   *  示例值："xterm.js(5.5.0)"、"ghostty 1.2.0"、"iTerm2 3.6"。 */
  | { type: 'xtversion'; name: string }

/**
 * 尝试将序列标记识别为终端响应。
 * 如果不是已知的响应模式则返回 null
 * （即应作为按键事件处理）。
 *
 * 这些模式在语法上与键盘输入可区分 —
 * 没有物理按键能产生 CSI ? ... c 或 CSI ? ... $ y，因此可以
 * 在任何时候安全地从输入流中解析出来。
 */
function parseTerminalResponse(s: string): TerminalResponse | null {
  // CSI 前缀响应
  if (s.startsWith('\x1b[')) {
    let m: RegExpExecArray | null

    if ((m = DECRPM_RE.exec(s))) {
      return {
        type: 'decrpm',
        mode: parseInt(m[1]!, 10),
        status: parseInt(m[2]!, 10),
      }
    }

    if ((m = DA1_RE.exec(s))) {
      return { type: 'da1', params: splitNumericParams(m[1]!) }
    }

    if ((m = DA2_RE.exec(s))) {
      return { type: 'da2', params: splitNumericParams(m[1]!) }
    }

    if ((m = KITTY_FLAGS_RE.exec(s))) {
      return { type: 'kittyKeyboard', flags: parseInt(m[1]!, 10) }
    }

    if ((m = CURSOR_POSITION_RE.exec(s))) {
      return {
        type: 'cursorPosition',
        row: parseInt(m[1]!, 10),
        col: parseInt(m[2]!, 10),
      }
    }

    return null
  }

  // OSC 响应（例如 OSC 11 ; rgb:... 用于背景色查询）
  if (s.startsWith('\x1b]')) {
    const m = OSC_RESPONSE_RE.exec(s)
    if (m) {
      return { type: 'osc', code: parseInt(m[1]!, 10), data: m[2]! }
    }
  }

  // DCS 响应（例如 XTVERSION: DCS > | name ST）
  if (s.startsWith('\x1bP')) {
    const m = XTVERSION_RE.exec(s)
    if (m) {
      return { type: 'xtversion', name: m[1]! }
    }
  }

  return null
}

function splitNumericParams(params: string): number[] {
  if (!params) {
    return []
  }
  return params.split(';').map((p) => parseInt(p, 10))
}

export type KeyParseState = {
  mode: 'NORMAL' | 'IN_PASTE'
  incomplete: string
  pasteBuffer: string
  // 内部分词器实例
  _tokenizer?: Tokenizer
}

export const INITIAL_STATE: KeyParseState = {
  mode: 'NORMAL',
  incomplete: '',
  pasteBuffer: '',
}

function inputToString(input: Buffer | string): string {
  if (Buffer.isBuffer(input)) {
    if (input[0]! > 127 && input[1] === undefined) {
      ;(input[0] as unknown as number) -= 128
      return `\x1b${String(input)}`
    } else {
      return String(input)
    }
  } else if (input !== undefined && typeof input !== 'string') {
    return String(input)
  } else if (!input) {
    return ''
  } else {
    return input
  }
}

export function parseMultipleKeypresses(
  prevState: KeyParseState,
  input: Buffer | string | null = '',
): [ParsedInput[], KeyParseState] {
  const isFlush = input === null
  const inputString = isFlush ? '' : inputToString(input)

  // 获取或创建分词器
  const tokenizer = prevState._tokenizer ?? createTokenizer({ x10Mouse: true })

  // 对输入进行分词
  const tokens = isFlush ? tokenizer.flush() : tokenizer.feed(inputString)

  // 将标记转换为解析后的按键事件，处理粘贴模式
  const keys: ParsedInput[] = []
  let inPaste = prevState.mode === 'IN_PASTE'
  let pasteBuffer = prevState.pasteBuffer

  for (const token of tokens) {
    if (token.type === 'sequence') {
      if (token.value === PASTE_START) {
        inPaste = true
        pasteBuffer = ''
      } else if (token.value === PASTE_END) {
        // 始终发送粘贴事件，即使是空粘贴。这允许下游处理器
        // 检测空粘贴（例如 macOS 上的剪贴板图片处理）。
        // 粘贴内容可能为空字符串。
        keys.push(createPasteKey(pasteBuffer))
        inPaste = false
        pasteBuffer = ''
      } else if (inPaste) {
        // 粘贴模式内的序列被视为纯文本
        pasteBuffer += token.value
      } else {
        const response = parseTerminalResponse(token.value)
        if (response) {
          keys.push({ kind: 'response', sequence: token.value, response })
        } else {
          const mouse = parseMouseEvent(token.value)
          if (mouse) {
            keys.push(mouse)
          } else {
            keys.push(parseKeypress(token.value))
          }
        }
      }
    } else if (token.type === 'text') {
      if (inPaste) {
        pasteBuffer += token.value
      } else if (
        /^\[<\d+;\d+;\d+[Mm]$/.test(token.value) ||
        /^\[M[\x60-\x7f][\x20-\uffff]{2}$/.test(token.value)
      ) {
        // 孤立的 SGR/X10 鼠标尾部（仅限全屏模式 — 否则鼠标跟踪已关闭）。
        // 繁重的渲染阻塞了事件循环，超过 App 的 50ms 刷新定时器，
        // 导致缓冲的 ESC 被作为单独的 Escape 刷新，而后续部分
        // `[<btn;col;rowM` 作为文本到达。重新添加 ESC 前缀进行合成，
        // 使滚动事件仍能触发，而不是泄漏到提示符中。虚假的 Escape
        // 已消失；App.tsx 的 readableLength 检查可防止此问题。
        // X10 Cb 槽位被收窄到滚轮范围 [\x60-\x7f]（0x40|修饰键 + 32）—
        // 完整的 [\x20-] 范围会匹配像 `[MAX]` 这样批量读取的输入，
        // 并将其作为幻影点击静默丢弃。点击/拖拽的孤立事件会以可见
        // 垃圾形式泄漏；可删除的垃圾优于静默丢失。
        const resynthesized = `\x1b${token.value}`
        const mouse = parseMouseEvent(resynthesized)
        keys.push(mouse ?? parseKeypress(resynthesized))
      } else {
        keys.push(parseKeypress(token.value))
      }
    }
  }

  // 如果正在刷新且仍处于粘贴模式，发出已缓存的内容
  if (isFlush && inPaste && pasteBuffer) {
    keys.push(createPasteKey(pasteBuffer))
    inPaste = false
    pasteBuffer = ''
  }

  // 构建新状态
  const newState: KeyParseState = {
    mode: inPaste ? 'IN_PASTE' : 'NORMAL',
    incomplete: tokenizer.buffer(),
    pasteBuffer,
    _tokenizer: tokenizer,
  }

  return [keys, newState]
}

const keyName: Record<string, string> = {
  /* xterm/gnome ESC O 字母 */
  OP: 'f1',
  OQ: 'f2',
  OR: 'f3',
  OS: 'f4',
  /* 应用小键盘模式（数字键 0-9） */
  Op: '0',
  Oq: '1',
  Or: '2',
  Os: '3',
  Ot: '4',
  Ou: '5',
  Ov: '6',
  Ow: '7',
  Ox: '8',
  Oy: '9',
  /* 应用小键盘模式（运算符） */
  Oj: '*',
  Ok: '+',
  Ol: ',',
  Om: '-',
  On: '.',
  Oo: '/',
  OM: 'return',
  /* xterm/rxvt ESC [ 数字 ~ */
  '[11~': 'f1',
  '[12~': 'f2',
  '[13~': 'f3',
  '[14~': 'f4',
  /* 来自 Cygwin，libuv 中使用 */
  '[[A': 'f1',
  '[[B': 'f2',
  '[[C': 'f3',
  '[[D': 'f4',
  '[[E': 'f5',
  /* 常见 */
  '[15~': 'f5',
  '[17~': 'f6',
  '[18~': 'f7',
  '[19~': 'f8',
  '[20~': 'f9',
  '[21~': 'f10',
  '[23~': 'f11',
  '[24~': 'f12',
  /* xterm ESC [ 字母 */
  '[A': 'up',
  '[B': 'down',
  '[C': 'right',
  '[D': 'left',
  '[E': 'clear',
  '[F': 'end',
  '[H': 'home',
  /* xterm/gnome ESC O 字母 */
  OA: 'up',
  OB: 'down',
  OC: 'right',
  OD: 'left',
  OE: 'clear',
  OF: 'end',
  OH: 'home',
  /* xterm/rxvt ESC [ 数字 ~ */
  '[1~': 'home',
  '[2~': 'insert',
  '[3~': 'delete',
  '[4~': 'end',
  '[5~': 'pageup',
  '[6~': 'pagedown',
  /* putty */
  '[[5~': 'pageup',
  '[[6~': 'pagedown',
  /* rxvt */
  '[7~': 'home',
  '[8~': 'end',
  /* rxvt 带修饰键的按键 */
  '[a': 'up',
  '[b': 'down',
  '[c': 'right',
  '[d': 'left',
  '[e': 'clear',

  '[2$': 'insert',
  '[3$': 'delete',
  '[5$': 'pageup',
  '[6$': 'pagedown',
  '[7$': 'home',
  '[8$': 'end',

  Oa: 'up',
  Ob: 'down',
  Oc: 'right',
  Od: 'left',
  Oe: 'clear',

  '[2^': 'insert',
  '[3^': 'delete',
  '[5^': 'pageup',
  '[6^': 'pagedown',
  '[7^': 'home',
  '[8^': 'end',
  /* 杂项 */
  '[Z': 'tab',
}

export const nonAlphanumericKeys = [
  // 过滤掉单字符值（来自小键盘的数字、运算符），因为
  // 这些是可打印字符，应该产生输入
  ...Object.values(keyName).filter((v) => v.length > 1),
  // escape 和 backspace 直接在 parseKeypress 中赋值（不通过
  // keyName 映射），所以上面的展开会漏掉它们。如果不加这两个，
  // 通过 Kitty/modifyOtherKeys 的 ctrl+escape 会把字面量单词
  // "escape" 泄漏为输入文本（input-event.ts:58 在设置 ctrl 时
  // 会分配 keypress.name）。
  'escape',
  'backspace',
  'wheelup',
  'wheeldown',
  'mouse',
]

const isShiftKey = (code: string): boolean => {
  return ['[a', '[b', '[c', '[d', '[e', '[2$', '[3$', '[5$', '[6$', '[7$', '[8$', '[Z'].includes(
    code,
  )
}

const isCtrlKey = (code: string): boolean => {
  return ['Oa', 'Ob', 'Oc', 'Od', 'Oe', '[2^', '[3^', '[5^', '[6^', '[7^', '[8^'].includes(code)
}

/**
 * 将 XTerm 风格的修饰键值解码为独立标志位。
 * 修饰键编码：1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0) + (super ? 8 : 0)
 *
 * 注意：此处的 `meta` 指 Alt/Option（第 2 位）。`super` 是一个独立的
 * 修饰键（第 8 位，即 macOS 上的 Cmd / Win 键）。大多数遗留终端
 * 序列无法表达 super — 它只能通过 kitty 键盘协议
 *（CSI u）或 xterm modifyOtherKeys 传入。
 */
function decodeModifier(modifier: number): {
  shift: boolean
  meta: boolean
  ctrl: boolean
  super: boolean
} {
  const m = modifier - 1
  return {
    shift: !!(m & 1),
    meta: !!(m & 2),
    ctrl: !!(m & 4),
    super: !!(m & 8),
  }
}

/**
 * 将键码映射为键名，用于 modifyOtherKeys/CSI u 序列。
 * 同时处理 ASCII 键码和 Kitty 键盘协议功能键。
 *
 * 小键盘码点来自 Unicode 私有使用区，定义见：
 * https://sw.kovidgoyal.net/kitty/keyboard-protocol/#functional-key-definitions
 */
function keycodeToName(keycode: number): string | undefined {
  switch (keycode) {
    case 9:
      return 'tab'
    case 13:
      return 'return'
    case 27:
      return 'escape'
    case 32:
      return 'space'
    case 127:
      return 'backspace'
    // Kitty keyboard protocol 的数字小键盘按键（KP_0 到 KP_9）
    case 57399:
      return '0'
    case 57400:
      return '1'
    case 57401:
      return '2'
    case 57402:
      return '3'
    case 57403:
      return '4'
    case 57404:
      return '5'
    case 57405:
      return '6'
    case 57406:
      return '7'
    case 57407:
      return '8'
    case 57408:
      return '9'
    case 57409: // KP_DECIMAL（小数点）
      return '.'
    case 57410: // KP_DIVIDE（除号）
      return '/'
    case 57411: // KP_MULTIPLY（乘号）
      return '*'
    case 57412: // KP_SUBTRACT（减号）
      return '-'
    case 57413: // KP_ADD（加号）
      return '+'
    case 57414: // KP_ENTER（回车）
      return 'return'
    case 57415: // KP_EQUAL（等号）
      return '='
    default:
      // 可打印 ASCII 字符
      if (keycode >= 32 && keycode <= 126) {
        return String.fromCharCode(keycode).toLowerCase()
      }
      return undefined
  }
}

export type ParsedKey = {
  kind: 'key'
  fn: boolean
  name: string | undefined
  ctrl: boolean
  meta: boolean
  shift: boolean
  option: boolean
  super: boolean
  sequence: string | undefined
  raw: string | undefined
  code?: string
  isPasted: boolean
}

/** 从输入流中解析出的终端响应序列（DECRPM、DA1、OSC 应答等）。
 *  非用户输入 — 消费者应分发到响应处理器。 */
export type ParsedResponse = {
  kind: 'response'
  /** 原始转义序列字节，用于调试/日志 */
  sequence: string
  response: TerminalResponse
}

/** 带有坐标的 SGR 鼠标事件。用于点击、拖拽和
 *  释放（滚轮事件保留为 ParsedKey）。col/row 为终端序列
 *  的 1 起始索引（CSI < btn;col;row M/m）。 */
export type ParsedMouse = {
  kind: 'mouse'
  /** 原始 SGR 按钮编码。低 2 位 = 按钮（0=左，1=中，2=右），
   *  第 5 位（0x20）= 拖拽/移动，第 6 位（0x40）= 滚轮。 */
  button: number
  /** M 终止符表示 'press'（按下），m 终止符表示 'release'（释放） */
  action: 'press' | 'release'
  /** 列（1 起始，来自终端） */
  col: number
  /** 行（1 起始，来自终端） */
  row: number
  sequence: string
}

/** 输入解析器可能输出的所有内容：用户按键/粘贴、
 *  鼠标点击/拖拽事件，或对已发送查询的终端响应。 */
export type ParsedInput = ParsedKey | ParsedMouse | ParsedResponse

/**
 * 将 SGR 鼠标事件序列解析为 ParsedMouse，如果不是鼠标
 * 事件或是滚轮事件则返回 null（滚轮保留为 ParsedKey 供
 * 键绑定系统使用）。按钮第 0x40 位 = 滚轮，第 0x20 位 = 拖拽/移动。
 */
function parseMouseEvent(s: string): ParsedMouse | null {
  const match = SGR_MOUSE_RE.exec(s)
  if (!match) {
    return null
  }
  const button = parseInt(match[1]!, 10)
  // 滚轮事件（第 6 位为 1，低位 0/1 表示向上/向下）保留为 ParsedKey，
  // 以便 keybinding 系统将其路由给滚动处理器。
  if ((button & 0x40) !== 0) {
    return null
  }
  return {
    kind: 'mouse',
    button,
    action: match[4] === 'M' ? 'press' : 'release',
    col: parseInt(match[2]!, 10),
    row: parseInt(match[3]!, 10),
    sequence: s,
  }
}

function parseKeypress(s: string = ''): ParsedKey {
  let parts

  const key: ParsedKey = {
    kind: 'key',
    name: '',
    fn: false,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: s,
    raw: s,
    isPasted: false,
  }

  key.sequence = key.sequence || s || key.name

  // 处理 CSI u（kitty 键盘协议）：ESC [ 码点 [; 修饰键] u
  // 例如：ESC[13;2u = Shift+Enter，ESC[27u = Escape（无修饰键）
  let match: RegExpExecArray | null
  if ((match = CSI_U_RE.exec(s))) {
    const codepoint = parseInt(match[1]!, 10)
    // 修饰键不存在时默认为 1（无修饰键）
    const modifier = match[2] ? parseInt(match[2], 10) : 1
    const mods = decodeModifier(modifier)
    const name = keycodeToName(codepoint)
    return {
      kind: 'key',
      name,
      fn: false,
      ctrl: mods.ctrl,
      meta: mods.meta,
      shift: mods.shift,
      option: false,
      super: mods.super,
      sequence: s,
      raw: s,
      isPasted: false,
    }
  }

  // 处理 xterm modifyOtherKeys：ESC [ 27 ; 修饰键 ; 键码 ~
  // 必须在 FN_KEY_RE 之前运行 — FN_KEY_RE 在 ~ 前只允许 2 个参数，
  // 如果部分匹配会留下尾部垃圾。
  if ((match = MODIFY_OTHER_KEYS_RE.exec(s))) {
    const mods = decodeModifier(parseInt(match[1]!, 10))
    const name = keycodeToName(parseInt(match[2]!, 10))
    return {
      kind: 'key',
      name,
      fn: false,
      ctrl: mods.ctrl,
      meta: mods.meta,
      shift: mods.shift,
      option: false,
      super: mods.super,
      sequence: s,
      raw: s,
      isPasted: false,
    }
  }

  // SGR 鼠标滚轮事件。点击/拖拽/释放事件由前面的
  // parseMouseEvent 处理并发出 ParsedMouse，因此不会到达这里。
  // 用 0x43 掩码（第 6+1+0 位）检查滚轮标志位
  // + 方向，同时忽略修饰键位（Shift=0x04、Meta=0x08、
  // Ctrl=0x10）— 修饰过的滚轮事件（例如 Ctrl+滚动，button=80）
  // 仍应被识别为 wheelup/wheeldown。
  if ((match = SGR_MOUSE_RE.exec(s))) {
    const button = parseInt(match[1]!, 10)
    if ((button & 0x43) === 0x40) {
      return createNavKey(s, 'wheelup', false)
    }
    if ((button & 0x43) === 0x41) {
      return createNavKey(s, 'wheeldown', false)
    }
    // 理论上不应到达此处（parseMouseEvent 已处理非滚轮事件），但做安全处理
    return createNavKey(s, 'mouse', false)
  }

  // X10 鼠标：CSI M + 3 个原始字节（Cb+32，Cx+32，Cy+32）。忽略
  // DECSET 1006（SGR）但支持 1000/1002 的终端会发出这种遗留编码。
  // 按钮位匹配 SGR：0x40 = 滚轮，低位 = 方向。非滚轮
  // X10 事件（点击/拖拽）在此被静默处理 — 我们仅在
  // 备用屏幕中启用鼠标跟踪，且 ScrollBox 只需要滚轮。
  if (s.length === 6 && s.startsWith('\x1b[M')) {
    const button = s.charCodeAt(3) - 32
    if ((button & 0x43) === 0x40) {
      return createNavKey(s, 'wheelup', false)
    }
    if ((button & 0x43) === 0x41) {
      return createNavKey(s, 'wheeldown', false)
    }
    return createNavKey(s, 'mouse', false)
  }

  if (s === '\r') {
    key.raw = undefined
    key.name = 'return'
  } else if (s === '\n') {
    key.name = 'enter'
  } else if (s === '\t') {
    key.name = 'tab'
  } else if (s === '\b' || s === '\x1b\b') {
    key.name = 'backspace'
    key.meta = s.charAt(0) === '\x1b'
  } else if (s === '\x7f' || s === '\x1b\x7f') {
    key.name = 'backspace'
    key.meta = s.charAt(0) === '\x1b'
  } else if (s === '\x1b' || s === '\x1b\x1b') {
    key.name = 'escape'
    key.meta = s.length === 2
  } else if (s === ' ' || s === '\x1b ') {
    key.name = 'space'
    key.meta = s.length === 2
  } else if (s === '\x1f') {
    key.name = '_'
    key.ctrl = true
  } else if (s <= '\x1a' && s.length === 1) {
    key.name = String.fromCharCode(s.charCodeAt(0) + 'a'.charCodeAt(0) - 1)
    key.ctrl = true
  } else if (s.length === 1 && s >= '0' && s <= '9') {
    key.name = 'number'
  } else if (s.length === 1 && s >= 'a' && s <= 'z') {
    key.name = s
  } else if (s.length === 1 && s >= 'A' && s <= 'Z') {
    key.name = s.toLowerCase()
    key.shift = true
  } else if ((parts = META_KEY_CODE_RE.exec(s))) {
    key.meta = true
    key.shift = /^[A-Z]$/.test(parts[1]!)
  } else if ((parts = FN_KEY_RE.exec(s))) {
    const segs = [...s]

    if (segs[0] === '\u001b' && segs[1] === '\u001b') {
      key.option = true
    }

    const code = [parts[1], parts[2], parts[4], parts[6]].filter(Boolean).join('')

    const modifier = ((parts[3] || parts[5] || 1) as number) - 1

    key.ctrl = !!(modifier & 4)
    key.meta = !!(modifier & 2)
    key.super = !!(modifier & 8)
    key.shift = !!(modifier & 1)
    key.code = code

    key.name = keyName[code]
    key.shift = isShiftKey(code) || key.shift
    key.ctrl = isCtrlKey(code) || key.ctrl
  }

  // iTerm 自然文本编辑模式
  if (key.raw === '\x1Bb') {
    key.meta = true
    key.name = 'left'
  } else if (key.raw === '\x1Bf') {
    key.meta = true
    key.name = 'right'
  }

  switch (s) {
    case '\u001b[1~':
      return createNavKey(s, 'home', false)
    case '\u001b[4~':
      return createNavKey(s, 'end', false)
    case '\u001b[5~':
      return createNavKey(s, 'pageup', false)
    case '\u001b[6~':
      return createNavKey(s, 'pagedown', false)
    case '\u001b[1;5D':
      return createNavKey(s, 'left', true)
    case '\u001b[1;5C':
      return createNavKey(s, 'right', true)
  }

  return key
}

function createNavKey(s: string, name: string, ctrl: boolean): ParsedKey {
  return {
    kind: 'key',
    name,
    ctrl,
    meta: false,
    shift: false,
    option: false,
    super: false,
    fn: false,
    sequence: s,
    raw: s,
    isPasted: false,
  }
}
