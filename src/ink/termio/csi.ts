/**
 * CSI（控制序列引导符）类型
 *
 * CSI 命令参数的枚举和类型。
 */

import { ESC, ESC_TYPE, SEP } from './ansi.js'

export const CSI_PREFIX = ESC + String.fromCharCode(ESC_TYPE.CSI)

/**
 * CSI 参数字节范围
 */
export const CSI_RANGE = {
  PARAM_START: 0x30,
  PARAM_END: 0x3f,
  INTERMEDIATE_START: 0x20,
  INTERMEDIATE_END: 0x2f,
  FINAL_START: 0x40,
  FINAL_END: 0x7e,
} as const

/** 判断一个字节是否为 CSI 参数字节 */
export function isCSIParam(byte: number): boolean {
  return byte >= CSI_RANGE.PARAM_START && byte <= CSI_RANGE.PARAM_END
}

/** 判断一个字节是否为 CSI 中间字节 */
export function isCSIIntermediate(byte: number): boolean {
  return (
    byte >= CSI_RANGE.INTERMEDIATE_START && byte <= CSI_RANGE.INTERMEDIATE_END
  )
}

/** 判断一个字节是否为 CSI 结束字节（@ 到 ~） */
export function isCSIFinal(byte: number): boolean {
  return byte >= CSI_RANGE.FINAL_START && byte <= CSI_RANGE.FINAL_END
}

/**
 * 生成 CSI 序列：ESC [ p1;p2;...;pN final
 * 单个参数：视为原始主体
 * 多个参数：最后一个是结束字节，其余是用 ; 连接的参数
 */
export function csi(...args: (string | number)[]): string {
  if (args.length === 0) return CSI_PREFIX
  if (args.length === 1) return `${CSI_PREFIX}${args[0]}`
  const params = args.slice(0, -1)
  const final = args[args.length - 1]
  return `${CSI_PREFIX}${params.join(SEP)}${final}`
}

/**
 * CSI 结束字节 - 命令标识符
 */
export const CSI = {
  // 光标移动
  CUU: 0x41, // A - 光标上移
  CUD: 0x42, // B - 光标下移
  CUF: 0x43, // C - 光标右移
  CUB: 0x44, // D - 光标左移
  CNL: 0x45, // E - 光标下一行
  CPL: 0x46, // F - 光标上一行
  CHA: 0x47, // G - 光标水平绝对定位
  CUP: 0x48, // H - 光标定位
  CHT: 0x49, // I - 光标水平制表
  VPA: 0x64, // d - 垂直绝对定位
  HVP: 0x66, // f - 水平垂直定位

  // 擦除
  ED: 0x4a, // J - 擦除显示
  EL: 0x4b, // K - 擦除行
  ECH: 0x58, // X - 擦除字符

  // 插入/删除
  IL: 0x4c, // L - 插入行
  DL: 0x4d, // M - 删除行
  ICH: 0x40, // @ - 插入字符
  DCH: 0x50, // P - 删除字符

  // 滚动
  SU: 0x53, // S - 上滚
  SD: 0x54, // T - 下滚

  // 模式
  SM: 0x68, // h - 设置模式
  RM: 0x6c, // l - 重置模式

  // SGR
  SGR: 0x6d, // m - 选择图形渲染

  // 其他
  DSR: 0x6e, // n - 设备状态报告
  DECSCUSR: 0x71, // q - 设置光标样式（带空格中间字节）
  DECSTBM: 0x72, // r - 设置上下边距
  SCOSC: 0x73, // s - 保存光标位置
  SCORC: 0x75, // u - 恢复光标位置
  CBT: 0x5a, // Z - 光标回退制表
} as const

/**
 * 显示擦除区域（ED 命令参数）
 */
export const ERASE_DISPLAY = ['toEnd', 'toStart', 'all', 'scrollback'] as const

/**
 * 行擦除区域（EL 命令参数）
 */
export const ERASE_LINE_REGION = ['toEnd', 'toStart', 'all'] as const

/**
 * 光标样式（DECSCUSR）
 */
export type CursorStyle = 'block' | 'underline' | 'bar'

export const CURSOR_STYLES: Array<{ style: CursorStyle; blinking: boolean }> = [
  { style: 'block', blinking: true }, // 0 - 默认
  { style: 'block', blinking: true }, // 1
  { style: 'block', blinking: false }, // 2
  { style: 'underline', blinking: true }, // 3
  { style: 'underline', blinking: false }, // 4
  { style: 'bar', blinking: true }, // 5
  { style: 'bar', blinking: false }, // 6
]

// 光标移动生成器

/** 光标上移 n 行（CSI n A） */
export function cursorUp(n = 1): string {
  return n === 0 ? '' : csi(n, 'A')
}

/** 光标下移 n 行（CSI n B） */
export function cursorDown(n = 1): string {
  return n === 0 ? '' : csi(n, 'B')
}

/** 光标右移 n 列（CSI n C） */
export function cursorForward(n = 1): string {
  return n === 0 ? '' : csi(n, 'C')
}

/** 光标左移 n 列（CSI n D） */
export function cursorBack(n = 1): string {
  return n === 0 ? '' : csi(n, 'D')
}

/** 光标移到第 n 列（从 1 开始）（CSI n G） */
export function cursorTo(col: number): string {
  return csi(col, 'G')
}

