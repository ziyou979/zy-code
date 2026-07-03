import figuresLib from 'figures'
import { env } from '../utils/env.js'

// VS15 —— 强制文本展示（黑白字形），避免部分终端 / 系统把符号渲染为彩色 emoji。
// 注意：VS15 会改变模糊宽度字符的终端列宽（emoji=2列, text=1列），
// 因此只加在确实可能渲染为 emoji 的符号上（播放按钮、旗帜等），
// 纯几何/数学/箭头/制表符不添加，避免破坏对齐。
const VS15 = '\uFE0E'

// The former is better vertically aligned, but isn't usually supported on Windows/Linux
// darwin 用 ⏺（U+23FA）可能渲染为 emoji，故保留 VS15；其他平台用 ●（U+25CF）纯几何符号无需 VS15
export const BLACK_CIRCLE = env.platform === 'darwin' ? '\u23fa' + VS15 : '\u25cf'
export const BULLET_OPERATOR = '\u2219' // ∙
export const TEARDROP_ASTERISK = '\u273b' // ✻
export const BRAILLE_Z = '\u28dd' // ⣝ - 类似 z 形的盲文符号
export const UP_ARROW = '\u2191' // ↑ - used for opus 1m merge notice
export const DOWN_ARROW = '\u2193' // ↓ - used for scroll hint
export const EFFORT_OFF = '\u2298' // ⊘ - 思考强度 off 档 (thinking disabled)
export const EFFORT_ON = '\u25d1' // ◑ - 思考强度 on 档(thinking enabled, toggle mode)
export const EFFORT_QUICK = '\u25cb' // ○ - 思考强度 quick 档
export const EFFORT_LIGHT = '\u25d4' // ◔ - 思考强度 light 档
export const EFFORT_BALANCED = '\u25d1' // ◑ - 思考强度 balanced 档
export const EFFORT_THOROUGH = '\u25d5' // ◕ - 思考强度 thorough 档
export const EFFORT_EXTREME = '\u25cf' // ● - 思考强度 extreme 档
export const EFFORT_ULTRA = '\u25c9' // ◉ - 思考强度 ultra 档(max thinking + preserve)

// Media/trigger status indicators
export const PLAY_ICON = '\u23f5' + VS15 // ⏵
export const REVERSE_PLAY_ICON = '\u25c0' + VS15 // ◀
export const PAUSE_ICON = '\u23f8' + VS15 // ⏸
export const FAST_FORWARD_ICON = '\u23e9' + VS15 // ⏩

// MCP subscription indicators
export const REFRESH_ARROW = '\u21bb' // ↻ - used for resource update indicator
export const CHANNEL_ARROW = '\u2190' // ← - inbound channel message indicator
export const INJECTED_ARROW = '\u2192' // → - cross-session injected message indicator
export const FORK_GLYPH = '\u2442' // ⑂ - fork directive indicator

// Review status indicators (ultrareview diamond states)
export const DIAMOND_OPEN = '\u25c7' // ◇ - running
export const DIAMOND_FILLED = '\u25c6' // ◆ - completed/failed
export const REFERENCE_MARK = '\u203b' // ※ - komejirushi, away-summary recap marker

// Issue flag indicator (U+2691 ⚑ 部分终端渲染为 emoji，保留 VS15)
export const FLAG_ICON = '\u2691' + VS15 // ⚑ - used for issue flag banner

// Blockquote indicator
export const BLOCKQUOTE_BAR = '\u258e' // ▎ - left one-quarter block, used as blockquote line prefix
export const HEAVY_HORIZONTAL = '\u2501' // ━ - heavy box-drawing horizontal

// Bridge status indicators
export const BRIDGE_SPINNER_FRAMES = [
  '\u00b7|\u00b7',
  '\u00b7/\u00b7',
  '\u00b7\u2014\u00b7',
  '\u00b7\\\u00b7',
]
export const BRIDGE_READY_INDICATOR = '\u00b7\u2714' + VS15 + '\u00b7'
export const BRIDGE_FAILED_INDICATOR = '\u00d7'

// figures 库输出作为 fig 对象导出。
// 部分字符在特定终端会渲染为彩色 emoji，已单独追加 `\uFE0E`（VS15）强制文本展示。
// 注意：VS15 会改变模糊宽度字符的终端列宽（emoji=2列, text=1列），
// 对齐敏感位置（列表指针、导航箭头等）不要滥用。
// 使用方：`import { fig } from '../constants/figures.js'`
export const fig = {
  arrowDown: figuresLib.arrowDown,
  arrowLeft: figuresLib.arrowLeft,
  arrowRight: figuresLib.arrowRight,
  arrowUp: figuresLib.arrowUp,
  bullet: figuresLib.bullet,
  checkboxOff: figuresLib.checkboxOff,
  checkboxOn: figuresLib.checkboxOn,
  circle: figuresLib.circle,
  circleDouble: figuresLib.circleDouble,
  circleFilled: figuresLib.circleFilled,
  cross: figuresLib.cross,
  ellipsis: figuresLib.ellipsis,
  info: figuresLib.info,
  lineUpDownRight: figuresLib.lineUpDownRight, // box drawing，无需 VS15
  lineUpRight: figuresLib.lineUpRight,
  lineVertical: figuresLib.lineVertical,
  play: figuresLib.play,
  pointer: figuresLib.pointer,
  pointerSmall: figuresLib.pointerSmall,
  questionMarkPrefix: figuresLib.questionMarkPrefix,
  radioOff: figuresLib.radioOff,
  radioOn: figuresLib.radioOn,
  squareSmall: figuresLib.squareSmall,
  squareSmallFilled: figuresLib.squareSmallFilled,
  star: figuresLib.star,
  tick: figuresLib.tick,
  triangleDownSmall: figuresLib.triangleDownSmall,
  triangleRightSmall: figuresLib.triangleRightSmall,
  triangleUpOutline: figuresLib.triangleUpOutline,
  warning: figuresLib.warning,
}

// 状态圆圈（纯 emoji，VS15 可能无效但无妨）
export const GREEN_CIRCLE = '\u{1F7E2}' + VS15 // 🟢
export const YELLOW_CIRCLE = '\u{1F7E1}' + VS15 // 🟡
export const RED_CIRCLE = '\u{1F534}' + VS15 // 🔴
export const WHITE_SQUARE = '\u2B1C' + VS15 // ⬜

// 通用小三角指示符（纯几何符号，无需 VS15）
export const SMALL_RIGHT_TRIANGLE = '\u25B8' // ▸

// 刷新 / 重试图标（U+27F3 箭头，无需 VS15）
export const CLOCKWISE_ARROWS = '\u27F3' // ⟳

// 复选框占位（U+2610 纯文本符号，无需 VS15）
export const BALLOT_BOX = '\u2610' // ☐

// 机器人头像（纯 emoji，保留 VS15）
export const ROBOT = '\u{1F916}' + VS15 // 🤖
