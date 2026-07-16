import * as React from 'react'
import { AgentSessionView } from '../../components/agents/AgentSessionView.js'
import { AgentsMenu } from '../../components/agents/AgentsMenu.js'
import type { ToolUseContext } from '../../tools/Tool.js'
import { getTools } from '../../tools/tools.js'
import type { LocalJSXCommandOnDone } from '../types.js'
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext,
  args: string,
): Promise<React.ReactNode> {
  const trimmedArgs = args.trim().toLowerCase()

  // /agents view — 运行时会话概览（Agent View）
  if (trimmedArgs === 'view' || trimmedArgs === 'sessions') {
    return (
      <AgentSessionView
        appState={context.getAppState()}
        setAppState={context.setAppState}
        onExit={onDone}
      />
    )
  }

  // 默认：Agent 定义管理菜单
  const appState = context.getAppState()
  const permissionContext = appState.toolPermissionContext
  const tools = getTools(permissionContext)
  return <AgentsMenu tools={tools} onExit={onDone} />
}
