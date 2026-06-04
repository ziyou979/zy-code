/**
 * Rollback handler for CLI command
 */
export async function rollback(_target: string, _options: Record<string, unknown>): Promise<void> {
  throw new Error('rollback not implemented')
}
