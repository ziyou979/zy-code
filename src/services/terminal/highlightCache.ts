import { LRUCache } from 'lru-cache'
import { hashPair } from '../../utils/hash.js'
import type { CliHighlight } from './cliHighlight.js'

// 哈希键不保留源文本，但 ANSI 高亮结果仍可能很大，必须同时限制载荷。
const cache = new LRUCache<string, string>({
  max: 500,
  maxSize: 8 * 1024 * 1024,
  maxEntrySize: 512 * 1024,
  sizeCalculation: (value, key) => (value.length + key.length) * 2 + 64,
})

export function cachedHighlight(hl: CliHighlight, code: string, language: string): string {
  const key = hashPair(language, code)
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const output = hl.highlight(code, { language })
  cache.set(key, output)
  return output
}
