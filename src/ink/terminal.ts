import type { Writable } from 'node:stream'
import { coerce } from 'semver'
import { env } from '../services/environment/env.js'
import { gte } from '../utils/semver.js'
import { getClearTerminalSequence } from './clearTerminal.js'
import type { Diff } from './frame.js'
import { cursorMove, cursorTo, eraseLines } from './termio/csi.js'
import { BSU, ESU, HIDE_CURSOR, SHOW_CURSOR } from './termio/dec.js'
import { link } from './termio/osc.js'

export type Progress = {
  state: 'running' | 'completed' | 'error' | 'indeterminate'
  percentage?: number
}

/**
 * 检查终端是否支持 OSC 9;4 进度报告。
 * 支持的终端：
 * - ConEmu (Windows) - 所有版本
 * - Ghostty 1.2.0+
 * - iTerm2 3.6.6+
 *
 * 注意：Windows Terminal 会将 OSC 9;4 解释为通知，而非进度。
 */
export function isProgressReportingAvailable(): boolean {
  // 仅在 TTY 环境下可用（非管道模式）
  if (!process.stdout.isTTY) {
    return false
  }

  // 明确排除 Windows Terminal，它会将 OSC 9;4 解释为
  // 通知，而非进度指示器
  if (process.env.WT_SESSION) {
    return false
  }

  // ConEmu 支持 OSC 9;4 进度报告（所有版本）
  if (process.env.ConEmuANSI || process.env.ConEmuPID || process.env.ConEmuTask) {
    return true
  }

  const version = coerce(process.env.TERM_PROGRAM_VERSION)
  if (!version) {
    return false
  }

  // Ghostty 1.2.0+ 支持 OSC 9;4 进度报告
  // https://ghostty.org/docs/install/release-notes/1-2-0
  if (process.env.TERM_PROGRAM === 'ghostty') {
    return gte(version.version, '1.2.0')
  }

  // iTerm2 3.6.6+ 支持 OSC 9;4 进度报告
  // https://iterm2.com/downloads.html
  if (process.env.TERM_PROGRAM === 'iTerm.app') {
    return gte(version.version, '3.6.6')
  }

  return false
}

/**
 * 检查终端是否支持 DEC 模式 2026（同步输出）。
 * 支持时，BSU/ESU 序列可防止重绘时出现可见闪烁。
 */
export function isSynchronizedOutputSupported(): boolean {
  // tmux 会解析并转发每个字节，但不实现 DEC 2026。
  // BSU/ESU 会透传到外部终端，但 tmux 已经通过分块
  // 破坏了原子性。跳过以节省每帧 16 字节 + 解析器开销。
  if (process.env.TMUX) {
    return false
  }

  // 对齐 Claude Code：JediTerm 支持 DEC 2026，但不支持 DECSTBM。
  // 两项能力必须分开判断；把 DECSTBM 的限制误用于同步输出会让
  // 全屏帧失去原子性，IME 可能看到“内容更新后、光标归位前”的中间态。
  if (process.env.TERMINAL_EMULATOR === 'JetBrains-JediTerm') {
    return true
  }

  const termProgram = process.env.TERM_PROGRAM
  const term = process.env.TERM

  // 已知支持 DEC 2026 的现代终端
  if (
    termProgram === 'iTerm.app' ||
    termProgram === 'WezTerm' ||
    termProgram === 'WarpTerminal' ||
    termProgram === 'ghostty' ||
    termProgram === 'contour' ||
    termProgram === 'vscode' ||
    termProgram === 'alacritty'
  ) {
    return true
  }

  // kitty 会设置 TERM=xterm-kitty 或 KITTY_WINDOW_ID
  if (term?.includes('kitty') || process.env.KITTY_WINDOW_ID) {
    return true
  }

  // Ghostty 可能设置 TERM=xterm-ghostty 而不设置 TERM_PROGRAM
  if (term === 'xterm-ghostty') {
    return true
  }

  // foot 会设置 TERM=foot 或 TERM=foot-extra
  if (term?.startsWith('foot')) {
    return true
  }

  // Alacritty 可能设置包含 'alacritty' 的 TERM
  if (term?.includes('alacritty')) {
    return true
  }

  // Zed 使用 alacritty_terminal crate，支持 DEC 2026
  if (process.env.ZED_TERM) {
    return true
  }

  // Windows Terminal
  if (process.env.WT_SESSION) {
    return true
  }

  // VTE 终端（GNOME Terminal、Tilix 等），自 VTE 0.68 起支持
  const vteVersion = process.env.VTE_VERSION
  if (vteVersion) {
    const version = parseInt(vteVersion, 10)
    if (version >= 6800) {
      return true
    }
  }

  return false
}

