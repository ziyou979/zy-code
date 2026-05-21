/**
 * OSC（操作系统命令）类型和解析器
 */

import { Buffer } from 'node:buffer'
import { env } from '../../utils/env.js'
import { isInternalBuild } from '../../utils/envUtils.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { BEL, ESC, ESC_TYPE, SEP } from './ansi.js'
import type { Action, Color, TabStatusAction } from './types.js'

export const OSC_PREFIX = ESC + String.fromCharCode(ESC_TYPE.OSC)

/** 字符串终止符（ESC \）- 用于终止 OSC 的 BEL 替代方案 */
export const ST = `${ESC}\\`

/** 生成 OSC 序列：ESC ] p1;p2;...;pN <终止符>
 * Kitty 使用 ST 终止符（避免蜂鸣），其他使用 BEL */
export function osc(...parts: (string | number)[]): string {
  const terminator = env.terminal === 'kitty' ? ST : BEL
  return `${OSC_PREFIX}${parts.join(SEP)}${terminator}`
}

/**
 * 将转义序列包装为终端复用器直通。
 * tmux 和 GNU screen 会拦截转义序列；DCS 直通
 * 将它们无损地传输到外部终端。
 *
 * tmux 3.3+ 需要 `allow-passthrough` 门控（默认关闭）。关闭时，
 * tmux 会静默丢弃整个 DCS — 没有垃圾，也不比未包装的 OSC 更糟。
 * 需要直通的用戶在其 .tmux.conf 中设置；我们不会修改它。
 *
 * 不要包装 BEL：原始 \x07 会触发 tmux 的铃铛动作（窗口标志）；
 * 包装后的 \x07 是不透明的 DCS 载荷，tmux 永远不会看到铃铛。
 */
export function wrapForMultiplexer(sequence: string): string {
  if (process.env.TMUX) {
    const escaped = sequence.replaceAll('\x1b', '\x1b\x1b')
    return `\x1bPtmux;${escaped}\x1b\\`
  }
  if (process.env.STY) {
    return `\x1bP${sequence}\x1b\\`
  }
  return sequence
}

/**
 * setClipboard() 将采用的路径，基于 env 状态。同步的，所以
 * 调用者可以诚实地显示 toast，而无需等待复制本身。
 *
 * - 'native': 将运行 pbcopy（或等效工具）— 高置信度的系统
 *   剪贴板写入。tmux 缓冲区也可能作为额外加载。
 * - 'tmux-buffer': 将运行 tmux load-buffer，但没有原生工具 — 使用
 *   prefix+] 粘贴。系统剪贴板取决于 tmux 的 set-clipboard
 *   选项和外部终端 OSC 52 支持；从这里无法知道。
 * - 'osc52': 仅将原始 OSC 52 序列写入 stdout。
 *   尽力而为；iTerm2 默认禁用 OSC 52。
 *
 * pbcopy 门控使用 SSH_CONNECTION 而非 SSH_TTY — tmux 面板
 * 在本地重新连接后仍会永远继承 SSH_TTY，但 SSH_CONNECTION 在
 * tmux 默认的 update-environment 集合中，本地连接时会被清除。
 */
export type ClipboardPath = 'native' | 'tmux-buffer' | 'osc52'

export function getClipboardPath(): ClipboardPath {
  const nativeAvailable = process.platform === 'darwin' && !process.env.SSH_CONNECTION
  if (nativeAvailable) {
    return 'native'
  }
  if (process.env.TMUX) {
    return 'tmux-buffer'
  }
  return 'osc52'
}

/**
 * 将载荷包装在 tmux 的 DCS 直通中：ESC P tmux ; <载荷> ESC \
 * tmux 将载荷转发到外部终端，绕过其自身的解析器。
 * 内部 ESC 必须加倍。需要在 ~/.tmux.conf 中设置 `set -g allow-passthrough on`；
 * 没有它，tmux 会静默丢弃整个 DCS（无回归）。
 */
