/**
 * Barrel for hook system types, schemas, and runtime machinery.
 */

// PromptRequest / PromptResponse types live in coreTypes.generated (Prompt section)
// but historical importers reach for them via the hooks barrel — keep the alias.
export type { PromptRequest, PromptResponse } from '../coreTypes.generated.js'
export * from './payloads.js'
export * from './runtime.js'
export * from './schemas.js'
