import { detectFileEncoding } from '../../services/infra/file.js'
import { getFsImplementation } from '../../services/infra/fsOperations.js'
import { LRUCache } from 'lru-cache'

type CachedFileData = {
  content: string
  encoding: BufferEncoding
  mtime: number
}

class FileReadCache_ {
  // 按 UTF-16 内容、路径和固定开销保守估算；不是进程堆内存的精确值。
  // 单个大文件不挤掉热点小文件，命中会更新 LRU 顺序。
  private cache = new LRUCache<string, CachedFileData>({
    max: 1000,
    maxSize: 32 * 1024 * 1024,
    maxEntrySize: 2 * 1024 * 1024,
    sizeCalculation: (value, key) => value.content.length * 2 + key.length * 2 + 128,
  })

  readFile(filePath: string): { content: string; encoding: BufferEncoding } {
    const fs = getFsImplementation()

    let stats
    try {
      stats = fs.statSync(filePath)
    } catch (error) {
      this.cache.delete(filePath)
      throw error
    }

    const cacheKey = filePath
    const cachedData = this.cache.get(cacheKey)

    if (cachedData && cachedData.mtime === stats.mtimeMs) {
      return {
        content: cachedData.content,
        encoding: cachedData.encoding,
      }
    }

    const encoding = detectFileEncoding(filePath)
    const content = fs.readFileSync(filePath, { encoding }).replaceAll('\r\n', '\n')

    this.cache.set(cacheKey, {
      content,
      encoding,
      mtime: stats.mtimeMs,
    })

    return { content, encoding }
  }

  clear(): void {
    this.cache.clear()
  }

  invalidate(filePath: string): void {
    this.cache.delete(filePath)
  }

  getStats(): { size: number; entries: string[] } {
    return {
      size: this.cache.size,
      entries: Array.from(this.cache.keys()),
    }
  }
}

export const fileReadCache = new FileReadCache_()
