import { randomUUID } from 'node:crypto'
import { queryModelWithStreaming } from '../services/api/llmOrchestrator.js'
import { autoCompactIfNeeded } from '../services/compact/autoCompact.js'
import { microcompactMessages } from '../services/compact/microCompact.js'

// query() 的 I/O 依赖。通过 QueryParams 注入 deps 覆盖，
// 测试可直接注入 fake 而无需 spyOn-per-module 模板代码。
// 使用 `typeof fn` 保持签名与真实实现自动同步。
export type QueryDeps = {
  callModel: typeof queryModelWithStreaming
  microcompact: typeof microcompactMessages
  autocompact: typeof autoCompactIfNeeded
  uuid: () => string
}

export function productionDeps(): QueryDeps {
  return {
    callModel: queryModelWithStreaming,
    microcompact: microcompactMessages,
    autocompact: autoCompactIfNeeded,
    uuid: randomUUID,
  }
}
