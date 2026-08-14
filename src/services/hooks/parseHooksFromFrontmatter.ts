import { logForDebugging } from '../infra/debug.js'
import { HooksSchema, type HooksSettings } from '../settings/types.js'

/**
 * 使用 HooksSchema 解析 frontmatter 中的 hook。
 * 由 skill 和 agent 加载器共享。
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
