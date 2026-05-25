/**
 * vendor/file-index-src (Rust NAPI 模块) 的纯 TypeScript 移植。
 *
 * 原生模块封装了 nucleo (https://github.com/helix-editor/nucleo)，
 * 用于高性能文件模糊搜索。本移植在没有原生依赖的情况下重新实现
 * 了相同的 API 与评分行为。
 *
 * 关键 API：
 *   new FileIndex()
 *   .loadFromFileList(fileList: string[]): void   — 去重 + 对路径建索引
 *   .search(query: string, limit: number): SearchResult[]
 *
 * 分数语义：越小越好。分数 = 结果中的位次 / 总结果数，
 * 所以最佳匹配是 0.0。路径中包含 "test" 的项会被乘以 1.05× 惩罚
 * （上限为 1.0），以让非测试文件排名略靠前。
 */

export type SearchResult = {
  path: string
  score: number
}

// nucleo 风格的评分常量（近似 fzf-v2 / nucleo 加分）
const SCORE_MATCH = 16
const BONUS_BOUNDARY = 8
const BONUS_CAMEL = 6
const BONUS_CONSECUTIVE = 4
const BONUS_FIRST_CHAR = 8
const PENALTY_GAP_START = 3
const PENALTY_GAP_EXTENSION = 1

const TOP_LEVEL_CACHE_LIMIT = 100
const MAX_QUERY_LEN = 64
// 同步工作超过该毫秒数后让出 event loop。
// 分块大小基于时间（而非数量），这样慍机器会获得更小的块以保持
// 响应 —— 在 M 系列上 5k 路径约 2ms，但在老型 Windows 机器上可能需 15ms+。
const CHUNK_MS = 4

// 可复用缓冲区：记录 indexOf 扫描过程中每个 needle 字符的匹配位置
const posBuf = new Int32Array(MAX_QUERY_LEN)

export class FileIndex {
  private paths: string[] = []
  private lowerPaths: string[] = []
  private charBits: Int32Array = new Int32Array(0)
  private pathLens: Uint16Array = new Uint16Array(0)
  private topLevelCache: SearchResult[] | null = null
  private readyCount = 0

  /**
   * 从字符串数组加载路径。
   * 这是填充索引的主要方式 —— ripgrep 负责采集文件，我们只负责搜索。
   * 会自动对路径去重。
   */
  loadFromFileList(fileList: string[]): void {
    // 去重并过滤空字符串（与 Rust HashSet 行为一致）
    const seen = new Set<string>()
    const paths: string[] = []
    for (const line of fileList) {
      if (line.length > 0 && !seen.has(line)) {
        seen.add(line)
        paths.push(line)
      }
    }

    this.buildIndex(paths)
  }

  /**
   * 异步变体：每索引约 8–12k 路径会让出 event loop，避免超大索引
   * （27 万+ 文件）一次性阻塞主线程超过 10ms。
   * 结果与 loadFromFileList 一致。
   *
   * 返回 { queryable, done }：
   *   - queryable：首个块索引完成后即 resolve（search 会返回部分结果）。
   *     对 27 万路径的列表，路径数组准备好后约需 5–10ms 同步工作。
   *   - done：整个索引全部构建完成后 resolve。
   */
  loadFromFileListAsync(fileList: string[]): {
    queryable: Promise<void>
    done: Promise<void>
  } {
    let markQueryable: () => void = () => {}
    const queryable = new Promise<void>((resolve) => {
      markQueryable = resolve
    })
    const done = this.buildAsync(fileList, markQueryable)
    return { queryable, done }
  }

  private async buildAsync(fileList: string[], markQueryable: () => void): Promise<void> {
    const seen = new Set<string>()
    const paths: string[] = []
    let chunkStart = performance.now()
    for (let i = 0; i < fileList.length; i++) {
      const line = fileList[i]!
      if (line.length > 0 && !seen.has(line)) {
        seen.add(line)
        paths.push(line)
      }
      // 每 256 轮检查一次，摊平 performance.now() 的开销
      if ((i & 0xff) === 0xff && performance.now() - chunkStart > CHUNK_MS) {
        await yieldToEventLoop()
        chunkStart = performance.now()
      }
    }

    this.resetArrays(paths)

    chunkStart = performance.now()
    let firstChunk = true
    for (let i = 0; i < paths.length; i++) {
      this.indexPath(i)
      if ((i & 0xff) === 0xff && performance.now() - chunkStart > CHUNK_MS) {
        this.readyCount = i + 1
        if (firstChunk) {
          markQueryable()
          firstChunk = false
        }
        await yieldToEventLoop()
        chunkStart = performance.now()
      }
    }
    this.readyCount = paths.length
    markQueryable()
  }

