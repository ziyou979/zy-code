import { SHOW_CURSOR } from '../../ink/termio/dec.js'

/**
 * 在退出前向 TTY 写入 SHOW_CURSOR，避免 Ink 渲染异常退出时光标残缺。
 */
export function resetCursor(): void {
  const terminal = process.stderr.isTTY
    ? process.stderr
    : process.stdout.isTTY
      ? process.stdout
      : undefined
  terminal?.write(SHOW_CURSOR)
}
