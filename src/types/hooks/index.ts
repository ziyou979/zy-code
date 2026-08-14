/**
 * hook 系统类型、schema 和运行时机制的统一导出口。
 */

// PromptRequest / PromptResponse 类型位于 coreTypes.generated 的 Prompt 部分，
// 但历史调用方会从 hooks 统一出口引用，因此保留别名。
export type { PromptRequest, PromptResponse } from '../coreTypes.generated.js'
export * from './payloads.js'
export * from './promptSchemas.js'
export * from './runtime.js'
export * from './schemas.js'
