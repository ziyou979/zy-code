import type { AssistantMessage } from '../../types/message.js'

/** 模板功能关闭时保留稳定的分类调用接口。 */
export async function classifyAndWriteState(
  _jobDir: string | undefined,
  _messages: AssistantMessage[],
): Promise<void> {
  // 当前发行版未启用模板状态写入。
}