function tmuxPassthrough(payload: string): string {
  return `${ESC}Ptmux;${payload.replaceAll(ESC, ESC + ESC)}${ST}`
}

/**
 * 通过 `tmux load-buffer` 将文本加载到 tmux 的粘贴缓冲区。
 * -w（tmux 3.2+）通过 tmux 自身的 OSC 52 发射传播到外部终端的剪贴板。
 * -w 针对 iTerm2 被移除：tmux 的 OSC 52 发射
 * 会在 SSH 上使 iTerm2 会话崩溃。
 *
 * 如果缓冲区加载成功则返回 true。
 */
export async function tmuxLoadBuffer(text: string): Promise<boolean> {
  if (!process.env.TMUX) {
    return false
  }
  const args =
    process.env.LC_TERMINAL === 'iTerm2' ? ['load-buffer', '-'] : ['load-buffer', '-w', '-']
  const { code } = await execFileNoThrow('tmux', args, {
    input: text,
    useCwd: false,
    timeout: 2000,
  })
  return code === 0
}

/**
 * OSC 52 剪贴板写入：ESC ] 52 ; c ; <base64> BEL/ST
 * 'c' 选择剪贴板（相对于 X11 上的 'p' 主选择）。
 *
 * 在 tmux 内部时（设置了 $TMUX），`tmux load-buffer -w -` 是主要
 * 路径。tmux 的缓冲区始终可达 — 适用于 SSH、分离/重新连接、
 * 不受过期环境变量影响。-w 标志（tmux 3.2+）告诉
 * tmux 也通过其自身的 OSC 52 路径传播到外部终端，
 * tmux 会为连接的客户端正确包装。在旧版本 tmux 上，-w 被
 * 忽略，但缓冲区仍被加载。-w 针对 iTerm2 被移除（#22432）
 * 因为 tmux 自身的 OSC 52 发射（空选择参数：ESC]52;;b64）
 * 会在 SSH 上使 iTerm2 崩溃。
 *
 * 在 load-buffer 成功后，我们还返回 DCS 直通包装的
 * OSC 52 供调用者写入 stdout。我们的序列使用显式 `c`
 *（而非 tmux 的崩溃空参数变体），因此它绕过了 #22432 路径。
 * 启用 `allow-passthrough on` + 支持 OSC-52 的外部终端时，选择
 * 会到达系统剪贴板；任一则关闭，tmux 会静默丢弃
 * DCS，prefix+] 仍然可用。
 *
 * 如果 load-buffer 完全失败，回退到原始 OSC 52。
 *
 * 在 tmux 外部，将原始 OSC 52 写入 stdout（调用者处理写入）。
 *
 * 本地（无 SSH_CONNECTION）：还调用原生剪贴板工具。
 * OSC 52 和 tmux -w 都取决于终端设置 — iTerm2 默认禁用
 * OSC 52，VS Code 首次使用时显示权限提示。原生
 * 工具（pbcopy/wl-copy/xclip/xsel/clip.exe）在本地始终可用。在
 * SSH 上这些会写入远程剪贴板 — OSC 52 在那里是正确路径。
 *
 * 返回序列供调用者写入 stdout（tmux
 * 外部为原始 OSC 52，内部为 DCS 包装）。
 */
export async function setClipboard(text: string): Promise<string> {
  const b64 = Buffer.from(text, 'utf8').toString('base64')
  const raw = osc(OSC.CLIPBOARD, 'c', b64)

  // 原生安全网 — 在 tmux await 之前触发 FIRST，这样在
  // 选择后快速切换焦点不会与 pbcopy 竞争。之前这运行
  // 在等待 tmux load-buffer 之后，增加了约 50-100ms 的子进程延迟
  // 才启动 pbcopy — 快速 cmd+tab → 粘贴会抢先完成
  //（https://anthropic.slack.com/archives/C07VBSHV7EV/p1773943921788829）。
  // 受 SSH_CONNECTION 门控（而非 SSH_TTY），因为 tmux 面板永远继承 SSH_TTY，
  // 但 SSH_CONNECTION 在 tmux 默认的 update-environment 中，
  // 本地连接时会被清除。触发后不等待。
  if (!process.env.SSH_CONNECTION) {
    copyNative(text)
  }

  const tmuxBufferLoaded = await tmuxLoadBuffer(text)

  // 内部 OSC 直接使用 BEL（而非 osc()）— ST 的 ESC 也需要加倍，
  // 而 BEL 在 OSC 52 上到处都可用。
  if (tmuxBufferLoaded) {
    return tmuxPassthrough(`${ESC}]52;c;${b64}${BEL}`)
  }
  return raw
}

