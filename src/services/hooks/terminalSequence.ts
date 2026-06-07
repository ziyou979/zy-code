/**
 * hook 输出 terminalSequence 的白名单校验。
 *
 * 允许 hook 直接发桌面通知/响铃/窗口标题/进度，而无需持有 TTY。由 zy-code 主进程
 * 在安全位置写入 stdout。出于安全，只放行「不破坏渲染」的 OSC 序列，**禁止 CSI**
 * （光标移动、SGR、清屏等会破坏 Ink 渲染）。
 *
 * 放行：
 *   - 响铃             \x07 (BEL)
 *   - 窗口标题         OSC 0; <text> (BEL|ST)        \x1b]0;...\x07
 *   - 桌面通知         OSC 9; <text> (BEL|ST)        \x1b]9;...\x07
 *   - 进度条           OSC 9;4; <text> (BEL|ST)      （由 OSC 9 文本部分覆盖）
 *
 * 字符串可由多个允许的 token 拼接；出现任何非白名单内容（如 CSI \x1b[）则整体拒绝。
 */

// 单个允许 token：BEL，或 OSC 0/9 序列（文本不含 ESC/BEL，故无法夹带 CSI），以 BEL 或 ST 结尾。
// eslint-disable-next-line no-control-regex
const ALLOWED_TOKEN = /\x07|\x1b\][09];[^\x07\x1b]*(?:\x07|\x1b\\)/g

/**
 * 校验并返回安全的 terminalSequence；含任何非白名单内容则返回 undefined（丢弃）。
 */
export function validateTerminalSequence(seq: string | undefined): string | undefined {
  if (!seq) {
    return undefined
  }
  const remainder = seq.replace(ALLOWED_TOKEN, '')
  return remainder === '' ? seq : undefined
}
