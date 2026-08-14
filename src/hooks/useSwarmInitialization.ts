/**
 * Swarm 初始化 hook
 *
 * 初始化 swarm 功能，包括 teammate hook 和 context。
 * 同时处理全新 spawn 和恢复的 teammate 会话。
 *
 * 此 hook 按条件加载，使 swarm 禁用时能够进行 dead code elimination。
 */

import { useEffect } from 'react'
import { getSessionId } from 'src/bootstrap/runtime/runtimeContext.js'
import { initializeTeammateContextFromSession } from '../services/swarm/reconnection.js'
import { readTeamFile } from '../services/swarm/teamHelpers.js'
import { initializeTeammateHooks } from '../services/swarm/teammateInit.js'
import type { AppState } from '../state/AppStateStore.js'
import type { Message } from '../types/message.js'
import { isAgentSwarmsEnabled } from '../services/swarm/agentSwarmsEnabled.js'
import { getDynamicTeamContext } from '../services/swarm/teammate.js'

type SetAppState = (f: (prevState: AppState) => AppState) => void

/**
 * ENABLE_AGENT_SWARMS 为 true 时初始化 swarm 功能的 hook。
 *
 * 同时处理：
 * - 通过 --resume 或 /resume 恢复的 teammate 会话，其 teamName/agentName 存在 transcript 消息中
 * - 从环境变量读取 context 的全新 spawn
 */
export function useSwarmInitialization(
  setAppState: SetAppState,
  initialMessages: Message[] | undefined,
  { enabled = true }: { enabled?: boolean } = {},
): void {
  useEffect(() => {
    if (!enabled) {
      return
    }
    if (isAgentSwarmsEnabled()) {
      // 检查是否为通过 --resume 或 /resume 恢复的 agent 会话；
      // 恢复的会话会在 transcript 消息中保存 teamName/agentName
      const firstMessage = initialMessages?.[0]
      const teamName =
        firstMessage && 'teamName' in firstMessage
          ? (firstMessage.teamName as string | undefined)
          : undefined
      const agentName =
        firstMessage && 'agentName' in firstMessage
          ? (firstMessage.agentName as string | undefined)
          : undefined

      if (teamName && agentName) {
        // 恢复的 agent 会话：根据存储的信息设置 team context
        initializeTeammateContextFromSession(setAppState, teamName, agentName)

        // 从 team 文件获取 agentId，用于初始化 hook
        const teamFile = readTeamFile(teamName)
        const member = teamFile?.members.find((m: { name: string }) => m.name === agentName)
        if (member) {
          initializeTeammateHooks(setAppState, getSessionId(), {
            teamName,
            agentId: member.agentId,
            agentName,
          })
        }
      } else {
        // 全新 spawn 或独立会话。teamContext 已在 main.tsx 中通过
        // computeInitialTeamContext() 计算并放入 initialState，此处只需初始化 hook
        const context = getDynamicTeamContext?.()
        if (context?.teamName && context?.agentId && context?.agentName) {
          initializeTeammateHooks(setAppState, getSessionId(), {
            teamName: context.teamName,
            agentId: context.agentId,
            agentName: context.agentName,
          })
        }
      }
    }
  }, [setAppState, initialMessages, enabled])
}