// Linux 剪贴板工具：undefined = 尚未探测，null = 无可用。
// 探测顺序：wl-copy（Wayland）→ xclip（X11）→ xsel（X11 备选）。
// 首次尝试后缓存，以便后续鼠标操作跳过探测链。
let linuxCopy: 'wl-copy' | 'xclip' | 'xsel' | null | undefined

/**
 * 调用原生剪贴板工具作为 OSC 52 的安全网。
 * 仅在非 SSH 会话时调用（在 SSH 上，这些会写入
 * 远程机器的剪贴板 — OSC 52 在那里是正确路径）。
 * 触发后不等待：失败是静默的，因为 OSC 52 可能已经成功。
 */
function copyNative(text: string): void {
  const opts = { input: text, useCwd: false, timeout: 2000 }
  switch (process.platform) {
    case 'darwin':
      void execFileNoThrow('pbcopy', [], opts)
      return
    case 'linux': {
      if (linuxCopy === null) {
        return
      }
      if (linuxCopy === 'wl-copy') {
        void execFileNoThrow('wl-copy', [], opts)
        return
      }
      if (linuxCopy === 'xclip') {
        void execFileNoThrow('xclip', ['-selection', 'clipboard'], opts)
        return
      }
      if (linuxCopy === 'xsel') {
        void execFileNoThrow('xsel', ['--clipboard', '--input'], opts)
        return
      }
      // 首次调用：探测 wl-copy（Wayland）然后 xclip/xsel（X11），缓存赢家。
      void execFileNoThrow('wl-copy', [], opts).then((r) => {
        if (r.code === 0) {
          linuxCopy = 'wl-copy'
          return
        }
        void execFileNoThrow('xclip', ['-selection', 'clipboard'], opts).then((r2) => {
          if (r2.code === 0) {
            linuxCopy = 'xclip'
            return
          }
          void execFileNoThrow('xsel', ['--clipboard', '--input'], opts).then((r3) => {
            linuxCopy = r3.code === 0 ? 'xsel' : null
          })
        })
      })
      return
    }
    case 'win32':
      // clip.exe 在 Windows 上始终可用。Unicode 处理
      // 不完美（系统区域编码）但作为备选足够。
      void execFileNoThrow('clip', [], opts)
      return
  }
}

/** @internal 仅测试使用 */
export function _resetLinuxCopyCache(): void {
  linuxCopy = undefined
}

/**
 * OSC 命令编号
 */
export let OSC
OSC = {
  SET_TITLE_AND_ICON: 0,
  SET_ICON: 1,
  SET_TITLE: 2,
  SET_COLOR: 4,
  SET_CWD: 7,
  HYPERLINK: 8,
  ITERM2: 9, // iTerm2 proprietary sequences
  SET_FG_COLOR: 10,
  SET_BG_COLOR: 11,
  SET_CURSOR_COLOR: 12,
  CLIPBOARD: 52,
  KITTY: 99, // Kitty notification protocol
  RESET_COLOR: 104,
  RESET_FG_COLOR: 110,
  RESET_BG_COLOR: 111,
  RESET_CURSOR_COLOR: 112,
  SEMANTIC_PROMPT: 133,
  GHOSTTY: 777, // Ghostty notification protocol
  TAB_STATUS: 21337, // Tab status extension
} as const

/**
 * 解析 OSC 序列为动作
 *
 * @param content - 序列内容（不含 ESC ] 和终止符）
 */
