import type { LocalCommandCall } from '../../types/command.js'
import { performRename } from './performRename.js'

/**
 * /rename 的非交互（local）入口：用于 `zy -p "/rename foo"`、
 * SDK control_request、headless / CI 脚本 等没有 Ink REPL 的场景。
 *
 * 与 local-jsx 变体的差异：
 * - 不依赖 React/Ink，不能 onDone（也没消息流可注入 metaMessages）
 * - 直接返回 `{ type: 'text', value }`，由命令派发器把文本写到 stdout / SDK 响应
 *
 * 注意：local 变体此处**不**注入 SystemReminder。原因是非交互模式通常一次性出参就退出，
 * 没有"下一轮模型调用"会读到这条 reminder；交互模式下才有意义。
 */
export const call: LocalCommandCall = async (args, context) => {
  const { message } = await performRename(args, context)
  return { type: 'text', value: message }
}
