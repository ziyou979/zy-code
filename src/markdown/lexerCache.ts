import { LRUCache } from 'lru-cache'
import { marked, type Token } from 'marked'
import { hashContent } from '../utils/hash.js'

const MAX_ENTRY_SIZE = 512 * 1024
const tokenCache = new LRUCache<string, Token[]>({
  max: 500,
  maxSize: 8 * 1024 * 1024,
  maxEntrySize: MAX_ENTRY_SIZE,
})
const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+[.)] |\n\d+[.)] /

// 估算整棵解析树的字符串和对象开销；共享引用只计一次。
// 达到单条上限立即停止，避免为了缓存再次遍历超大文档。
function tokenSize(tokens: Token[]): number {
  const pending: unknown[] = [tokens]
  const seen = new Set<object>()
  let size = 64
  while (pending.length && size <= MAX_ENTRY_SIZE) {
    const value = pending.pop()
    if (typeof value === 'string') size += value.length * 2
    else if (value !== null && typeof value === 'object' && !seen.has(value)) {
      seen.add(value)
      size += 64
      for (const child of Object.values(value)) {
        size += 16
        pending.push(child)
      }
    }
  }
  return size
}

export function cachedLexer(content: string): Token[] {
  // 必须扫描全文，正文很长时 Markdown 标记可能在代码块或尾部列表才出现。
  if (!MD_SYNTAX_RE.test(content)) {
    return [
      {
        type: 'paragraph',
        raw: content,
        text: content,
        tokens: [{ type: 'text', raw: content, text: content }],
      },
    ]
  }
  const key = hashContent(content)
  const hit = tokenCache.get(key)
  if (hit) return hit
  const tokens = marked.lexer(content)
  tokenCache.set(key, tokens, { size: tokenSize(tokens) })
  return tokens
}
