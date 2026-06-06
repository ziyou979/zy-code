import { randomUUID } from 'node:crypto'
import { queryModelWithStreaming } from '../services/api/llmOrchestrator.js'
import { autoCompactIfNeeded } from '../services/compact/autoCompact.js'
import { microcompactMessages } from '../services/compact/microCompact.js'
import { autoCompactIfNeededV2 } from '../services/compact/v2/autoCompact.js'
import { isEnvTruthy } from '../utils/envUtils.js'

// query() 的 I/O 依赖。通过 QueryParams 注入 deps 覆盖，
// 测试可直接注入 fake 而无需 spyOn-per-module 模板代码。
// 使用 `typeof fn` 保持签名与真实实现自动同步。
export type QueryDeps = {
  callModel: typeof queryModelWithStreaming
  microcompact: typeof microcompactMessages
  autocompact: typeof autoCompactIfNeeded
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
