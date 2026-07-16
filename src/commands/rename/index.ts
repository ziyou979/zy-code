import type { Command } from '../../commands/index.js'

/**
 * /rename 的交互变体（默认导出）。
 * 由 Ink REPL 直接派发：onDone 回写到消息流，并可注入 SystemReminder。
 */
const rename = {
  type: 'local-jsx',
  name: 'rename',
  aliases: ['name'],
  description: 'Rename the current conversation',
  immediate: true,
  argumentHint: '[name]',
  load: () => import('./rename.js'),
} satisfies Command

/**
 * /rename 的非交互变体（命名导出）。
 * 同名注册，commands.ts 把它放在交互变体之后；交互模式下 findCommand 命中前者，
 * `zy -p` / headless 模式经 `command.type === 'local' && supportsNonInteractive`
 * 过滤后只剩本变体，从而让 `/rename` 在 SDK / 脚本场景也能用。
 */
export const renameLocal = {
  type: 'local',
  name: 'rename',
  aliases: ['name'],
  supportsNonInteractive: true,
  // 仅需在非交互过滤后生效，交互模式下隐藏避免重复呈现
  isHidden: true,
  description: 'Rename the current conversation',
  argumentHint: '[name]',
  load: () => import('./renameLocal.js'),
} satisfies Command

export default rename