  private buildIndex(paths: string[]): void {
    this.resetArrays(paths)
    for (let i = 0; i < paths.length; i++) {
      this.indexPath(i)
    }
    this.readyCount = paths.length
  }

  private resetArrays(paths: string[]): void {
    const n = paths.length
    this.paths = paths
    this.lowerPaths = new Array(n)
    this.charBits = new Int32Array(n)
    this.pathLens = new Uint16Array(n)
    this.readyCount = 0
    this.topLevelCache = computeTopLevelEntries(paths, TOP_LEVEL_CACHE_LIMIT)
  }

  // 预计算：小写、a–z 位图、长度。位图可以 O(1) 地快速拒绝
  // 缺少 needle 任何字母的路径（对于如 "test" 类宽泛查询，
  // 存活率 89%，仍是 10%+ 的免费收益；对于罕见字符，拒绝率 90%+）。
  private indexPath(i: number): void {
    const lp = this.paths[i]!.toLowerCase()
    this.lowerPaths[i] = lp
    const len = lp.length
    this.pathLens[i] = len
    let bits = 0
    for (let j = 0; j < len; j++) {
      const c = lp.charCodeAt(j)
      if (c >= 97 && c <= 122) {
        bits |= 1 << (c - 97)
      }
    }
    this.charBits[i] = bits
  }

  /**
   * 使用模糊匹配搜索与查询匹配的文件。
   * 返回按匹配分数排序后的前 N 个结果。
   */
  search(query: string, limit: number): SearchResult[] {
    if (limit <= 0) {
      return []
    }
    if (query.length === 0) {
      if (this.topLevelCache) {
        return this.topLevelCache.slice(0, limit)
      }
      return []
    }

    // Smart case：查询全小写 → 不区分大小写；含任意大写 → 区分大小写
    const caseSensitive = query !== query.toLowerCase()
    const needle = caseSensitive ? query : query.toLowerCase()
    const nLen = Math.min(needle.length, MAX_QUERY_LEN)
    const needleChars: string[] = new Array(nLen)
    let needleBitmap = 0
    for (let j = 0; j < nLen; j++) {
      const ch = needle.charAt(j)
      needleChars[j] = ch
      const cc = ch.charCodeAt(0)
      if (cc >= 97 && cc <= 122) {
        needleBitmap |= 1 << (cc - 97)
      }
    }

    // 分数上限：假设每个匹配都获得最大边界加分。
    // 用于在 charCodeAt 密集的边界扫描之前，提前拒绝那些仅凭 gap 惩罚
    // 就已无法超过当前前 k 阈值的路径。
    const scoreCeiling = nLen * (SCORE_MATCH + BONUS_BOUNDARY) + BONUS_FIRST_CHAR + 32

    // Top-k：维护一个升序排列的 `limit` 个最佳匹配数组。
    // 避免在仅需 `limit` 个结果时对全部匹配 O(n log n) 排序。
    const topK: { path: string; fuzzScore: number }[] = []
    let threshold = -Infinity

    const { paths, lowerPaths, charBits, pathLens, readyCount } = this

    outer: for (let i = 0; i < readyCount; i++) {
      // O(1) 位图拒绝：路径必须包含 needle 中的每个字母
      if ((charBits[i]! & needleBitmap) !== needleBitmap) {
        continue
      }

      const haystack = caseSensitive ? paths[i]! : lowerPaths[i]!

      // 融合的 indexOf 扫描：查找位置（在 JSC/V8 中是 SIMD 加速的）同时
      // 内联累加 gap / consecutive 分量。这里贪心地取最早出现位置，与
      // charCodeAt 评分器会找到的位置一致，所以可以直接从它们评分——
      // 无需二次扫描。
      let pos = haystack.indexOf(needleChars[0]!)
      if (pos === -1) {
        continue
      }
      posBuf[0] = pos
      let gapPenalty = 0
      let consecBonus = 0
      let prev = pos
      for (let j = 1; j < nLen; j++) {
        pos = haystack.indexOf(needleChars[j]!, prev + 1)
        if (pos === -1) {
          continue outer
        }
        posBuf[j] = pos
        const gap = pos - prev - 1
        if (gap === 0) {
          consecBonus += BONUS_CONSECUTIVE
        } else {
          gapPenalty += PENALTY_GAP_START + gap * PENALTY_GAP_EXTENSION
        }
        prev = pos
      }

      // gap 上界拒绝：若最佳情况分（所有边界加分）减去已知的 gap
      // 惩罚仍无法超过阈值，则跳过边界扫描。
      if (topK.length === limit && scoreCeiling + consecBonus - gapPenalty <= threshold) {
        continue
      }

      // 边界 / camelCase 评分：检查每个匹配位置之前的字符。
      const path = paths[i]!
      const hLen = pathLens[i]!
      let score = nLen * SCORE_MATCH + consecBonus - gapPenalty
      score += scoreBonusAt(path, posBuf[0]!, true)
      for (let j = 1; j < nLen; j++) {
        score += scoreBonusAt(path, posBuf[j]!, false)
      }
      score += Math.max(0, 32 - (hLen >> 2))

      if (topK.length < limit) {
        topK.push({ path, fuzzScore: score })
        if (topK.length === limit) {
          topK.sort((a, b) => a.fuzzScore - b.fuzzScore)
          threshold = topK[0]!.fuzzScore
        }
      } else if (score > threshold) {
        let lo = 0
        let hi = topK.length
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if (topK[mid]!.fuzzScore < score) {
            lo = mid + 1
          } else {
            hi = mid
          }
        }
        topK.splice(lo, 0, { path, fuzzScore: score })
        topK.shift()
        threshold = topK[0]!.fuzzScore
      }
    }