/**
 * 检查是否可以启用 DECSTBM 区域滚动快速路径。
 *
 * 该路径不仅要求终端理解滚动区域，还要求区域滚动与后续差异补绘
 * 能作为同一原子帧提交。不能直接复用 DEC 2026 能力：JediTerm 支持
 * 同步输出，但不正确实现这里使用的 DECSTBM + SU/SD 组合。
 */
export function isDecstbmFastPathSupported(): boolean {
  if (process.env.TERMINAL_EMULATOR?.includes('JetBrains')) {
    return false
  }

  return isSynchronizedOutputSupported()
}

// -- 通过 XTVERSION 检测终端名称（启动时异步获取） --
//
// 默认情况下 TERM_PROGRAM 不会通过 SSH 转发，因此当 ZY 在
// VS Code 集成终端内远程运行时，基于环境变量的检测会失效。
// XTVERSION（CSI > 0 q → DCS > | name ST）通过 pty 传输——查询
// 会到达*客户端*终端，回复通过 stdin 返回。
// App.tsx 在启用 raw mode 时触发查询；setXtversionName() 在
// 响应处理程序中被调用。调用者应将 undefined 视为"尚未获知"，
// 并回退到环境变量检测。

let xtversionName: string | undefined

/** 记录 XTVERSION 响应。从 App.tsx 调用，当 stdin 收到回复时触发。
 *  如果已设置则不操作（防止重复探测）。 */
export function setXtversionName(name: string): void {
  if (xtversionName === undefined) {
    xtversionName = name
  }
}

/** 判断是否在 xterm.js 终端中运行（VS Code、Cursor、Windsurf
 *  集成终端）。结合 TERM_PROGRAM 环境变量检查（快速、同步，但
 *  不通过 SSH 转发）和 XTVERSION 探测结果（异步，支持 SSH——
 *  查询/回复通过 pty 传输）。早期调用可能错过探测回复——如果需要
 *  SSH 检测，请延迟调用（例如在事件处理程序中）。 */
export function isXtermJs(): boolean {
  if (process.env.TERM_PROGRAM === 'vscode') {
    return true
  }
  return xtversionName?.startsWith('xterm.js') ?? false
}

// 已知正确实现 Kitty 键盘协议
// (CSI >1u) 和/或 xterm modifyOtherKeys (CSI >4;2m) 的终端，
// 用于消除 ctrl+shift+<字母> 的歧义。我们之前无条件启用（#23350），
// 假设终端会静默忽略未知 CSI——但有些终端会处理这些序列并
// 发出我们的输入解析器无法处理的码点（尤其是在 SSH 和
// 基于 xterm.js 的终端如 VS Code 中）。tmux 在白名单中是因为它
// 接受 modifyOtherKeys 且不会将 kitty 序列转发到外部终端。
const EXTENDED_KEYS_TERMINALS = [
  'iTerm.app',
  'kitty',
  'WezTerm',
  'ghostty',
  'tmux',
  'windows-terminal',
]

/** 判断当前终端是否正确处理扩展键报告
 *  （Kitty 键盘协议 + xterm modifyOtherKeys）。 */