export function parseOSC(content: string): Action | null {
  const semicolonIdx = content.indexOf(';')
  const command = semicolonIdx >= 0 ? content.slice(0, semicolonIdx) : content
  const data = semicolonIdx >= 0 ? content.slice(semicolonIdx + 1) : ''

  const commandNum = parseInt(command, 10)

  // 窗口/图标标题
  if (commandNum === OSC.SET_TITLE_AND_ICON) {
    return { type: 'title', action: { type: 'both', title: data } }
  }
  if (commandNum === OSC.SET_ICON) {
    return { type: 'title', action: { type: 'iconName', name: data } }
  }
  if (commandNum === OSC.SET_TITLE) {
    return { type: 'title', action: { type: 'windowTitle', title: data } }
  }

  // 超链接（OSC 8）
  if (commandNum === OSC.HYPERLINK) {
    const parts = data.split(';')
    const paramsStr = parts[0] ?? ''
    const url = parts.slice(1).join(';')

    if (url === '') {
      return { type: 'link', action: { type: 'end' } }
    }

    const params: Record<string, string> = {}
    if (paramsStr) {
      for (const pair of paramsStr.split(':')) {
        const eqIdx = pair.indexOf('=')
        if (eqIdx >= 0) {
          params[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1)
        }
      }
    }

    return {
      type: 'link',
      action: {
        type: 'start',
        url,
        params: Object.keys(params).length > 0 ? params : undefined,
      },
    }
  }

  // 标签状态（OSC 21337）
  if (commandNum === OSC.TAB_STATUS) {
    return { type: 'tabStatus', action: parseTabStatus(data) }
  }

  return { type: 'unknown', sequence: `\x1b]${content}` }
}

/**
 * 将 XParseColor 风格的颜色规范解析为 RGB Color。
 * 接受 `#RRGGBB` 和 `rgb:R/G/B`（每个分量 1-4 个十六进制数字，
 * 缩放到 8 位）。解析失败时返回 null。
 */
export function parseOscColor(spec: string): Color | null {
  const hex = spec.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (hex) {
    return {
      type: 'rgb',
      r: parseInt(hex[1]!, 16),
      g: parseInt(hex[2]!, 16),
      b: parseInt(hex[3]!, 16),
    }
  }
  const rgb = spec.match(/^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i)
  if (rgb) {
    // XParseColor：N 个十六进制数字 → 值 / (16^N - 1)，缩放到 0-255
    const scale = (s: string) => Math.round((parseInt(s, 16) / (16 ** s.length - 1)) * 255)
    return {
      type: 'rgb',
      r: scale(rgb[1]!),
      g: scale(rgb[2]!),
      b: scale(rgb[3]!),
    }
  }
  return null
}

/**
 * 解析 OSC 21337 载荷：`key=value;key=value;...`，值内支持 `\;` 和 `\\`
 * 转义。裸键或 `key=` 清除该字段；未知键被忽略。
 */
function parseTabStatus(data: string): TabStatusAction {
  const action: TabStatusAction = {}
  for (const [key, value] of splitTabStatusPairs(data)) {
    switch (key) {
      case 'indicator':
        action.indicator = value === '' ? null : parseOscColor(value)
        break
      case 'status':
        action.status = value === '' ? null : value
        break
      case 'status-color':
        action.statusColor = value === '' ? null : parseOscColor(value)
        break
    }
  }
  return action
}

/** 分割 `k=v;k=v`，尊重 `\;` 和 `\\` 转义。产出 [key, unescapedValue]。 */
function* splitTabStatusPairs(data: string): Generator<[string, string]> {
  let key = ''
  let val = ''
  let inVal = false
  let esc = false
  for (const c of data) {
    if (esc) {
      if (inVal) {
        val += c
      } else {
        key += c
      }
      esc = false
    } else if (c === '\\') {
      esc = true
    } else if (c === ';') {
      yield [key, val]
      key = ''
      val = ''
      inVal = false
    } else if (c === '=' && !inVal) {
      inVal = true
    } else if (inVal) {
      val += c
    } else {
      key += c
    }
  }
  if (key || inVal) {
    yield [key, val]
  }
}

