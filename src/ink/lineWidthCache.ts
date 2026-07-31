import { stringWidth } from './stringWidth.js'

// 流式输出期间，文本不断增长，但已完成的行是不可变的。
// 对每行缓存 stringWidth 可以避免每次 token 都重新测量
// 数百行未变化的内容（stringWidth 调用减少约 50 倍）。
const cache = new Map<string, number>()

const MAX_CACHE_SIZE = 4096

export function lineWidth(line: string): number {
  const cached = cache.get(line)
  if (cached !== undefined) {
    return cached
  }

  const width = stringWidth(line)

  // 当缓存过大时淘汰最旧 1/4 而非全清。
  // 全清会导致一帧内 4096 次 stringWidth 重算尖峰。
  if (cache.size >= MAX_CACHE_SIZE) {
    const keys = cache.keys()
    for (let i = 0; i < MAX_CACHE_SIZE >> 2; i++) {
      const next = keys.next()
      if (next.done) break
      cache.delete(next.value)
    }
  }

  cache.set(line, width)
  return width
}
