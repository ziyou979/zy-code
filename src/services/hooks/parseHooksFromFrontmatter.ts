import { logForDebugging } from '../infra/debug.js'
import { HooksSchema, type HooksSettings } from '../settings/types.js'

/**
 * Parse hooks from frontmatter using the HooksSchema.
 * Shared between skills and agent loaders.
 */
export function parseHooksFromFrontmatter(
  frontmatter: Record<string, unknown>,
  label: string,
): HooksSettings | undefined {
  if (!frontmatter.hooks) {
    return undefined
  }

  const result = HooksSchema().safeParse(frontmatter.hooks)
  if (!result.success) {
    logForDebugging(`Invalid hooks in '${label}': ${result.error.message}`)
    return undefined
  }

  return result.data
}