// 输出生成器

/** 开始超链接（OSC 8）。自动从 URL 派生 id= 参数，
 *  以便终端将同一链接的换行归为一组（规范说明
 *  具有匹配 URI 和非空 id 的单元格会合并；没有 id 时，
 *  每行都是独立的链接 — 悬停行为不一致，工具提示不完整）。
 *  空 url = 结束序列（按规范使用空参数）。 */
export function link(url: string, params?: Record<string, string>): string {
  if (!url) {
    return LINK_END
  }
  const p = { id: osc8Id(url), ...params }
  const paramStr = Object.entries(p)
    .map(([k, v]) => `${k}=${v}`)
    .join(':')
  return osc(OSC.HYPERLINK, paramStr, url)
}

function osc8Id(url: string): string {
  let h = 0
  for (let i = 0; i < url.length; i++) {
    h = ((h << 5) - h + url.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}

/** 结束超链接（OSC 8） */
export let LINK_END
LINK_END = osc(OSC.HYPERLINK, '', '')

// iTerm2 OSC 9 子命令

/** iTerm2 OSC 9 子命令编号 */
export const ITERM2 = {
  NOTIFY: 0,
  BADGE: 2,
  PROGRESS: 4,
} as const

/** 进度操作代码（与 ITERM2.PROGRESS 配合使用） */
export const PROGRESS = {
  CLEAR: 0,
  SET: 1,
  ERROR: 2,
  INDETERMINATE: 3,
} as const

/**
 * 清除 iTerm2 进度条序列（OSC 9;4;0;BEL）
 * 使用 BEL 终止符，因为这是用于清理（而非运行时通知）
 * 且我们希望能确保始终发送，无论终端类型如何。
 */
export const CLEAR_ITERM2_PROGRESS = `${OSC_PREFIX}${OSC.ITERM2};${ITERM2.PROGRESS};${PROGRESS.CLEAR};${BEL}`

/**
 * 清除终端标题序列（OSC 0 带空字符串 + BEL）。
 * 使用 BEL 终止符进行清理 — 在所有终端上安全。
 */
export const CLEAR_TERMINAL_TITLE = `${OSC_PREFIX}${OSC.SET_TITLE_AND_ICON};${BEL}`

/** 清除所有三个 OSC 21337 标签状态字段。在退出时使用。 */
export const CLEAR_TAB_STATUS = osc(OSC.TAB_STATUS, 'indicator=;status=;status-color=')

/**
 * OSC 21337（标签状态指示器）的发射门控。在规范
 * 不稳定期间仅限 Ant。不识别它的终端会静默丢弃，因此
 * 无条件发射是安全的 — 我们不门控终端检测，
 * 因为预计多个终端都会支持。
 *
 * 调用者必须使用 wrapForMultiplexer() 包装输出，以便 tmux/screen
 * DCS 直通将序列传输到外部终端。
 */
export function supportsTabStatus(): boolean {
  return isInternalBuild()
}

/**
 * 发射 OSC 21337 标签状态序列。省略的字段在接收终端中保持不变；
 * `null` 发送空值以清除。
 * 状态文本中的 `;` 和 `\` 按规范转义。
 */
export function tabStatus(fields: TabStatusAction): string {
  const parts: string[] = []
  const rgb = (c: Color) =>
    c.type === 'rgb'
      ? `#${[c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, '0')).join('')}`
      : ''
  if ('indicator' in fields) {
    parts.push(`indicator=${fields.indicator ? rgb(fields.indicator) : ''}`)
  }
  if ('status' in fields) {
    parts.push(`status=${fields.status?.replaceAll('\\', '\\\\').replaceAll(';', '\\;') ?? ''}`)
  }
  if ('statusColor' in fields) {
    parts.push(`status-color=${fields.statusColor ? rgb(fields.statusColor) : ''}`)
  }
  return osc(OSC.TAB_STATUS, parts.join(';'))
}
