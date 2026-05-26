/**
 * Top-level barrel for src/types/.
 *
 * Aggregates the high-frequency type/schema exports so most importers can
 * pull from `'src/types'` (or `'../types'`) directly instead of digging
 * through individual sub-modules. Domain-specific files are still exported
 * verbatim for callers that prefer the explicit path.
 */

// Sandbox types (live in src/entrypoints/ for historical reasons)
export type {
  SandboxFilesystemConfig,
  SandboxIgnoreViolations,
  SandboxNetworkConfig,
  SandboxSettings,
} from '../entrypoints/sandboxTypes.js'

// Bridge wire/IPC protocol (messages + control)
export * from './bridge/index.js'

// Hook system (payloads + schemas + runtime)
export * from './hooks/index.js'

// Cron / scheduler types
export * from './scheduler.js'

// Remote-control bridge types
export * from './remoteControl.js'

// Generated types (the rest — usage/model/output/config/mcp/permission/prompt/skill/agent/settings/rewind)
export * from './coreTypes.generated.js'

// Core schemas (still a single file for the non-bridge/non-hook sections)
export * from './coreSchemas.js'
