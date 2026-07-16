import type { UUID } from 'node:crypto'

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function validateUuid(maybeUuid: unknown): UUID | null {
  if (typeof maybeUuid !== 'string') {
    return null
  }
  return uuidRegex.test(maybeUuid) ? (maybeUuid as UUID) : null
}

/**
 * Unescape a JSON string value extracted as raw text.
 * Only allocates a new string when escape sequences are present.
 */
export function unescapeJsonString(raw: string): string {
  if (!raw.includes('\\')) {
    return raw
  }
  try {
    return JSON.parse(`"${raw}"`)
  } catch {
    return raw
  }
}

/**
 * Extracts a simple JSON string field value from raw text without full parsing.
 * Looks for `"key":"value"` or `"key": "value"` patterns.
 * Returns the first match, or undefined if not found.
 */
export function extractJsonStringField(text: string, key: string): string | undefined {
  const patterns = [`"${key}":"`, `"${key}": "`]
  for (const pattern of patterns) {
    const idx = text.indexOf(pattern)
    if (idx < 0) {
      continue
    }

    const valueStart = idx + pattern.length
    let i = valueStart
    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2
        continue
      }
      if (text[i] === '"') {
        return unescapeJsonString(text.slice(valueStart, i))
      }
      i++
    }
  }
  return undefined
}

/**
 * Like extractJsonStringField but finds the LAST occurrence.
 * Useful for fields that are appended (customTitle, tag, etc.).
 */
export function extractLastJsonStringField(text: string, key: string): string | undefined {
  const patterns = [`"${key}":"`, `"${key}": "`]
  let lastValue: string | undefined
  for (const pattern of patterns) {
    let searchFrom = 0
    while (true) {
      const idx = text.indexOf(pattern, searchFrom)
      if (idx < 0) {
        break
      }

      const valueStart = idx + pattern.length
      let i = valueStart
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2
          continue
        }
        if (text[i] === '"') {
          lastValue = unescapeJsonString(text.slice(valueStart, i))
          break
        }
        i++
      }
      searchFrom = i + 1
    }
  }
  return lastValue
}

/**
 * Pattern matching auto-generated or system messages that should be skipped
 * when looking for the first meaningful user prompt. Matches anything that
 * starts with a lowercase XML-like tag (IDE context, hook output, task
 * notifications, channel messages, etc.) or a synthetic interrupt marker.
 */
const SKIP_FIRST_PROMPT_PATTERN = /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/

const COMMAND_NAME_RE = /<command-name>(.*?)<\/command-name>/

/**
 * Extracts the first meaningful user prompt from a JSONL head chunk.
 *
 * Skips tool_result messages, isMeta, isCompactSummary, command-name messages,
 * and auto-generated patterns (session hooks, tick, IDE metadata, etc.).
 * Truncates to 200 chars.
 */
export function extractFirstPromptFromHead(head: string): string {
  let start = 0
  let commandFallback = ''
  while (start < head.length) {
    const newlineIdx = head.indexOf('\n', start)
    const line = newlineIdx >= 0 ? head.slice(start, newlineIdx) : head.slice(start)
    start = newlineIdx >= 0 ? newlineIdx + 1 : head.length

    if (!line.includes('"type":"user"') && !line.includes('"type": "user"')) {
      continue
    }
    if (line.includes('"tool_result"')) {
      continue
    }
    if (line.includes('"isMeta":true') || line.includes('"isMeta": true')) {
      continue
    }
    if (line.includes('"isCompactSummary":true') || line.includes('"isCompactSummary": true')) {
      continue
    }

    try {
      const entry = JSON.parse(line) as Record<string, unknown>
      if (entry.type !== 'user') {
        continue
      }

      const message = entry.message as Record<string, unknown> | undefined
      if (!message) {
        continue
      }

      const content = message.content
      const texts: string[] = []
      if (typeof content === 'string') {
        texts.push(content)
      } else if (Array.isArray(content)) {
        for (const block of content as Record<string, unknown>[]) {
          if (block.type === 'text' && typeof block.text === 'string') {
            texts.push(block.text as string)
          }
        }
      }

      for (const raw of texts) {
        let result = raw.replace(/\n/g, ' ').trim()
        if (!result) {
          continue
        }

        // Skip slash-command messages but remember first as fallback
        const cmdMatch = COMMAND_NAME_RE.exec(result)
        if (cmdMatch) {
          if (!commandFallback) {
            commandFallback = cmdMatch[1]!
          }
          continue
        }

        // Format bash input with ! prefix before the generic XML skip
        const bashMatch = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(result)
        if (bashMatch) {
          return `! ${bashMatch[1]!.trim()}`
        }

        if (SKIP_FIRST_PROMPT_PATTERN.test(result)) {
          continue
        }

        if (result.length > 200) {
          result = `${result.slice(0, 200).trim()}\u2026`
        }
        return result
      }
    } catch {}
  }
  if (commandFallback) {
    return commandFallback
  }
  return ''
}
