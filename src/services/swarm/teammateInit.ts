/**
 * 队友初始化模块
 *
 * 处理作为 swarm 中队友运行的 ZY Code 实例的初始化。
 * 注册 Stop 钩子，在队友空闲时通知团队 leader。
 */

import type { AppState } from '../../state/AppStateStore.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { addFunctionHook } from '../hooks/sessionHooks.js'
import { applyPermissionUpdate } from '../permissions/permissionUpdate.js'
import { jsonStringify } from '../../services/infra/slowOperations.js'
import { getTeammateColor } from './teammate.js'
import { createIdleNotification } from '../../services/swarm/teammateMailboxMessages.js'
import { getLastPeerDmSummary, writeToMailbox } from '../../services/swarm/teammateMailbox.js'
import { readTeamFile, setMemberActive } from './teamHelpers.js'

/**
 * 为 swarm 中运行的队友初始化钩子。
 * 应在会话启动早期、AppState 可用后调用。
 *
 * 注册 Stop 钩子，在此队友的会话停止时向团队 leader 发送空闲通知。
 */
export function initializeTeammateHooks(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  teamInfo: { teamName: string; agentId: string; agentName: string },
): void {
  const { teamName, agentId, agentName } = teamInfo

  // 读取团队文件以获取 leader ID
  const teamFile = readTeamFile(teamName)
  if (!teamFile) {
    logForDebugging(`[TeammateInit] Team file not found for team: ${teamName}`)
    return
  }

  const leadAgentId = teamFile.leadAgentId

  // 如果存在团队级别的允许路径则应用
  if (teamFile.teamAllowedPaths && teamFile.teamAllowedPaths.length > 0) {
    logForDebugging(
      `[TeammateInit] Found ${teamFile.teamAllowedPaths.length} team-wide allowed path(s)`,
    )

    for (const allowedPath of teamFile.teamAllowedPaths) {
      // 对于绝对路径（以 / 开头），前面加一个 / 以创建 //path/** 模式
      // 对于相对路径，直接使用 path/**
      const ruleContent = allowedPath.path.startsWith('/')
        ? `/${allowedPath.path}/**`
        : `${allowedPath.path}/**`

      logForDebugging(
        `[TeammateInit] Applying team permission: ${allowedPath.toolName} allowed in ${allowedPath.path} (rule: ${ruleContent})`,
      )

      setAppState((prev) => ({
        ...prev,
        toolPermissionContext: applyPermissionUpdate(prev.toolPermissionContext, {
          type: 'addRules',
          rules: [
            {
              toolName: allowedPath.toolName,
              ruleContent,
            },
          ],
          behavior: 'allow',
          destination: 'session',
        }),
      }))
    }
  }

  // 从成员数组中查找 leader 的名称
  const leadMember = teamFile.members.find((m) => m.agentId === leadAgentId)
  const leadAgentName = leadMember?.name || 'team-lead'

  // 如果当前 agent 是 leader 则不注册钩子
  if (agentId === leadAgentId) {
    logForDebugging(
      '[TeammateInit] This agent is the team leader - skipping idle notification hook',
    )
    return
  }

  logForDebugging(
    `[TeammateInit] Registering Stop hook for teammate ${agentName} to notify leader ${leadAgentName}`,
  )

  // 注册 Stop 钩子，在此队友停止时通知 leader
  addFunctionHook(
    setAppState,
    sessionId,
    'Stop',
    '', // 无匹配器 - 适用于所有 Stop 事件
    async (messages, _signal) => {
      // 在团队配置中将此队友标记为空闲（即发即忘）
      void setMemberActive(teamName, agentName, false)

      // 使用 agent 名称（而非 UUID）向团队 leader 发送空闲通知
      // 必须 await 以确保写入在进程关闭前完成
      const notification = createIdleNotification(agentName, {
        idleReason: 'available',
        summary: getLastPeerDmSummary(messages),
      })
      await writeToMailbox(leadAgentName, {
        from: agentName,
        text: jsonStringify(notification),
        timestamp: new Date().toISOString(),
        color: getTeammateColor(),
      })
      logForDebugging(`[TeammateInit] Sent idle notification to leader ${leadAgentName}`)
      return true // 不阻塞 Stop
    },
    'Failed to send idle notification to team leader',
    {
      timeout: 10000,
    },
  )
}