export function supportsExtendedKeys(): boolean {
  return EXTENDED_KEYS_TERMINALS.includes(env.terminal ?? '')
}

/** 终端收到光标上移序列且超出可见区域时，是否会滚动视口。
 *  在 Windows 上，conhost 的 SetConsoleCursorPosition 会跟随光标
 *  进入回滚区（microsoft/terminal#14774），导致用户在流中间被
 *  拉到缓冲区顶部。WT_SESSION 可捕获 Windows Terminal 中的 WSL，
 *  此时 platform 为 linux，但输出仍通过 conhost 路由。 */
export function hasCursorUpViewportYankBug(): boolean {
  return process.platform === 'win32' || !!process.env.WT_SESSION
}

type WideCellRenderAnchorOptions = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

/**
 * 终端写入 CJK/emoji 宽字符后，物理光标列是否可能与内部单元格模型偏离。
 *
 * Windows Terminal 的差量重绘在宽字符移动或样式切换后可能留下半格残影；
 * JediTerm 在 Windows 上也有相同的光标列偏差。启用后，下一处写入会使用
 * 绝对坐标重新锚定，并显式清理被移除的宽字符尾格。
 */
export function needsWideCellRenderAnchor(options: WideCellRenderAnchorOptions = {}): boolean {
  const platform = options.platform ?? process.platform
  const processEnv = options.env ?? process.env

  if (processEnv.WT_SESSION) {
    return true
  }

  return platform === 'win32' && processEnv.TERMINAL_EMULATOR?.includes('JetBrains') === true
}

/**
 * 主屏布局位移时会同时重写多行并移动交互光标，此时插入额外锚点会与
 * 候选栏、权限框等动态区域的相对定位竞争。备用屏拥有绝对坐标原点，
 * 可以在布局变化期间安全地继续锚定。
 */
export function canAnchorWideCellsForFrame(layoutShifted: boolean, altScreen: boolean): boolean {
  return !layoutShifted || altScreen
}

// 模块加载时计算一次——终端能力在会话期间不会改变。
// 导出以便调用方传递同步跳过提示，仅限特定模式。
export const SYNC_OUTPUT_SUPPORTED = isSynchronizedOutputSupported()
export const DECSTBM_FAST_PATH_SUPPORTED = isDecstbmFastPathSupported()

export type Terminal = {
  stdout: Writable
  stderr: Writable
}

export function writeDiffToTerminal(terminal: Terminal, diff: Diff, skipSyncMarkers = false): void {
  // 没有补丁时无输出
  if (diff.length === 0) {
    return
  }

  // BSU/ESU 包装默认关闭，以保持主屏行为不变。
  // 当终端不支持 DEC 2026（如 tmux）且开销较大时
  //（高频 alt-screen），调用方传入 skipSyncMarkers=true。
  const useSync = !skipSyncMarkers

  // 将所有写入缓冲为单个字符串，避免多次写入调用
  let buffer = useSync ? BSU : ''

  for (const patch of diff) {
    switch (patch.type) {
      case 'stdout':
        buffer += patch.content
        break
      case 'clear':
        if (patch.count > 0) {
          buffer += eraseLines(patch.count)
        }
        break
      case 'clearTerminal':
        buffer += getClearTerminalSequence()
        break
      case 'cursorHide':
        buffer += HIDE_CURSOR
        break
      case 'cursorShow':
        buffer += SHOW_CURSOR
        break
      case 'cursorMove':
        buffer += cursorMove(patch.x, patch.y)
        break
      case 'cursorTo':
        buffer += cursorTo(patch.col)
        break
      case 'carriageReturn':
        buffer += '\r'
        break
      case 'hyperlink':
        buffer += link(patch.uri)
        break
      case 'styleStr':
        buffer += patch.str
        break
    }
  }

  // 添加同步更新结束标记并刷新缓冲区
  if (useSync) {
    buffer += ESU
  }

  terminal.stdout.write(buffer)
}
