import { stringWidth } from './stringWidth.js'

// 流式输出期间，文本不断增长，但已完成的行是不可变的。
// 对每行缓存 stringWidth 可以避免每次 token 都重新测量
// 数百行未变化的内容（stringWidth 调用减少约 50 倍）。
const cache = new Map<string, number>()

const MAX_CACHE_SIZE = 4096

export function lineWidth(line: string): number {
  const cached = cache.get(line)
  if (cached !== undefined) return cached

  const width = stringWidth(line)

  // 当缓存过大时淘汰（例如多次不同响应后）。
  // 直接全量清空即可——缓存会在一帧内重新填充。
  if (cache.size >= MAX_CACHE_SIZE) {
    cache.clear()
  }

  cache.set(line, width)
  return width
}
