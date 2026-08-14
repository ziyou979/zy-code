/**
 * bash 命令首行为 `# comment`（而非 `#!` shebang）时，
 * 返回移除 `#` 前缀的注释文本；否则返回 undefined。
 *
 * 全屏模式下，它同时用作非 verbose Tool 调用标签和 collapse-group ⎿ 提示，
 * 即 ZY 专门写给用户阅读的内容。
 */
export function extractBashCommentLabel(command: string): string | undefined {
  const nl = command.indexOf('\n')
  const firstLine = (nl === -1 ? command : command.slice(0, nl)).trim()
  if (!firstLine.startsWith('#') || firstLine.startsWith('#!')) {
    return undefined
  }
  return firstLine.replace(/^#+\s*/, '') || undefined
}
