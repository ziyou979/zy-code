import { LRUCache } from 'lru-cache'
import { stringWidth } from './stringWidth.js'

// 已完成的行可跨帧复用；同时限制文本体积，避免流式超长行的各个版本驻留。
const cache = new LRUCache<string, number>({
  max: 4096,
  maxSize: 1024 * 1024,
  maxEntrySize: 16 * 1024,
  sizeCalculation: (_width, line) => line.length * 2 + 64,
})

export function lineWidth(line: string): number {
  const cached = cache.get(line)
  if (cached !== undefined) return cached
  const width = stringWidth(line)
  cache.set(line, width)
  return width
}