/** 光标移到第 1 列（CSI G） */
export const CURSOR_LEFT = csi('G')

/** 光标移到指定行、列（从 1 开始）（CSI row ; col H） */
export function cursorPosition(row: number, col: number): string {
  return csi(row, col, 'H')
}

/** 光标回到起始位置（CSI H） */
export const CURSOR_HOME = csi('H')

/**
 * 相对于当前位置移动光标
 * 正 x = 右，负 x = 左
 * 正 y = 下，负 y = 上
 */
export function cursorMove(x: number, y: number): string {
  let result = ''
  // 先水平（匹配 ansi-escapes 行为）
  if (x < 0) {
    result += cursorBack(-x)
  } else if (x > 0) {
    result += cursorForward(x)
  }
  // 然后垂直
  if (y < 0) {
    result += cursorUp(-y)
  } else if (y > 0) {
    result += cursorDown(y)
  }
  return result
}

// 保存/恢复光标位置

/** 保存光标位置（CSI s） */
export const CURSOR_SAVE = csi('s')

/** 恢复光标位置（CSI u） */
export const CURSOR_RESTORE = csi('u')

// 擦除生成器

/** 擦除从光标到行尾（CSI K） */
export function eraseToEndOfLine(): string {
  return csi('K')
}

/** 擦除从光标到行首（CSI 1 K） */
export function eraseToStartOfLine(): string {
  return csi(1, 'K')
}

/** 擦除整行（CSI 2 K） */
export function eraseLine(): string {
  return csi(2, 'K')
}

/** 擦除整行 - 常量形式 */
export const ERASE_LINE = csi(2, 'K')

/** 擦除从光标到屏幕末尾（CSI J） */
export function eraseToEndOfScreen(): string {
  return csi('J')
}

/** 擦除从光标到屏幕开头（CSI 1 J） */
export function eraseToStartOfScreen(): string {
  return csi(1, 'J')
}

/** 擦除整个屏幕（CSI 2 J） */
export function eraseScreen(): string {
  return csi(2, 'J')
}

/** 擦除整个屏幕 - 常量形式 */
export const ERASE_SCREEN = csi(2, 'J')

/** Erase scrollback buffer (CSI 3 J) */
export const ERASE_SCROLLBACK = csi(3, 'J')

/**
 * 从光标行开始擦除 n 行，光标上移
 * 这会擦除每一行并上移，最终停留在第 1 列
 */
export function eraseLines(n: number): string {
  if (n <= 0) return ''
  let result = ''
  for (let i = 0; i < n; i++) {
    result += ERASE_LINE
    if (i < n - 1) {
      result += cursorUp(1)
    }
  }
  result += CURSOR_LEFT
  return result
}

// 滚动

/** 上滚 n 行（CSI n S） */
export function scrollUp(n = 1): string {
  return n === 0 ? '' : csi(n, 'S')
}

/** 下滚 n 行（CSI n T） */
export function scrollDown(n = 1): string {
  return n === 0 ? '' : csi(n, 'T')
}

/** 设置滚动区域（DECSTBM，CSI top;bottom r）。从 1 开始，包含边界。 */
export function setScrollRegion(top: number, bottom: number): string {
  return csi(top, bottom, 'r')
}

/** 重置滚动区域为全屏（DECSTBM，CSI r）。光标回到起始位置。 */
export const RESET_SCROLL_REGION = csi('r')

// 括号粘贴标记（来自终端的输入，非输出）
// 当启用括号粘贴模式时（通过 DEC 模式 2004），
// 终端发送这些标记来界定粘贴内容

/** 终端在粘贴内容之前发送（CSI 200 ~） */
export const PASTE_START = csi('200~')

/** 终端在粘贴内容之后发送（CSI 201 ~） */
export const PASTE_END = csi('201~')

// 焦点事件标记（来自终端的输入，非输出）
// 当启用焦点事件模式时（通过 DEC 模式 1004），
// 终端在焦点变化时发送这些标记

/** 终端获得焦点时发送（CSI I） */
export const FOCUS_IN = csi('I')

/** 终端失去焦点时发送（CSI O） */
export const FOCUS_OUT = csi('O')

// Kitty 键盘协议（CSI u）
// 启用增强的按键报告，包含修饰键信息
// 参见：https://sw.kovidgoyal.net/kitty/keyboard-protocol/

/**
 * 启用 Kitty 键盘协议，使用基本修饰键报告
 * CSI > 1 u - 推送模式，flags=1（消除转义码歧义）
 * 这使得 Shift+Enter 发送 CSI 13;2 u 而不是仅 CR
 */
export const ENABLE_KITTY_KEYBOARD = csi('>1u')

/**
 * 禁用 Kitty 键盘协议
 * CSI < u - 弹出键盘模式栈
 */
export const DISABLE_KITTY_KEYBOARD = csi('<u')

/**
 * 启用 xterm modifyOtherKeys 级别 2。
 * tmux 接受此设置（而非 kitty 栈）以启用扩展按键 — 当
 * extended-keys-format 为 csi-u 时，tmux 然后以 kitty 格式发射按键。
 */
export const ENABLE_MODIFY_OTHER_KEYS = csi('>4;2m')

/**
 * 禁用 xterm modifyOtherKeys（重置为默认）。
 */
export const DISABLE_MODIFY_OTHER_KEYS = csi('>4m')
