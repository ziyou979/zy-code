import { nonAlphanumericKeys, type ParsedKey } from '../parse-keypress.js'
import { Event } from './event.js'

export type Key = {
  upArrow: boolean
  downArrow: boolean
  leftArrow: boolean
  rightArrow: boolean
  pageDown: boolean
  pageUp: boolean
  wheelUp: boolean
  wheelDown: boolean
  home: boolean
  end: boolean
  return: boolean
  escape: boolean
  ctrl: boolean
  shift: boolean
  fn: boolean
  tab: boolean
  backspace: boolean
  delete: boolean
  meta: boolean
  super: boolean
}

function parseKey(keypress: ParsedKey): [Key, string] {
  const key: Key = {
    upArrow: keypress.name === 'up',
    downArrow: keypress.name === 'down',
    leftArrow: keypress.name === 'left',
    rightArrow: keypress.name === 'right',
    pageDown: keypress.name === 'pagedown',
    pageUp: keypress.name === 'pageup',
    wheelUp: keypress.name === 'wheelup',
    wheelDown: keypress.name === 'wheeldown',
    home: keypress.name === 'home',
    end: keypress.name === 'end',
    return: keypress.name === 'return',
    escape: keypress.name === 'escape',
    fn: keypress.fn,
    ctrl: keypress.ctrl,
    shift: keypress.shift,
    tab: keypress.name === 'tab',
    backspace: keypress.name === 'backspace',
    delete: keypress.name === 'delete',
    // `parseKeypress` 将 \u001B\u001B[A（meta + 上箭头）解析为 meta = false
    // 但 option = true，因此这里需要特别处理
    // 以避免在 Ink 中引入破坏性变更。
    // TODO(vadimdemedes): consider removing this in the next major version.
    meta: keypress.meta || keypress.name === 'escape' || keypress.option,
    // Super（macOS 上的 Cmd / Windows 键）—— 仅通过 kitty keyboard
    // 协议的 CSI u 序列传入。与 meta（Alt/Option）不同，
    // 因此 cmd+c 和 opt+c 可以分别绑定。
    super: keypress.super,
  }

  let input = keypress.ctrl ? keypress.name : keypress.sequence

  // 处理 input 为 undefined 的情况
  if (input === undefined) {
    input = ''
  }

  // 当 ctrl 被设置时，keypress.name 对于空格是字面量 "space"。
  // 将其转换为实际空格字符，以便与 CSI u 分支保持一致
  //（该分支将 'space' 映射为 ' '）。否则 ctrl+space 会将字面量
  // "space" 泄漏到文本输入中。
  if (keypress.ctrl && input === 'space') {
    input = ' '
  }

  // 抑制无法识别的转义序列，这些序列被解析为功能键
  //（被 FN_KEY_RE 匹配）但在 keyName 映射表中没有对应名称。
  // 例如：ESC[25~（Windows 上的 F13/右 Alt）、ESC[26~（F14）等。
  // 如果不处理，下方的 ESC 前缀会被剥离，剩余部分（如
  // "[25~"）会作为字面量文本泄漏到输入中。
  if (keypress.code && !keypress.name) {
    input = ''
  }

  // 抑制缺少 ESC 的 SGR 鼠标片段。当繁重的 React 提交阻塞
  // 事件循环超过 App 的 50ms NORMAL_TIMEOUT 刷新时，
  // 跨 stdin 块分割的 CSI 序列中，缓冲的 ESC 会作为
  // 单独的 Escape 键被刷新，后续部分作为 name='' 的文本标记到达
  // —— 这会绕过 parseKeypress 所有以 ESC 为锚点的正则匹配，
  // 以及下方 nonAlphanumericKeys 的清除逻辑（name 为 falsy）。
  // 该片段随后作为字面量 `[<64;74;16M` 泄漏到提示符中。
  // 这与上方 F13 防护是同样的防御性处理；底层的分词器
  // 刷新竞争发生在此层之上。
  if (!keypress.name && /^\[<\d+;\d+;\d+[Mm]/.test(input)) {
    input = ''
  }

  // 如果 `parseKeypress` 之后 meta 仍然存在，则将其剥离
  // TODO(vadimdemedes): remove this in the next major version.
  if (input.startsWith('\u001B')) {
    input = input.slice(1)
  }

  // 跟踪是否已将其作为特殊序列处理过
  //（已将 input 转换为键名，如 CSI u 或应用小键盘模式）。
  // 对于这些情况，不需要通过 nonAlphanumericKeys 检查来清除 input。
  let processedAsSpecialSequence = false

  // 处理 CSI u 序列（Kitty keyboard 协议）：剥离 ESC 后，
  // 剩下 "[codepoint;modifieru"（例如 Alt+b 的 "[98;3u"）。
  // 使用解析后的键名进行 input 处理。要求 [ 后有数字
  // —— 真实的 CSI u 总是 [<digits>…u 格式，而单纯的 startsWith('[')
  // 会在 X10 鼠标第 85 行（Cy = 85+32 = 'u'）处误匹配，
  // 通过 processedAsSpecialSequence 将字面量文本 "mouse" 泄漏到提示符中。
  if (/^\[\d/.test(input) && input.endsWith('u')) {
    if (!keypress.name) {
      // 未映射的 Kitty 功能键（Caps Lock 57358、F13–F35、小键盘导航键、
      // 纯修饰键等）—— keycodeToName() 返回 undefined。吞掉该输入
      // 以防止原始 "[57358u" 泄漏到提示符中。参见 #38781。
      input = ''
    } else {
      // 'space' → ' '；'escape' → ''（由 key.escape 承载；
      // processedAsSpecialSequence 会跳过下方的 nonAlphanumericKeys
      // 清除逻辑，因此必须在此显式处理）；
      // 其他情况使用键名。
      input =
        keypress.name === 'space'
          ? ' '
          : keypress.name === 'escape'
            ? ''
            : keypress.name
    }
    processedAsSpecialSequence = true
  }

  // 处理 xterm modifyOtherKeys 序列：剥离 ESC 后，剩下
  // "[27;modifier;keycode~"（例如 Alt+b 的 "[27;3;98~"）。
  // 提取逻辑与 CSI u 相同 —— 如果不处理，可打印字符的 keycode
  //（单字母名称）会跳过 nonAlphanumericKeys 清除，导致
  // "[27;..." 作为 input 泄漏。
  if (input.startsWith('[27;') && input.endsWith('~')) {
    if (!keypress.name) {
      // 未映射的 modifyOtherKeys keycode —— 为与上方 CSI u 处理逻辑
      // 保持一致而吞掉。当前实际上无法触发（xterm modifyOtherKeys
      // 只发送 ASCII keycode，全部已映射），但可防范未来
      // 终端行为的变化。
      input = ''
    } else {
      input =
        keypress.name === 'space'
          ? ' '
          : keypress.name === 'escape'
            ? ''
            : keypress.name
    }
    processedAsSpecialSequence = true
  }

  // 处理应用小键盘模式序列：剥离 ESC 后，剩下
  // "O<字母>"（例如小键盘 0 的 "Op"，小键盘 9 的 "Oy"）。
  // 使用解析后的键名（数字字符）进行 input 处理。
  if (
    input.startsWith('O') &&
    input.length === 2 &&
    keypress.name &&
    keypress.name.length === 1
  ) {
    input = keypress.name
    processedAsSpecialSequence = true
  }

  // 清除非字母数字键（方向键、功能键等）的 input
  // 跳过 CSI u 和应用小键盘模式序列，因为它们
  // 已被转换为正确的输入字符。
  if (
    !processedAsSpecialSequence &&
    keypress.name &&
    nonAlphanumericKeys.includes(keypress.name)
  ) {
    input = ''
  }

  // 为大写字母（A-Z）设置 shift=true
  // 必须确认它确实是字母，而非任何不受 toUpperCase 影响的字符
  if (
    input.length === 1 &&
    typeof input[0] === 'string' &&
    input[0] >= 'A' &&
    input[0] <= 'Z'
  ) {
    key.shift = true
  }

  return [key, input]
}

export class InputEvent extends Event {
  readonly keypress: ParsedKey
  readonly key: Key
  readonly input: string

  constructor(keypress: ParsedKey) {
    super()
    const [key, input] = parseKey(keypress)

    this.keypress = keypress
    this.key = key
    this.input = input
  }
}
