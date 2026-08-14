import { open, readFile, stat } from 'node:fs/promises'
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser/lib/esm/main.js'
import { stripBOM } from '../services/file-persistence/jsonRead.js'
import { logError } from '../services/infra/log.js'
import { memoizeWithLRU } from './memoize.js'
import { jsonStringify } from '../services/infra/slowOperations.js'
type CachedParse = { ok: true; value: unknown } | { ok: false }

// 内层解析采用 memoize，并用可辨识联合包装结果，原因如下：
// 1. memoizeWithLRU 要求 NonNullable<unknown>，但 JSON.parse 可以返回 null
//    （如 JSON.parse("null")）。
// 2. 无效 JSON 也必须缓存，否则相同错误字符串每次调用都会重新解析、重复记录日志，
//    相比原先包住整个 try/catch 的 lodash memoize 会产生行为回退。
// 缓存限制为 50 项，避免内存无限增长。此前 lodash memoize 会永久缓存每个不同的
// JSON 字符串（settings、.mcp.json、notebook、tool 结果），造成明显内存泄漏。
// shouldLogError 有意不纳入缓存键，与 lodash memoize 默认只取首个参数的 resolver 一致。
// 超过此大小便不缓存，因为 LRU 会把完整字符串作为键；一个 200KB 配置文件占满
// 50 个槽位时，会在 #keyList 中固定约 10MB。像 ~/.zy.json 这样的较大输入也会在
// 每次读取间变化（每次 CC 启动都会增加 numStartups），本来也无法命中缓存。
const PARSE_CACHE_MAX_KEY_BYTES = 8 * 1024

function parseJSONUncached(json: string, shouldLogError: boolean): CachedParse {
  try {
    return { ok: true, value: JSON.parse(stripBOM(json)) }
  } catch (e) {
    if (shouldLogError) {
      logError(e)
    }
    return { ok: false }
  }
}

const parseJSONCached = memoizeWithLRU(parseJSONUncached, (json) => json, 50)

// 重要：出于性能考虑使用 memoize，仅缓存小输入，且 LRU 最多保留 50 项。
export const safeParseJSON = Object.assign(
  function safeParseJSON(json: string | null | undefined, shouldLogError: boolean = true): unknown {
    if (!json) {
      return null
    }
    const result =
      json.length > PARSE_CACHE_MAX_KEY_BYTES
        ? parseJSONUncached(json, shouldLogError)
        : parseJSONCached(json, shouldLogError)
    return result.ok ? result.value : null
  },
  { cache: parseJSONCached.cache },
)

/**
 * 安全解析带注释的 JSON（jsonc）。
 * 适用于 keybindings.json 等支持注释及其他 jsonc 特性的 VS Code 配置文件。
 */
export function safeParseJSONC(json: string | null | undefined): unknown {
  if (!json) {
    return null
  }
  try {
    // 解析前移除 BOM；PowerShell 5.x 会为 UTF-8 文件添加 BOM
    return parseJsonc(stripBOM(json))
  } catch (e) {
    logError(e)
    return null
  }
}

/**
 * 向数组添加新项并修改 jsonc 字符串，同时保留注释和格式。
 * @param content 要修改的 jsonc 字符串
 * @param newItem 要添加到数组的新项
 * @returns 修改后的 jsonc 字符串
 */
/**
 * Bun.JSONL.parseChunk 可用时返回该函数，否则返回 false。
 * 同时支持字符串和 Buffer，尽量减少内存使用和复制；内部也会处理 BOM。
 */
type BunJSONLParseChunk = (
  data: string | Buffer,
  offset?: number,
) => { values: unknown[]; error: null | Error; read: number; done: boolean }

const bunJSONLParse: BunJSONLParseChunk | false = (() => {
  if (typeof Bun === 'undefined') {
    return false
  }
  const b = Bun as Record<string, unknown>
  const jsonl = b.JSONL as Record<string, unknown> | undefined
  if (!jsonl?.parseChunk) {
    return false
  }
  return jsonl.parseChunk as BunJSONLParseChunk
})()

function parseJSONLBun<T>(data: string | Buffer): T[] {
  const parse = bunJSONLParse as BunJSONLParseChunk
  const len = data.length
  const result = parse(data)
  if (!result.error || result.done || result.read >= len) {
    return result.values as T[]
  }
  // 流中途出错时保留已经解析的结果，并继续处理
  let values = result.values as T[]
  let offset = result.read
  while (offset < len) {
    const newlineIndex =
      typeof data === 'string' ? data.indexOf('\n', offset) : data.indexOf(0x0a, offset)
    if (newlineIndex === -1) {
      break
    }
    offset = newlineIndex + 1
    const next = parse(data, offset)
    if (next.values.length > 0) {
      values = values.concat(next.values as T[])
    }
    if (!next.error || next.done || next.read >= len) {
      break
    }
    offset = next.read
  }
  return values
}

