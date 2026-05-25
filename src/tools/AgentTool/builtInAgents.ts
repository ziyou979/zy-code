import { feature } from 'bun:bundle'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { EXPLORE_AGENT } from './built-in/exploreAgent.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'
import { PLAN_AGENT } from './built-in/planAgent.js'
import { VERIFICATION_AGENT } from './built-in/verificationAgent.js'
import { ZY_CODE_GUIDE_AGENT } from './built-in/zyCodeGuideAgent.js'
import type { AgentDefinition } from './loadAgentsDir.js'

export function areExplorePlanAgentsEnabled(): boolean {
  // 始终启用 Explore/Plan，绕过构建期 feature flag 与 GrowthBook 运行期 flag。
  // 原因：USER_TYPE='external' 构建下无 env/config override 通道，且远端 GrowthBook
  // 对 zy_explore_plan_agent 评估为 false 会覆盖源码默认值。
  return true
}

export function getBuiltInAgents(): AgentDefinition[] {
  // Allow disabling all built-in agents via env var (useful for SDK users who want a blank slate)
  // Only applies in noninteractive mode (SDK/API usage)
  if (
    isEnvTruthy(process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS) &&
    getIsNonInteractiveSession()
  ) {
    return []
  }

  // Use lazy require inside the function body to avoid circular dependency
  // issues at module init time. The coordinatorMode module depends on tools
  // which depend on AgentTool which imports this file.
  if (feature('COORDINATOR_MODE')) {
    if (isEnvTruthy(process.env.ZY_CODE_COORDINATOR_MODE)) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { getCoordinatorAgents } = require('../../coordinator/workerAgent.js')
      /* eslint-enable @typescript-eslint/no-require-imports */
      return getCoordinatorAgents()
    }
  }

  const agents: AgentDefinition[] = [GENERAL_PURPOSE_AGENT]

  if (areExplorePlanAgentsEnabled()) {
    agents.push(EXPLORE_AGENT, PLAN_AGENT)
  }

  // Include Code Guide agent for non-SDK entrypoints
  const isNonSdkEntrypoint =
    process.env.ZY_CODE_ENTRYPOINT !== 'sdk-ts' &&
    process.env.ZY_CODE_ENTRYPOINT !== 'sdk-py' &&
    process.env.ZY_CODE_ENTRYPOINT !== 'sdk-cli'

  if (isNonSdkEntrypoint) {
    agents.push(ZY_CODE_GUIDE_AGENT)
  }

  // 始终启用 verification agent，绕过 feature('VERIFICATION_AGENT')。
  // 原因：dev 模式下 `zycode` 直接 bun 运行源码，未传 --feature 标记，
  // feature() 在运行期恒为 false，必须显式去掉 wrapper 才能生效。
  agents.push(VERIFICATION_AGENT)

  return agents
}
