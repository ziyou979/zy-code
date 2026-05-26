import type { ToolUseContext } from '../../Tool.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js'
import { buildRenameSystemReminder, performRename } from './performRename.js'

/**
 * /rename 的交互（local-jsx）入口：在 Ink REPL 里执行。
 *
 * 与 local 变体的差异：
 * - 通过 onDone 把消息塞进 REPL 的系统消息流（用户在终端里看到一行"Session renamed to: X"）
 * - 仅当用户显式命名（非 LLM 生成）时，把 SystemReminder 注入 metaMessages，
 *   让下一次模型调用知道用户的新框架视角；生成式命名不注入，避免回环。
 */
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
  args: string,
): Promise<null> {
  const { message, newName, isGenerated } = await performRename(args, context)

  const metaMessages =
    newName && !isGenerated ? [buildRenameSystemReminder(newName)] : undefined

  onDone(message, { display: 'system', metaMessages })
  return null
}
