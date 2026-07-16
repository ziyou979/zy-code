/**
 * 测量字符串的视觉宽度，正确处理 CJK 字符、emoji 和 ANSI 转义码。
 *
 * 纯函数 - 从 `ink/stringWidth.ts` 转发。
 * 供 services/ 层引用以避免层间违规。
 */
export { stringWidth } from '../ink/stringWidth.js'
