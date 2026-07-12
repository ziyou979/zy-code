import figuresLib from 'figures'
import { env } from '../utils/env.js'

// VS15 —— 强制文本展示（黑白字形），避免部分终端 / 系统把符号渲染为彩色 emoji。
// 注意：VS15 会改变模糊宽度字符的终端列宽（emoji=2列, text=1列），
// 因此只加在确实可能渲染为 emoji 的符号上（播放按钮、旗帜等），
// 纯几何/数学/箭头/制表符不添加，避免破坏对齐。
const VS15 = '\uFE0E'

// ── figures 库符号（按终端平台自适应）──────────────────────
export const ARROW_DOWN = figuresLib.arrowDown
export const ARROW_LEFT = figuresLib.arrowLeft
export const ARROW_RIGHT = figuresLib.arrowRight
export const ARROW_UP = figuresLib.arrowUp
export const BULLET = figuresLib.bullet
export const CHECKBOX_OFF = figuresLib.checkboxOff
export const CHECKBOX_ON = figuresLib.checkboxOn
export const CIRCLE = figuresLib.circle // ◯ — 不兼容某些终端，优先用 RADIO_OFF
export const CIRCLE_DOUBLE = figuresLib.circleDouble
export const CIRCLE_FILLED = figuresLib.circleFilled // ●
export const CROSS = figuresLib.cross
export const ELLIPSIS = figuresLib.ellipsis
export const INFO = figuresLib.info
export const LINE_UP_DOWN_RIGHT = figuresLib.lineUpDownRight
export const LINE_UP_RIGHT = figuresLib.lineUpRight
export const LINE_VERTICAL = figuresLib.lineVertical
export const PLAY = figuresLib.play
export const POINTER = figuresLib.pointer
export const POINTER_SMALL = figuresLib.pointerSmall
export const QUESTION_MARK = figuresLib.questionMarkPrefix
export const RADIO_OFF = figuresLib.radioOff // ○ — 终端兼容性好，替代 CIRCLE
export const RADIO_ON = figuresLib.radioOn // ◉
export const SQUARE_SMALL = figuresLib.squareSmall
export const SQUARE_SMALL_FILLED = figuresLib.squareSmallFilled
export const STAR = figuresLib.star
export const TICK = figuresLib.tick
export const TRIANGLE_DOWN = figuresLib.triangleDownSmall
export const TRIANGLE_RIGHT = figuresLib.triangleRightSmall
export const TRIANGLE_UP_OUTLINE = figuresLib.triangleUpOutline
export const WARNING = figuresLib.warning

// ── 几何与箭头符号 ────────────────────────────────────────
// darwin 用 ⏺（U+23FA）可能渲染为 emoji，故保留 VS15；其他平台用 ● 纯几何符号无需 VS15
export const BLACK_CIRCLE = env.platform === 'darwin' ? '\u23fa' + VS15 : '\u25cf'
export const BULLET_OPERATOR = '\u2219' // ∙
export const TITLE_TAB = '\u2733'
export const TEARDROP_ASTERISK = '\u273b' // ✻
export const BRAILLE_Z = '\u28dd' // ⣝ 类似 z 形的盲文符号
export const UP_ARROW = '\u2191' // ↑
export const DOWN_ARROW = '\u2193' // ↓
export const SMALL_RIGHT_TRIANGLE = '\u25B8' // ▸
export const DIAMOND_OPEN = '\u25c7' // ◇
export const DIAMOND_FILLED = '\u25c6' // ◆
export const REFERENCE_MARK = '\u203b' // ※ komejirushi

// ── Effort 符号（按填充度渐进命名）────────────────────────
// ⊘ → ◔ → ◑ → ◕ 为 Effort 专用符号，在 figures 库中不存在。
// ○ / ● / ◉ 与 RADIO_OFF / CIRCLE_FILLED / RADIO_ON 共用，
// Effort 上下文直接引用 common 区的导出，避免重复定义。
export const SLASHED_CIRCLE = '\u2298' // ⊘
export const CIRCLE_RIGHT_HALF = '\u25d1' // ◑
export const CIRCLE_UPPER_RIGHT = '\u25d4' // ◔
export const CIRCLE_ALL_BUT_UPPER_LEFT = '\u25d5' // ◕

// ── Media / trigger ────────────────────────────────────────
export const PLAY_ICON = '\u23f5' + VS15 // ⏵
export const REVERSE_PLAY_ICON = '\u25c0' + VS15 // ◀
export const PAUSE_ICON = '\u23f8' + VS15 // ⏸
export const FAST_FORWARD_ICON = '\u23e9' + VS15 // ⏩

// ── MCP ────────────────────────────────────────────────────
export const REFRESH_ARROW = '\u21bb' // ↻
export const CHANNEL_ARROW = '\u2190' // ←
export const INJECTED_ARROW = '\u2192' // →
export const FORK_GLYPH = '\u2442' // ⑂

// ── Flags ──────────────────────────────────────────────────
export const FLAG_ICON = '\u2691' + VS15 // ⚑

// ── Blockquote ─────────────────────────────────────────────
export const BLOCKQUOTE_BAR = '\u258e' // ▎
export const HEAVY_HORIZONTAL = '\u2501' // ━

// ── Bridge ─────────────────────────────────────────────────
export const BRIDGE_SPINNER_FRAMES = [
  '\u00b7|\u00b7',
  '\u00b7/\u00b7',
  '\u00b7\u2014\u00b7',
  '\u00b7\\\u00b7',
]
export const BRIDGE_READY_INDICATOR = '\u00b7\u2714' + VS15 + '\u00b7'
export const BRIDGE_FAILED_INDICATOR = '\u00d7'

// ── Status circles (emoji) ─────────────────────────────────
export const GREEN_CIRCLE = '\u{1F7E2}' // 🟢
export const YELLOW_CIRCLE = '\u{1F7E1}' // 🟡
export const RED_CIRCLE = '\u{1F534}' // 🔴
export const WHITE_SQUARE = '\u2B1C' // ⬜

// ── Checkboxes ─────────────────────────────────────────────
export const BALLOT_BOX = '\u2610' // ☐ (= CHECKBOX_OFF)
export const CHECKBOX_CHECKED = '\u2611' // ☑ — ballot box with check

// ── Refresh / retry ────────────────────────────────────────
export const CLOCKWISE_ARROWS = '\u27F3' // ⟳

// ── Terminal title animation ───────────────────────────────
export const TITLE_FRAME_A = '\u2802' // ⠂
export const TITLE_FRAME_B = '\u2810' // ⠐
