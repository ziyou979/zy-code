import {
  getModelStrings as getModelStringsState,
  setModelStrings as setModelStringsState,
} from 'src/bootstrap/runtime/runtimeContext.js'
import { getInitialSettings } from '../settings/settings.js'

/**
 * User-configured mapping from canonical model ID to provider-specific model ID.
 * Derived entirely from `settings.modelOverrides`.
 */
export type ModelStrings = Record<string, string>

function getModelOverrides(): ModelStrings {
  try {
    return getInitialSettings().modelOverrides ?? {}
  } catch {
    return {}
  }
}

function initModelStrings(): ModelStrings {
  const overrides = getModelOverrides()
  setModelStringsState(overrides)
  return overrides
}

/**
 * Get the current model overrides map (canonical model ID -> provider-specific model ID).
 * Safe to call during module init.
 */
export function getModelStrings(): ModelStrings {
  const ms = getModelStringsState()
  if (ms === null) {
    return initModelStrings()
  }
  return ms
}

/**
 * Ensure model strings are initialized.
 * Retained for callers that currently await it.
 */
export async function ensureModelStringsInitialized(): Promise<void> {
  const ms = getModelStringsState()
  if (ms !== null) {
    return
  }
  setModelStringsState(getModelOverrides())
}

/**
 * Resolve an overridden model ID (e.g. a Bedrock ARN) back to its canonical
 * direct API model ID. If the input doesn't match any current override value,
 * it is returned unchanged. Safe to call during module init (no-ops if settings
 * aren't loaded yet).
 */
export function resolveOverriddenModel(modelId: string): string {
  let overrides: Record<string, string> | undefined
  try {
    overrides = getInitialSettings().modelOverrides
  } catch {
    return modelId
  }
  if (!overrides) {
    return modelId
  }
  for (const [canonicalId, override] of Object.entries(overrides)) {
    if (override === modelId) {
      return canonicalId
    }
  }
  return modelId
}
