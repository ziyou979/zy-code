import { randomUUID } from 'node:crypto'
import { queryModelWithStreaming } from '../services/api/llmOrchestrator.js'
import { autoCompactIfNeeded } from '../services/compact/autoCompact.js'
import { microcompactMessages } from '../services/compact/microCompact.js'
import { autoCompactIfNeededV2 } from '../services/compact/v2/autoCompact.js'
import { isEnvTruthy } from '../utils/envUtils.js'

// -- deps

// I/O dependencies for query(). Passing a `deps` override into QueryParams
// lets tests inject fakes directly instead of spyOn-per-module — the most
// common mocks (callModel, autocompact) are each spied in 6-8 test files
// today with module-import-and-spy boilerplate.
//
// Using `typeof fn` keeps signatures in sync with the real implementations
// automatically. This file imports the real functions for both typing and
// the production factory — tests that import this file for typing are
// already importing query.ts (which imports everything), so there's no
// new module-graph cost.
//
// Scope is intentionally narrow (4 deps) to prove the pattern. Followup
// PRs can add runTools, handleStopHooks, logEvent, queue ops, etc.
export type QueryDeps = {
  // -- model
  callModel: typeof queryModelWithStreaming

  // -- compaction
  microcompact: typeof microcompactMessages
  autocompact: typeof autoCompactIfNeeded

  // -- platform
  uuid: () => string
}

/**
 * 选择 autocompact 实现：ZY_COMPACT_V2=1 走 v2（含 P0 系列优化，见
 * docs/zy-code-compact-optimization-plan.md），否则走 v1。v2 返回类型多一个
 * 可选字段 rapidRefillBreakerTripped，调用方通过结构性兼容自动忽略。
 */
function pickAutocompact(): typeof autoCompactIfNeeded {
  if (isEnvTruthy(process.env.ZY_COMPACT_V2)) {
    return autoCompactIfNeededV2 as typeof autoCompactIfNeeded
  }
  return autoCompactIfNeeded
}

export function productionDeps(): QueryDeps {
  return {
    callModel: queryModelWithStreaming,
    microcompact: microcompactMessages,
    autocompact: pickAutocompact(),
    uuid: randomUUID,
  }
}
