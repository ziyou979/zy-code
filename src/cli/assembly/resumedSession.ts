// 已恢复会话的 launchRepl 装配。
// continue（--continue）和 resumeChooserResolved（--resume / --teleport 已加载数据）
// 两条路径在 launchRepl 调用形态上完全一致：spread sessionConfig +
// processResumedConversation 返回的 ProcessedResume 字段一并喂给 REPLProps。
// 抽出共享 helper 避免维护两份相同的 launchRepl 调用。

import { launchRepl } from '../../cli/replLauncher.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { ProcessedResume } from '../../utils/sessionRestore.js'
import type { AssemblyContext, SessionConfig } from './types.js'
export type ResumedSessionParams = AssemblyContext & {
  sessionConfig: SessionConfig
  resumed: ProcessedResume
  // 当 resumed.restoredAgentDef 为 undefined 时回退到外层 mainThreadAgentDefinition；
  // 与原 root.ts 行为一致（`loaded.restoredAgentDef ?? mainThreadAgentDefinition`）。
  fallbackAgentDefinition: AgentDefinition | undefined
}

export async function launchResumedSessionRepl({
  root,
  appProps,
  renderAndRun,
  sessionConfig,
  resumed,
  fallbackAgentDefinition,
}: ResumedSessionParams): Promise<void> {
  await launchRepl(
    root,
    {
      ...appProps,
      initialState: resumed.initialState,
    },
    {
      ...sessionConfig,
      mainThreadAgentDefinition: resumed.restoredAgentDef ?? fallbackAgentDefinition,
      initialMessages: resumed.messages,
      initialFileHistorySnapshots: resumed.fileHistorySnapshots,
      initialContentReplacements: resumed.contentReplacements,
      initialAgentName: resumed.agentName,
      initialAgentColor: resumed.agentColor,
    },
    renderAndRun,
  )
}