    // topK 为升序；反转为降序（最佳在前）
    topK.sort((a, b) => b.fuzzScore - a.fuzzScore)

    const matchCount = topK.length
    const denom = Math.max(matchCount, 1)
    const results: SearchResult[] = new Array(matchCount)

    for (let i = 0; i < matchCount; i++) {
      const path = topK[i]!.path
      const positionScore = i / denom
      const finalScore = path.includes('test') ? Math.min(positionScore * 1.05, 1.0) : positionScore
      results[i] = { path, score: finalScore }
    }

    return results
  }
}

/**
 * 在原始大小写路径中，位置 `pos` 处匹配的边界 / camelCase 加分。
 * `first` 启用起始位置加分（仅用于 needle[0]）。
 */
function scoreBonusAt(path: string, pos: number, first: boolean): number {
  if (pos === 0) {
    return first ? BONUS_FIRST_CHAR : 0
  }
  const prevCh = path.charCodeAt(pos - 1)
  if (isBoundary(prevCh)) {
    return BONUS_BOUNDARY
  }
  if (isLower(prevCh) && isUpper(path.charCodeAt(pos))) {
    return BONUS_CAMEL
  }
  return 0
}

function isBoundary(code: number): boolean {
  // / \ - _ . 空格
  return (
    code === 47 || // /
    code === 92 || // \
    code === 45 || // -
    code === 95 || // _
    code === 46 || // .
    code === 32 // space
  )
}

function isLower(code: number): boolean {
  return code >= 97 && code <= 122
}

function isUpper(code: number): boolean {
  return code >= 65 && code <= 90
}

export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export { CHUNK_MS }

/**
 * 提取去重后的顶级路径段，按（长度升序，同长时按字母顺序升序）排序。
 * 同时处理 Unix（/）与 Windows（\）路径分隔符。
 * 对应 lib.rs 中的 FileIndex::compute_top_level_entries。
 */
function computeTopLevelEntries(paths: string[], limit: number): SearchResult[] {
  const topLevel = new Set<string>()

  for (const p of paths) {
    // 在第一个 / 或 \ 分隔符处切分
    let end = p.length
    for (let i = 0; i < p.length; i++) {
      const c = p.charCodeAt(i)
      if (c === 47 || c === 92) {
        end = i
        break
      }
    }
    const segment = p.slice(0, end)
    if (segment.length > 0) {
      topLevel.add(segment)
      if (topLevel.size >= limit) {
        break
      }
    }
  }

  const sorted = Array.from(topLevel)
  sorted.sort((a, b) => {
    const lenDiff = a.length - b.length
    if (lenDiff !== 0) {
      return lenDiff
    }
    return a < b ? -1 : a > b ? 1 : 0
  })

  return sorted.slice(0, limit).map((path) => ({ path, score: 0.0 }))
}

export default FileIndex
export type { FileIndex as FileIndexType }
