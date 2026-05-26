/**
 * Barrel for hook system types, schemas, and runtime machinery.
 */

export * from './payloads.js'
export * from './schemas.js'
export * from './runtime.js'
// PromptRequest / PromptResponse types live in coreTypes.generated (Prompt section)
// but historical importers reach for them via the hooks barrel — keep the alias.
export type { PromptRequest, PromptResponse } from '../coreTypes.generated.js'
