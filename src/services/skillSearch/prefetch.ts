import type { Message } from '../../types/message.js'

/**
 * Starts prefetching skills based on conversation context.
 * This is a stub implementation for external builds.
 */
export function startSkillDiscoveryPrefetch(
  messages: readonly Message[],
  isInitial: boolean,
): void {
  // Stub: no-op in external builds
}

/**
 * Gets skill discovery attachments for the current turn.
 * This is a stub implementation for external builds.
 */
export function getTurnZeroSkillDiscovery(
  input: string | undefined,
  context: unknown,
): Promise<unknown[]> {
  // Stub: returns empty array in external builds
  return Promise.resolve([])
}
