/**
 * 独立 Agent 实用工具，用于具有自定义名称/颜色的会话
 *
 * 这些辅助函数提供对独立 Agent 上下文（名称和颜色）的访问，
 * 适用于不属于蜂群团队的会话。当会话属于蜂群时，
 * 这些函数返回 undefined，让蜂群上下文优先。
 */

import type { AppState } from '../../state/AppStateStore.js'
import { getTeamName } from '../swarm/teammate.js'

/**
 * 如果已设置且不是蜂群队友，返回独立 Agent 名称。
 * 使用 getTeamName() 以与 isTeammate() 蜂群检测保持一致。
 */
export function getStandaloneAgentName(appState: AppState): string | undefined {
  // 若在团队中（蜂群），不返回独立名称
  if (getTeamName()) {
    return undefined
  }
  return appState.standaloneAgentContext?.name
}