function parseJSONLBuffer<T>(buf: Buffer): T[] {
  const bufLen = buf.length
  let start = 0

  // 移除 UTF-8 BOM（EF BB BF）
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    start = 3
  }

  const results: T[] = []
  while (start < bufLen) {
    let end = buf.indexOf(0x0a, start)
    if (end === -1) {
      end = bufLen
    }

    const line = buf.toString('utf8', start, end).trim()
    start = end + 1
    if (!line) {
      continue
    }
    try {
      results.push(JSON.parse(line) as T)
    } catch {
      // 跳过格式错误的行
    }
  }
  return results
}

function parseJSONLString<T>(data: string): T[] {
  const stripped = stripBOM(data)
  const len = stripped.length
  let start = 0

  const results: T[] = []
  while (start < len) {
    let end = stripped.indexOf('\n', start)
    if (end === -1) {
      end = len
    }

    const line = stripped.substring(start, end).trim()
    start = end + 1
    if (!line) {
      continue
    }
    try {
      results.push(JSON.parse(line) as T)
    } catch {
      // 跳过格式错误的行
    }
  }
  return results
}

/**
 * 从字符串或 Buffer 解析 JSONL 数据，并跳过格式错误的行。
 * Bun.JSONL.parseChunk 可用时使用它提升性能，否则回退到基于 indexOf 的扫描。
 */
export function parseJSONL<T>(data: string | Buffer): T[] {
  if (bunJSONLParse) {
    return parseJSONLBun<T>(data)
  }
  if (typeof data === 'string') {
    return parseJSONLString<T>(data)
  }
  return parseJSONLBuffer<T>(data)
}

const MAX_JSONL_READ_BYTES = 100 * 1024 * 1024

/**
 * 读取并解析 JSONL 文件，最多读取末尾 100 MB。
 * 文件超过 100 MB 时只读取尾部，并跳过开头不完整的第一行。
 *
 * 当前支持的最长 context window 约为 200 万 token，远小于 100 MB JSONL，
 * 因此这一限制足够宽裕。
 */
export async function readJSONLFile<T>(filePath: string): Promise<T[]> {
  const { size } = await stat(filePath)
  if (size <= MAX_JSONL_READ_BYTES) {
    return parseJSONL<T>(await readFile(filePath))
  }
  await using fd = await open(filePath, 'r')
  const buf = Buffer.allocUnsafe(MAX_JSONL_READ_BYTES)
  let totalRead = 0
  const fileOffset = size - MAX_JSONL_READ_BYTES
  while (totalRead < MAX_JSONL_READ_BYTES) {
    const { bytesRead } = await fd.read(
      buf,
      totalRead,
      MAX_JSONL_READ_BYTES - totalRead,
      fileOffset + totalRead,
    )
    if (bytesRead === 0) {
      break
    }
    totalRead += bytesRead
  }
  // 跳过开头不完整的第一行
  const newlineIndex = buf.indexOf(0x0a)
  if (newlineIndex !== -1 && newlineIndex < totalRead - 1) {
    return parseJSONL<T>(buf.subarray(newlineIndex + 1, totalRead))
  }
  return parseJSONL<T>(buf.subarray(0, totalRead))
}

export function addItemToJSONCArray(content: string, newItem: unknown): string {
  try {
    // 内容为空或仅含空白时，新建 JSON 文件
    if (!content || content.trim() === '') {
      return jsonStringify([newItem], null, 4)
    }

    // 解析前移除 BOM；PowerShell 5.x 会为 UTF-8 文件添加 BOM
    const cleanContent = stripBOM(content)

    // 解析内容以检查 JSON 是否有效
    const parsedContent = parseJsonc(cleanContent)

    // 解析结果是有效数组时进行修改
    if (Array.isArray(parsedContent)) {
      // 获取数组长度
      const arrayLength = parsedContent.length

      // 判断是否为空数组
      const isEmpty = arrayLength === 0

      // 空数组在索引 0 添加，否则追加到末尾
      const insertPath = isEmpty ? [0] : [arrayLength]

      // 生成编辑；通过 isArrayInsertion 添加新项，避免覆盖现有项
      const edits = modify(cleanContent, insertPath, newItem, {
        formattingOptions: { insertSpaces: true, tabSize: 4 },
        isArrayInsertion: true,
      })

      // 无法生成编辑时，回退到手工构造 JSON 字符串
      if (!edits || edits.length === 0) {
        const copy = [...parsedContent, newItem]
        return jsonStringify(copy, null, 4)
      }

      // 应用编辑以保留注释（使用不含 BOM 的 cleanContent）
      return applyEdits(cleanContent, edits)
    }
    // 内容根本不是数组时，用该项创建新数组
    else {
      // 内容存在但不是数组时，整体替换
      return jsonStringify([newItem], null, 4)
    }
  } catch (e) {
    // 解析因任何原因失败时记录错误，并回退为创建新 JSON 数组
    logError(e)
    return jsonStringify([newItem], null, 4)
  }
}
