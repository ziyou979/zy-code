import { getSessionId } from '../bootstrap/state.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import type { SessionId } from '../types/ids.js'
import { isEnvTruthy, isInternalBuild } from '../utils/envUtils.js'

// 在 query() 入口处一次性快照的不可变值。
// 与每次迭代的 State 和可变的 ToolUseContext 分离，便于后续提取为纯 reducer。
// 不包含 feature() 门控 — 它们是 tree-shaking 边界，必须留在被保护的代码块内联。
export type QueryConfig = {
  sessionId: SessionId

  // 运行时门控（env/statsig），不是 feature() 门控。
  gates: {
    // CACHED_MAY_BE_STALE 已声明可能过期，每次 query() 快照一次符合契约。
    streamingToolExecution: boolean
    emitToolUseSummaries: boolean
    isAnt: boolean
  }
}

export function buildQueryConfig(): QueryConfig {
  return {
    sessionId: getSessionId(),
    gates: {
      streamingToolExecution: checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
        'zy_streaming_tool_execution2',
      ),
      emitToolUseSummaries: isEnvTruthy(process.env.ZY_CODE_EMIT_TOOL_USE_SUMMARIES),
      isAnt: isInternalBuild(),
    },
  }
}
