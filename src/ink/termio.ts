/**
 * ANSI 解析器模块
 *
 * 一个受 ghostty、tmux 和 iTerm2 启发的语义化 ANSI 转义序列解析器。
 *
 * 主要特性：
 * - 语义化输出：生成结构化的操作，而非字符串标记
 * - 流式处理：可通过 Parser 类逐步解析输入
 * - 样式追踪：在多次解析调用间维护文本样式状态
 * - 全面支持：支持 SGR、CSI、OSC、ESC 序列
 *
 * 用法：
 *
 * ```typescript
 * import { Parser } from './termio.js'
 *
 * const parser = new Parser()
 * const actions = parser.feed('\x1b[31mred\x1b[0m')
 * // => [{ type: 'text', graphemes: [...], style: { fg: { type: 'named', name: 'red' }, ... } }]
 * ```
 */

// 解析器
export { Parser } from './termio/parser.js'
// 类型
export type {
  Action,
  Color,
  CursorAction,
  CursorDirection,
  EraseAction,
  Grapheme,
  LinkAction,
  ModeAction,
  NamedColor,
  ScrollAction,
  TextSegment,
  TextStyle,
  TitleAction,
  UnderlineStyle,
} from './termio/types.js'
export { colorsEqual, defaultStyle, stylesEqual } from './termio/types.js'
