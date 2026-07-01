import { type AnsiCode, ansiCodesToString, diffAnsiCodes } from '@alcalzone/ansi-tokenize'
import { type Point, type Rectangle, type Size, unionRect } from './layout/geometry.js'
import { BEL, ESC, SEP } from './termio/ansi.js'
import * as warn from './warn.js'

// --- 共享池（用于内存优化的字符串驻留） ---

// 跨所有屏幕共享的字符池。
// 有了共享池，驻留的字符 ID 在所有屏幕间有效，
// 因此 blitRegion 可以直接复制 ID（无需重新驻留），
// diffEach 可以按整数比较 ID（无需字符串查找）。
export class CharPool {
  private strings: string[] = [' ', ''] // 索引 0 = 空格，1 = 空（占位符）
  private stringMap = new Map<string, number>([
    [' ', 0],
    ['', 1],
  ])
  private ascii: Int32Array = initCharAscii() // charCode → 索引，-1 = 未驻留

  intern(char: string): number {
    // ASCII 快速路径：直接数组查找替代 Map.get
    if (char.length === 1) {
      const code = char.charCodeAt(0)
      if (code < 128) {
        const cached = this.ascii[code]!
        if (cached !== -1) {
          return cached
        }
        const index = this.strings.length
        this.strings.push(char)
        this.ascii[code] = index
        return index
      }
    }
    const existing = this.stringMap.get(char)
    if (existing !== undefined) {
      return existing
    }
    const index = this.strings.length
    this.strings.push(char)
    this.stringMap.set(char, index)
    return index
  }

  get(index: number): string {
    return this.strings[index] ?? ' '
  }

  poolSize(): number {
    return this.strings.length
  }
}

// 跨所有屏幕共享的超链接字符串池。
// 索引 0 = 无超链接。
export class HyperlinkPool {
  private strings: string[] = [''] // 索引 0 = 无超链接
  private stringMap = new Map<string, number>()

  intern(hyperlink: string | undefined): number {
    if (!hyperlink) {
      return 0
    }
    let id = this.stringMap.get(hyperlink)
    if (id === undefined) {
      id = this.strings.length
      this.strings.push(hyperlink)
      this.stringMap.set(hyperlink, id)
    }
    return id
  }

  get(id: number): string | undefined {
    return id === 0 ? undefined : this.strings[id]
  }

  poolSize(): number {
    return this.strings.length
  }
}

// SGR 7（反色）作为 AnsiCode。endCode '\x1b[27m' 标记 VISIBLE_ON_SPACE，
// 因此 resulting styleId 的第 0 位被设置 → 渲染器不会将反色空格
// 作为不可见内容跳过。
const INVERSE_CODE: AnsiCode = {
  type: 'ansi',
  code: '\x1b[7m',
  endCode: '\x1b[27m',
}
// 粗体（SGR 1）——可干净叠加，在等宽字体中不会引起重排。endCode 22
// 同时取消 dim（SGR 2）；此处无害，因为我们从不添加 dim。
const BOLD_CODE: AnsiCode = {
  type: 'ansi',
  code: '\x1b[1m',
  endCode: '\x1b[22m',
}
// 下划线（SGR 4）。与黄底+粗体并存——下划线是
// 在任何主题上都清晰可见的无歧义标记。通过反色实现黄底
// 可能与现有背景色冲突（用户提示样式、工具边框、语法
// 背景）。如果你在匹配处看到下划线但没有黄色，说明叠加层确实
// 找到了匹配——只是黄色被现有单元格样式覆盖了。
const UNDERLINE_CODE: AnsiCode = {
  type: 'ansi',
  code: '\x1b[4m',
  endCode: '\x1b[24m',
}
// 前景→黄色（SGR 33）。当反色已在样式栈中时，终端
// 在渲染时交换前景↔背景——因此黄色前景变成黄色背景。原始背景
// 变成前景（在大多数主题上可读：深色背景 → 黄色上的深色文字）。
// endCode 39 是"默认前景色"——干净地取消任何先前的前景色。
const YELLOW_FG_CODE: AnsiCode = {
  type: 'ansi',
  code: '\x1b[33m',
  endCode: '\x1b[39m',
}

export class StylePool {
  private ids = new Map<string, number>()
  private styles: AnsiCode[][] = []
  private transitionCache = new Map<number, string>()
  readonly none: number

  constructor() {
    this.none = this.intern([])
  }

  /**
   * 驻留一个样式并返回其 ID。ID 的第 0 位编码该样式
   * 是否对空格字符产生可见效果（背景、反色、
   * 下划线等）。仅前景色的样式获得偶数 ID；对空格
   * 可见的样式获得奇数 ID。这让渲染器可以通过
   * 对打包值的单次位掩码检查跳过不可见的空格。
   */
  intern(styles: AnsiCode[]): number {
    const key = styles.length === 0 ? '' : styles.map((s) => s.code).join('\0')
    let id = this.ids.get(key)
    if (id === undefined) {
      const rawId = this.styles.length
      this.styles.push(styles.length === 0 ? [] : styles)
      id = (rawId << 1) | (styles.length > 0 && hasVisibleSpaceEffect(styles) ? 1 : 0)
      this.ids.set(key, id)
    }
    return id
  }

  /** 根据编码的 ID 恢复样式。通过 >>> 1 去掉第 0 位标志。 */
  get(id: number): AnsiCode[] {
    return this.styles[id >>> 1] ?? []
  }

  /**
   * 返回从一个样式过渡到另一个样式的预序列化 ANSI 字符串。
   * 按 (fromId, toId) 缓存——对给定键值对的首次调用之后
   * 零分配。
   */
  transition(fromId: number, toId: number): string {
    if (fromId === toId) {
      return ''
    }
    const key = fromId * 0x100000 + toId
    let str = this.transitionCache.get(key)
    if (str === undefined) {
      str = ansiCodesToString(diffAnsiCodes(this.get(fromId), this.get(toId)))
      this.transitionCache.set(key, str)
    }
    return str
  }

  /**
   * 驻留 `base + inverse` 的样式。按 base ID 缓存，因此
   * 对相同基础样式的重复调用不会重新扫描 AnsiCode[] 数组。
   * 被选区叠加层使用。
   */
  private inverseCache = new Map<number, number>()
  withInverse(baseId: number): number {
    let id = this.inverseCache.get(baseId)
    if (id === undefined) {
      const baseCodes = this.get(baseId)
      // 如果已经包含反色，则原样使用（避免 SGR 7 叠加）
      const hasInverse = baseCodes.some((c) => c.endCode === '\x1b[27m')
      id = hasInverse ? baseId : this.intern([...baseCodes, INVERSE_CODE])
      this.inverseCache.set(baseId, id)
    }
    return id
  }

  /** 当前搜索匹配的反色 + 粗体 + 通过前景交换实现的黄底。
   *  其他匹配使用纯反色——背景从主题继承。当前匹配
   *  获得独特的黄底（通过前景然后反色交换）和粗体权重，
   *  使其在一堆反色中脱颖而出。下划线过于不明显。零
   *  重排风险：所有纯 SGR 叠加，逐单元格，布局之后。黄色
   *  会覆盖这些单元格的现有前景（语法高亮）——没关系，
   *  "你在这里"的信号才是重点，语法色可以让步。 */
  private currentMatchCache = new Map<number, number>()
  withCurrentMatch(baseId: number): number {
    let id = this.currentMatchCache.get(baseId)
    if (id === undefined) {
      const baseCodes = this.get(baseId)
      // 同时过滤前景和背景，使通过反色实现的黄色无歧义。
      // 用户提示单元格有明确的背景色（灰色框）；如果该背景
      // 仍然保留，反色会交换黄色前景↔灰色背景 → 在
      // 某些终端上得到灰底黄字，另一些终端上黄底灰字（当两者都明确时，
      // 反色语义会有差异）。过滤两者可在各处得到干净的
      // 黄底 + 终端默认前景。粗体/dim/斜体
      // 可共存——保留这些。
      const codes = baseCodes.filter((c) => c.endCode !== '\x1b[39m' && c.endCode !== '\x1b[49m')
      // 先设置黄色前景，这样反色会将其交换为背景。反色之后设置粗体也
      // 没问题——SGR 1 只影响前景属性，与 7 的顺序无关。
      codes.push(YELLOW_FG_CODE)
      if (!baseCodes.some((c) => c.endCode === '\x1b[27m')) {
        codes.push(INVERSE_CODE)
      }
      if (!baseCodes.some((c) => c.endCode === '\x1b[22m')) {
        codes.push(BOLD_CODE)
      }
      // 使用下划线作为无歧义标记——黄底可能与
      // 现有背景样式冲突（用户提示背景、语法背景）。如果你在匹配处
      // 看到下划线但没有黄色，说明叠加层确实找到了它；
      // 只是黄色在样式竞争中丢失了。
      if (!baseCodes.some((c) => c.endCode === '\x1b[24m')) {
        codes.push(UNDERLINE_CODE)
      }
      id = this.intern(codes)
      this.currentMatchCache.set(baseId, id)
    }
    return id
  }

  /**
   * 选区叠加层：用纯色替换单元格的背景，
   * 同时保留其前景（颜色、粗体、斜体、dim、下划线）。
   * 匹配原生终端选区——使用专用的背景色，而非 SGR-7
   * 反色。反色会逐单元格交换前景/背景，这在
   * 语法高亮文本上会导致视觉碎片化（每种前景色变成不同的背景条纹）。
   *
   * 去掉现有背景（endCode 49m——替换，因此 diff 新增的绿色
   * 等不会透出来）和现有反色（endCode 27m——
   * 在纯色背景上叠加反色会重新交换，看起来不对）。
   *
   * 背景通过 setSelectionBg() 设置；null → 回退到 withInverse() 以保证
   * 在主题连线设置颜色之前叠加层仍能工作（测试、首帧）。
   * 缓存仅按 baseId 键入——setSelectionBg() 在更改时清除它。
   */
  private selectionBgCode: AnsiCode | null = null
  private selectionBgCache = new Map<number, number>()
  setSelectionBg(bg: AnsiCode | null): void {
    if (this.selectionBgCode?.code === bg?.code) {
      return
    }
    this.selectionBgCode = bg
    this.selectionBgCache.clear()
  }
  withSelectionBg(baseId: number): number {
    const bg = this.selectionBgCode
    if (bg === null) {
      return this.withInverse(baseId)
    }
    let id = this.selectionBgCache.get(baseId)
    if (id === undefined) {
      // 保留除了背景（49m）和反色（27m）之外的所有内容。前景、粗体、dim、
      // 斜体、下划线、删除线均保留。
      const kept = this.get(baseId).filter(
        (c) => c.endCode !== '\x1b[49m' && c.endCode !== '\x1b[27m',
      )
      kept.push(bg)
      id = this.intern(kept)
      this.selectionBgCache.set(baseId, id)
    }
    return id
  }

  poolSize(): number {
    return this.styles.length
  }

  /**
   * 释放派生缓存（transitionCache / inverseCache / currentMatchCache /
   * selectionBgCache）。styles[] 和 ids Map 保持不变——所有已分配的
   * style ID 仍然有效，渲染器和屏幕缓冲区无需任何更新。
   *
   * transitionCache 是主要的内存消耗者：它为每对 (fromId, toId)
   * 缓存一个预序列化的 ANSI 过渡字符串，规模是 O(N²)。清理后
   * 按需重新计算，对用户不可见（transition() 本身是纯函数）。
   *
   * 定期调用（如每 5 分钟）即可将长会话的内存增长限制在
   * 可控范围内，同时完全避免 style ID 重映射带来的渲染风险。
   */
  clearCaches(): void {
    this.transitionCache.clear()
    this.inverseCache.clear()
    this.currentMatchCache.clear()
    this.selectionBgCache.clear()
  }
}

// 在空格字符上产生可见效果的 endCode
const VISIBLE_ON_SPACE = new Set([
  '\x1b[49m', // 背景色
  '\x1b[27m', // 反色
  '\x1b[24m', // 下划线
  '\x1b[29m', // 删除线
  '\x1b[55m', // 上划线
])

function hasVisibleSpaceEffect(styles: AnsiCode[]): boolean {
  for (const style of styles) {
    if (VISIBLE_ON_SPACE.has(style.endCode)) {
      return true
    }
  }
  return false
}

/**
 * 单元格宽度分类，用于处理双倍宽字符（CJK、emoji
 * 等）
 *
 * 我们使用显式的占位符单元格，而不是在渲染时推断宽度。这
 * 使数据结构自描述，并简化光标定位逻辑。
 *
 * @see https://mitchellh.com/writing/grapheme-clusters-in-terminals
 */
// const enum 在编译时内联——无运行时对象，无属性访问
export enum CellWidth {
  // 非宽字符，单元格宽度 1
  Narrow = 0,
  // 宽字符，单元格宽度 2。此单元格包含实际字符。
  Wide = 1,
  // 占据宽字符第二个视觉列的占位符。不渲染。
  SpacerTail = 2,
  // 软换行行末的占位符，表示宽字符
  // 延续到下一行。用于在软换行期间跨行
  // 保留宽字符语义。
  SpacerHead = 3,
}

export type Hyperlink = string | undefined

/**
 * Cell 是 cellAt() 返回的视图类型。单元格在内部存储为打包的类型化
 * 数组，以避免为每个单元格分配对象产生 GC 压力。
 */
export type Cell = {
  char: string
  styleId: number
  width: CellWidth
  hyperlink: Hyperlink
}

// 用于空/占位符单元格的常量，支持快速比较
// 这些是 charStrings 表中的索引，而非码点
const EMPTY_CHAR_INDEX = 0 // ' '（空格）
const SPACER_CHAR_INDEX = 1 // ''（占位符单元格的空字符串）
// 未写入的单元格为 [EMPTY_CHAR_INDEX=0, packWord1(emptyStyleId=0,0,0)=0]。
// 由于 StylePool.none 始终为 0（首个 intern），未写入的单元格在打包数组中
// 与显式清除的单元格无法区分。
// 这是有意为之：diffEach 可以用零归一化直接比较原始整数。
// isEmptyCellByIndex 检查两个字是否都为 0 来识别"从未视觉写入"的单元格。

function initCharAscii(): Int32Array {
  const table = new Int32Array(128)
  table.fill(-1)
  table[32] = EMPTY_CHAR_INDEX // ' ' (space)
  return table
}

// --- 打包单元格布局 ---
// 每个单元格是 cells 数组中 2 个连续的 Int32 元素：
//   word0 (cells[ci]):     charId（完整 32 位）
//   word1 (cells[ci + 1]): styleId[31:17] | hyperlinkId[16:2] | width[1:0]
const STYLE_SHIFT = 17
const HYPERLINK_SHIFT = 2
const HYPERLINK_MASK = 0x7fff // 15 位
const WIDTH_MASK = 3 // 2 位

// 将 styleId、hyperlinkId 和 width 打包到一个 Int32 中
function packWord1(styleId: number, hyperlinkId: number, width: number): number {
  return (styleId << STYLE_SHIFT) | (hyperlinkId << HYPERLINK_SHIFT) | width
}

// 未写入单元格的大整数表示——两个字都是 0，所以 64 位值为 0n。
// 用于 BigInt64Array.fill() 进行批量清除（resetScreen、clearRegion）。
// 不用于比较——BigInt 元素读取会导致堆分配。
const EMPTY_CELL_VALUE = 0n

/**
 * Screen 使用打包的 Int32Array 而非 Cell 对象，以消除 GC
 * 压力。对于 200x120 的屏幕，这避免了分配 24,000 个对象。
 *
 * 单元格数据存储为每个单元格 2 个 Int32 的单个连续数组：
 *   word0: charId（完整 32 位——CharPool 的索引）
 *   word1: styleId[31:17] | hyperlinkId[16:2] | width[1:0]
 *
 * 此布局将 diffEach 的内存访问减半（2 次整数加载 vs 4 次），
 * 并支持未来通过 Bun.indexOfFirstDifference 进行 SIMD 比较。
 */
export type Screen = Size & {
  // 打包的单元格数据——每个单元格 2 个 Int32：[charId, packed(styleId|hyperlinkId|width)]
  // cells 和 cells64 是同一 ArrayBuffer 的视图。
  cells: Int32Array
  cells64: BigInt64Array // 每个单元格 1 个 BigInt64——用于 resetScreen/clearRegion 中的批量填充

  // 共享池——使用相同池的所有屏幕间 ID 有效
  charPool: CharPool
  hyperlinkPool: HyperlinkPool

  // 用于比较的空样式 ID
  emptyStyleId: number

  /**
   * 渲染期间被写入（非 blit）的单元格边界框。
   * diff() 用它将迭代限制在可能发生更改的区域。
   */
  damage: Rectangle | undefined

  /**
   * 每单元格 noSelect 位图——每单元格 1 字节，1 = 从文本
   * 选区中排除（复制 + 高亮）。<NoSelect> 用它标记边栏
   *（行号、diff 符号），因此在 diff 上点击拖拽能生成干净的
   * 可复制代码。每帧在 resetScreen 中完全重置；blitRegion
   * 将它与单元格一起复制，因此 blit 优化保留标记。
   */
  noSelect: Uint8Array

  /**
   * 每行软换行续行标记。softWrap[r]=N>0 表示行 r
   * 是行 r-1 的单词换行续行（`\n` 由 wrapAnsi 插入，
   * 而非源文件中），且行 r-1 的写入内容
   * 在绝对列 N 处结束（排他——单元格 [0..N) 是片段，
   * N 之后是未写入的填充）。0 表示行 r 不是
   * 续行（硬换行或首行）。选区复制检查
   * softWrap[r]>0 以将行 r 不带换行符连接到行 r-1，并
   * 读取 softWrap[r+1] 以在行 r+1 从它续行时知道行 r 的内容结束。
   * 需要内容结束列是因为在打包类型化数组中，
   * 未写入的单元格和写入的无样式空格无法区分
   *（两者都全零）——没有它，我们要么丢掉词分隔空格（trim），
   * 要么包含尾部填充（不 trim）。此编码（自身上的续行、
   * 前一内容结束在此处）的选择是为了 shiftRows 保留续行语义：
   * 当行 r 从顶部滚出且行 r+1 移到行 r 时，sw[r] 获取
   * 旧的 sw[r+1]——正确地表示新行 r 是当前 scrolledOffAbove
   * 中的续行。每帧重置；由 blitRegion/shiftRows 复制。
   */
  softWrap: Int32Array
}

/**
 * 收集屏幕缓冲区中所有活跃的 styleId（编码 ID，含 bit0 可见性标志）。
 */
export function collectLiveStyleIds(screen: Screen): Set<number> {
  const live = new Set<number>()
  const cells = screen.cells
  const total = screen.width * screen.height
  for (let i = 0; i < total; i++) {
    const word1 = cells[(i << 1) | 1]!
    live.add(word1 >>> STYLE_SHIFT)
  }
  return live
}

function isEmptyCellByIndex(screen: Screen, index: number): boolean {
  // 空/未写入的单元格两个字都 === 0：
  // word0 = EMPTY_CHAR_INDEX (0), word1 = packWord1(emptyStyleId=0, 0, 0) = 0。
  const ci = index << 1
  return screen.cells[ci] === 0 && screen.cells[ci | 1] === 0
}

export function isEmptyCellAt(screen: Screen, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) {
    return true
  }
  return isEmptyCellByIndex(screen, y * screen.width + x)
}

/**
 * 检查 Cell（视图对象）是否表示空单元格。
 */
export function isCellEmpty(screen: Screen, cell: Cell): boolean {
  // 检查单元格是否看起来像空单元格（空格、空样式、窄、无链接）。
  // 注意：经过 cellAt 映射后，未写入的单元格具有 emptyStyleId，因此
  // 这对未写入和已清除的单元格都返回 true。使用 isEmptyCellAt
  // 获取内部区分。
  return (
    cell.char === ' ' &&
    cell.styleId === screen.emptyStyleId &&
    cell.width === CellWidth.Narrow &&
    !cell.hyperlink
  )
}
// 驻留超链接字符串并返回其 ID（0 = 无超链接）
function internHyperlink(screen: Screen, hyperlink: Hyperlink): number {
  return screen.hyperlinkPool.intern(hyperlink)
}

// ---

export function createScreen(
  width: number,
  height: number,
  styles: StylePool,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool,
): Screen {
  // 警告：如果维度不是有效整数（可能是 yoga 布局输出异常）
  warn.ifNotInteger(width, 'createScreen width')
  warn.ifNotInteger(height, 'createScreen height')

  // 确保宽度和高度是有效整数，防止崩溃
  if (!Number.isInteger(width) || width < 0) {
    width = Math.max(0, Math.floor(width) || 0)
  }
  if (!Number.isInteger(height) || height < 0) {
    height = Math.max(0, Math.floor(height) || 0)
  }

  const size = width * height

  // 分配一个 buffer，两个视图：Int32Array 用于逐字访问，
  // BigInt64Array 用于 resetScreen/clearRegion 中的批量填充。
  // ArrayBuffer 已零初始化，这正是空单元格值：
  // [EMPTY_CHAR_INDEX=0, packWord1(emptyStyleId=0,0,0)=0]。
  const buf = new ArrayBuffer(size << 3) // 8 bytes per cell
  const cells = new Int32Array(buf)
  const cells64 = new BigInt64Array(buf)

  return {
    width,
    height,
    cells,
    cells64,
    charPool,
    hyperlinkPool,
    emptyStyleId: styles.none,
    damage: undefined,
    noSelect: new Uint8Array(size),
    softWrap: new Int32Array(height),
  }
}

/**
 * 重置现有屏幕以复用，避免分配新的类型化数组。
 * 按需调整大小并将所有单元格清空为空/未写入状态。
 *
 * 对于双缓冲，这允许在前后台缓冲区之间交换，
 * 而无需每帧分配新的 Screen 对象。
 */
export function resetScreen(screen: Screen, width: number, height: number): void {
  // 警告：如果维度不是有效整数
  warn.ifNotInteger(width, 'resetScreen width')
  warn.ifNotInteger(height, 'resetScreen height')

  // 确保宽度和高度是有效整数，防止崩溃
  if (!Number.isInteger(width) || width < 0) {
    width = Math.max(0, Math.floor(width) || 0)
  }
  if (!Number.isInteger(height) || height < 0) {
    height = Math.max(0, Math.floor(height) || 0)
  }

  const size = width * height

  // 按需调整大小（仅扩容，避免重复分配）
  if (screen.cells64.length < size) {
    const buf = new ArrayBuffer(size << 3)
    screen.cells = new Int32Array(buf)
    screen.cells64 = new BigInt64Array(buf)
    screen.noSelect = new Uint8Array(size)
  }
  if (screen.softWrap.length < height) {
    screen.softWrap = new Int32Array(height)
  }

  // 重置所有单元格——单次 fill 调用，无循环
  screen.cells64.fill(EMPTY_CELL_VALUE, 0, size)
  screen.noSelect.fill(0, 0, size)
  screen.softWrap.fill(0, 0, height)

  // 更新尺寸
  screen.width = width
  screen.height = height

  // 共享池会累积——无需清理。独特的字符/超链接集是有界的。

  // 清除 damage 追踪
  screen.damage = undefined
}

/**
 * 将屏幕的字符和超链接 ID 重新驻留到新池中。
 * 用于世代池重置——迁移后，屏幕的
 * 类型化数组包含对新池有效的 ID，旧池
 * 可以被 GC 回收。
 *
 * O(width * height) 但仅在偶尔调用时（例如，在对话轮次之间）。
 */
export function migrateScreenPools(
  screen: Screen,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool,
): void {
  const oldCharPool = screen.charPool
  const oldHyperlinkPool = screen.hyperlinkPool
  if (oldCharPool === charPool && oldHyperlinkPool === hyperlinkPool) {
    return
  }

  const size = screen.width * screen.height
  const cells = screen.cells

  // 单次遍历中重新驻留字符和超链接，步长为 2
  for (let ci = 0; ci < size << 1; ci += 2) {
    // 重新驻留 charId（word0）
    const oldCharId = cells[ci]!
    cells[ci] = charPool.intern(oldCharPool.get(oldCharId))

    // 重新驻留 hyperlinkId（打包在 word1 中）
    const word1 = cells[ci + 1]!
    const oldHyperlinkId = (word1 >>> HYPERLINK_SHIFT) & HYPERLINK_MASK
    if (oldHyperlinkId !== 0) {
      const oldStr = oldHyperlinkPool.get(oldHyperlinkId)
      const newHyperlinkId = hyperlinkPool.intern(oldStr)
      // 用新 hyperlinkId 重新打包 word1，保留 styleId 和 width
      const styleId = word1 >>> STYLE_SHIFT
      const width = word1 & WIDTH_MASK
      cells[ci + 1] = packWord1(styleId, newHyperlinkId, width)
    }
  }

  screen.charPool = charPool
  screen.hyperlinkPool = hyperlinkPool
}

/**
 * 获取给定位置的 Cell 视图。每次调用返回新对象——
 * 这是有意为之，因为单元格以打包方式存储，而非对象。
 */
export function cellAt(screen: Screen, x: number, y: number): Cell | undefined {
  if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) {
    return undefined
  }
  return cellAtIndex(screen, y * screen.width + x)
}
/**
 * 通过预计算的数组索引获取 Cell 视图。跳过边界检查和
 * 索引计算——调用者必须确保索引有效。
 */
export function cellAtIndex(screen: Screen, index: number): Cell {
  const ci = index << 1
  const word1 = screen.cells[ci + 1]!
  const hid = (word1 >>> HYPERLINK_SHIFT) & HYPERLINK_MASK
  return {
    // 未写入的单元格 charIndex=0（EMPTY_CHAR_INDEX）；charPool.get(0) 返回 ' '
    char: screen.charPool.get(screen.cells[ci]!),
    styleId: word1 >>> STYLE_SHIFT,
    width: word1 & WIDTH_MASK,
    hyperlink: hid === 0 ? undefined : screen.hyperlinkPool.get(hid),
  }
}

/**
 * JediTerm（JetBrains IDE 内置终端）将每个 CJK 宽字符计为 1 列
 * （而非 2 列），导致鼠标列坐标系统性偏小。
 *
 * 此函数修正字符坐标到单元格坐标：遍历屏幕缓冲行，按字符计数
 * （跳过 SpacerTail/SpacerHead 占位单元格），对前 charCol 个字符中的
 * CellWidth.Wide 单元格累加计数。返回值即为需要加到字符坐标上的偏移量。
 *
 * 例：文本 "中文abc"，charCol=2（点击 'a'）：
 *   cell 0: Wide('中')   → charCount=1, wideCount=1
 *   cell 1: SpacerTail   → 跳过
 *   cell 2: Wide('文')   → charCount=2, wideCount=2  ← 停止
 *   返回 2，修正后列 = 2 + 2 = 4（'a' 的单元格列）✓
 */
export function countWideCellsInRowBefore(screen: Screen, row: number, charCol: number): number {
  if (row < 0 || row >= screen.height || charCol <= 0) {
    return 0
  }
  const w = screen.width
  const cells = screen.cells
  const rowOff = row * w
  let wideCount = 0
  let charCount = 0
  for (let c = 0; c < w && charCount < charCol; c++) {
    const word1 = cells[((rowOff + c) << 1) | 1]!
    const width = word1 & WIDTH_MASK
    // SpacerTail/SpacerHead 是宽字符的占位单元格，不计入字符数
    if (width === CellWidth.SpacerTail || width === CellWidth.SpacerHead) {
      continue
    }
    if (width === CellWidth.Wide) {
      wideCount++
    }
    charCount++
  }
  return wideCount
}

/**
 * 获取给定索引处的 Cell，如果没有可见内容则返回 undefined。
 * 对于占位符单元格（charId 1）、空无样式空格、以及
 * 与 lastRenderedStyleId 匹配的仅前景样式空格返回 undefined
 * （光标前进产生相同的视觉结果，避免分配 Cell 对象）。
 *
 * @param lastRenderedStyleId - 此行上最后一个渲染单元格
 *   的 styleId，如果没有则为 -1。
 */
export function visibleCellAtIndex(
  cells: Int32Array,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool,
  index: number,
  lastRenderedStyleId: number,
): Cell | undefined {
  const ci = index << 1
  const charId = cells[ci]!
  if (charId === 1) {
    return undefined // 占位符
  }
  const word1 = cells[ci + 1]!
  // 对于空格：0x3fffc 屏蔽位 2-17（hyperlinkId + styleId 可见性
  // 位）。如果为零，该空格没有超链接且至多只有仅前景的样式。
  // 然后 word1 >>> STYLE_SHIFT 是前景样式——如果为零则跳过
  // （真正不可见）或与此行最后渲染的样式匹配。
  if (charId === 0 && (word1 & 0x3fffc) === 0) {
    const fgStyle = word1 >>> STYLE_SHIFT
    if (fgStyle === 0 || fgStyle === lastRenderedStyleId) {
      return undefined
    }
  }
  const hid = (word1 >>> HYPERLINK_SHIFT) & HYPERLINK_MASK
  return {
    char: charPool.get(charId),
    styleId: word1 >>> STYLE_SHIFT,
    width: word1 & WIDTH_MASK,
    hyperlink: hid === 0 ? undefined : hyperlinkPool.get(hid),
  }
}

/**
 * 写入单元格数据到现有 Cell 对象以避免分配。
 * 调用者必须确保索引有效。
 */
function cellAtCI(screen: Screen, ci: number, out: Cell): void {
  const w1 = ci | 1
  const word1 = screen.cells[w1]!
  out.char = screen.charPool.get(screen.cells[ci]!)
  out.styleId = word1 >>> STYLE_SHIFT
  out.width = word1 & WIDTH_MASK
  const hid = (word1 >>> HYPERLINK_SHIFT) & HYPERLINK_MASK
  out.hyperlink = hid === 0 ? undefined : screen.hyperlinkPool.get(hid)
}

export function charInCellAt(screen: Screen, x: number, y: number): string | undefined {
  if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) {
    return undefined
  }
  const ci = (y * screen.width + x) << 1
  return screen.charPool.get(screen.cells[ci]!)
}
/**
 * 设置一个单元格，可选为宽字符创建占位符。
 *
 * 宽字符（CJK、emoji）在缓冲区中占据 2 个单元格：
 * 1. 第一个单元格：包含实际字符，width = Wide
 * 2. 第二个单元格：占位符单元格，width = SpacerTail（空，不渲染）
 *
 * 如果单元格 width = Wide，此函数自动在下一列创建
 * 对应的 SpacerTail。这种双单元格模型使
 * 缓冲区与视觉列对齐，让光标定位变得简单。
 *
 * TODO: 实现软换行后，SpacerHead 单元格将由换行逻辑在
 * 宽字符换行到下一行的行末位置显式放置。
 * 此函数无需自动处理 SpacerHead——它将由换行代码直接设置。
 */
export function setCellAt(screen: Screen, x: number, y: number, cell: Cell): void {
  if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) {
    return
  }
  const ci = (y * screen.width + x) << 1
  const cells = screen.cells

  // 当宽字符被窄字符覆盖时，其 SpacerTail 保留为
  // 幽灵单元格，diff/渲染管线会跳过它，导致前一帧的
  // 过期内容泄漏出来。
  const prevWidth = cells[ci + 1]! & WIDTH_MASK
  if (prevWidth === CellWidth.Wide && cell.width !== CellWidth.Wide) {
    const spacerX = x + 1
    if (spacerX < screen.width) {
      const spacerCI = ci + 2
      if ((cells[spacerCI + 1]! & WIDTH_MASK) === CellWidth.SpacerTail) {
        cells[spacerCI] = EMPTY_CHAR_INDEX
        cells[spacerCI + 1] = packWord1(screen.emptyStyleId, 0, CellWidth.Narrow)
      }
    }
  }
  // 追踪下方 damage 扩展中清除的宽字符位置
  let clearedWideX = -1
  if (prevWidth === CellWidth.SpacerTail && cell.width !== CellWidth.SpacerTail) {
    // 覆盖 SpacerTail：清除 (x-1) 处孤立的宽字符。
    // 将宽字符保留为窄宽度会导致终端
    // 仍然以宽度 2 渲染它，使光标模型不同步。
    if (x > 0) {
      const wideCI = ci - 2
      if ((cells[wideCI + 1]! & WIDTH_MASK) === CellWidth.Wide) {
        cells[wideCI] = EMPTY_CHAR_INDEX
        cells[wideCI + 1] = packWord1(screen.emptyStyleId, 0, CellWidth.Narrow)
        clearedWideX = x - 1
      }
    }
  }

  // 将单元格数据打包到 cells 数组
  cells[ci] = internCharString(screen, cell.char)
  cells[ci + 1] = packWord1(cell.styleId, internHyperlink(screen, cell.hyperlink), cell.width)

  // 追踪 damage——原地扩展边界而非分配新对象
  // 包含主单元格位置和任何清除的孤立单元格
  const minX = clearedWideX >= 0 ? Math.min(x, clearedWideX) : x
  const damage = screen.damage
  if (damage) {
    const right = damage.x + damage.width
    const bottom = damage.y + damage.height
    if (minX < damage.x) {
      damage.width += damage.x - minX
      damage.x = minX
    } else if (x >= right) {
      damage.width = x - damage.x + 1
    }
    if (y < damage.y) {
      damage.height += damage.y - y
      damage.y = y
    } else if (y >= bottom) {
      damage.height = y - damage.y + 1
    }
  } else {
    screen.damage = { x: minX, y, width: x - minX + 1, height: 1 }
  }

  // 如果是宽字符，在下一列创建占位符
  if (cell.width === CellWidth.Wide) {
    const spacerX = x + 1
    if (spacerX < screen.width) {
      const spacerCI = ci + 2
      // 用 SpacerTail 覆盖的单元格本身是 Wide 时，
      // 也要清除它在 x+2 处的 SpacerTail。否则孤立的 SpacerTail
      // 会让 diffEach 报告它为 `added`，而 log-update 的跳过占位符
      // 规则会阻止清除该列之前的任何内容。
      // 场景：[a, 💻, spacer] → [本, spacer, 孤立 spacer] 当
      // yoga 把 a💻 压缩到高度 0 且 本 在同一 y 位置渲染时。
      if ((cells[spacerCI + 1]! & WIDTH_MASK) === CellWidth.Wide) {
        const orphanCI = spacerCI + 2
        if (
          spacerX + 1 < screen.width &&
          (cells[orphanCI + 1]! & WIDTH_MASK) === CellWidth.SpacerTail
        ) {
          cells[orphanCI] = EMPTY_CHAR_INDEX
          cells[orphanCI + 1] = packWord1(screen.emptyStyleId, 0, CellWidth.Narrow)
        }
      }
      cells[spacerCI] = SPACER_CHAR_INDEX
      cells[spacerCI + 1] = packWord1(screen.emptyStyleId, 0, CellWidth.SpacerTail)

      // 扩展 damage 以包含 SpacerTail，让 diff() 扫描它
      const d = screen.damage
      if (d && spacerX >= d.x + d.width) {
        d.width = spacerX - d.x + 1
      }
    }
  }
}

/**
 * 原地替换单元格的 styleId，不影响 char、width
 * 或 hyperlink。保留空单元格不变（char 保持 ' '）。追踪单元格的
 * damage 以便 diffEach 检测到变化。
 */
export function setCellStyleId(screen: Screen, x: number, y: number, styleId: number): void {
  if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) {
    return
  }
  const ci = (y * screen.width + x) << 1
  const cells = screen.cells
  const word1 = cells[ci + 1]!
  const width = word1 & WIDTH_MASK
  // 跳过占位符单元格——头单元格上的反色在视觉上已覆盖两列
  if (width === CellWidth.SpacerTail || width === CellWidth.SpacerHead) {
    return
  }
  const hid = (word1 >>> HYPERLINK_SHIFT) & HYPERLINK_MASK
  cells[ci + 1] = packWord1(styleId, hid, width)
  // 扩展 damage 以便 diffEach 扫描此单元格
  const d = screen.damage
  if (d) {
    screen.damage = unionRect(d, { x, y, width: 1, height: 1 })
  } else {
    screen.damage = { x, y, width: 1, height: 1 }
  }
}

/**
 * 通过屏幕共享的 CharPool 驻留字符串。
 * 支持组合字符簇（如家庭 emoji）。
 */
function internCharString(screen: Screen, char: string): number {
  return screen.charPool.intern(char)
}

/**
 * 使用 TypedArray.set() 将矩形区域从 src 批量复制到 dst。
 * 每行单次 cells.set() 调用（连续块时仅一次调用）。
 * damage 对整个区域计算一次。
 *
 * 将负的 regionX/regionY 钳位到 0（与 clearRegion 一致）——绝对
 * 定位的叠加层在小终端中可能计算出负的屏幕坐标。
 * maxX/maxY 应由调用者钳位到屏幕边界。
 */
export function blitRegion(
  dst: Screen,
  src: Screen,
  regionX: number,
  regionY: number,
  maxX: number,
  maxY: number,
): void {
  regionX = Math.max(0, regionX)
  regionY = Math.max(0, regionY)
  if (regionX >= maxX || regionY >= maxY) {
    return
  }

  const rowLen = maxX - regionX
  const srcStride = src.width << 1
  const dstStride = dst.width << 1
  const rowBytes = rowLen << 1 // 2 Int32s per cell
  const srcCells = src.cells
  const dstCells = dst.cells
  const srcNoSel = src.noSelect
  const dstNoSel = dst.noSelect

  // softWrap 是每行的——无论步长/宽度如何，都复制行范围。
  // 部分宽度 blit 仍然携带行的换行来源，因为
  // blit 的内容（缓存的 ink 文本节点）是设置该位的来源。
  dst.softWrap.set(src.softWrap.subarray(regionY, maxY), regionY)

  // 快速路径：复制全宽行且步长相同时内存连续
  if (regionX === 0 && maxX === src.width && src.width === dst.width) {
    const srcStart = regionY * srcStride
    const totalBytes = (maxY - regionY) * srcStride
    dstCells.set(
      srcCells.subarray(srcStart, srcStart + totalBytes),
      srcStart, // srcStart === dstStart 当步长匹配且 regionX === 0 时
    )
    // noSelect 是每单元格 1 字节 vs cells 的 8 字节——相同区域，不同尺度
    const nsStart = regionY * src.width
    const nsLen = (maxY - regionY) * src.width
    dstNoSel.set(srcNoSel.subarray(nsStart, nsStart + nsLen), nsStart)
  } else {
    // 部分宽度或步长不匹配区域的逐行复制
    let srcRowCI = regionY * srcStride + (regionX << 1)
    let dstRowCI = regionY * dstStride + (regionX << 1)
    let srcRowNS = regionY * src.width + regionX
    let dstRowNS = regionY * dst.width + regionX
    for (let y = regionY; y < maxY; y++) {
      dstCells.set(srcCells.subarray(srcRowCI, srcRowCI + rowBytes), dstRowCI)
      dstNoSel.set(srcNoSel.subarray(srcRowNS, srcRowNS + rowLen), dstRowNS)
      srcRowCI += srcStride
      dstRowCI += dstStride
      srcRowNS += src.width
      dstRowNS += dst.width
    }
  }

  // 整个区域的 damage 计算一次
  const regionRect = {
    x: regionX,
    y: regionY,
    width: rowLen,
    height: maxY - regionY,
  }
  if (dst.damage) {
    dst.damage = unionRect(dst.damage, regionRect)
  } else {
    dst.damage = regionRect
  }

  // 右边缘的宽字符处理：占位符可能在 blit 区域之外
  // 但仍在 dst 边界内。仅在边界列进行逐行检查。
  if (maxX < dst.width) {
    let srcLastCI = (regionY * src.width + (maxX - 1)) << 1
    let dstSpacerCI = (regionY * dst.width + maxX) << 1
    let wroteSpacerOutsideRegion = false
    for (let y = regionY; y < maxY; y++) {
      if ((srcCells[srcLastCI + 1]! & WIDTH_MASK) === CellWidth.Wide) {
        dstCells[dstSpacerCI] = SPACER_CHAR_INDEX
        dstCells[dstSpacerCI + 1] = packWord1(dst.emptyStyleId, 0, CellWidth.SpacerTail)
        wroteSpacerOutsideRegion = true
      }
      srcLastCI += srcStride
      dstSpacerCI += dstStride
    }
    // 如果我们写入了任何 SpacerTail，扩展 damage 以包含 SpacerTail 列
    if (wroteSpacerOutsideRegion && dst.damage) {
      const rightEdge = dst.damage.x + dst.damage.width
      if (rightEdge === maxX) {
        dst.damage = { ...dst.damage, width: dst.damage.width + 1 }
      }
    }
  }
}

/**
 * 批量清除屏幕的矩形区域。
 * 使用 BigInt64Array.fill() 进行快速行清除。
 * 处理区域边缘的宽字符边界清理。
 */
export function clearRegion(
  screen: Screen,
  regionX: number,
  regionY: number,
  regionWidth: number,
  regionHeight: number,
): void {
  const startX = Math.max(0, regionX)
  const startY = Math.max(0, regionY)
  const maxX = Math.min(regionX + regionWidth, screen.width)
  const maxY = Math.min(regionY + regionHeight, screen.height)
  if (startX >= maxX || startY >= maxY) {
    return
  }

  const cells = screen.cells
  const cells64 = screen.cells64
  const screenWidth = screen.width
  const rowBase = startY * screenWidth
  let damageMinX = startX
  let damageMaxX = maxX

  // EMPTY_CELL_VALUE (0n) 匹配零初始化状态：
  // word0=EMPTY_CHAR_INDEX(0), word1=packWord1(0,0,0)=0
  if (startX === 0 && maxX === screenWidth) {
    // 全宽：单次 fill，无需边界检查
    cells64.fill(EMPTY_CELL_VALUE, rowBase, rowBase + (maxY - startY) * screenWidth)
  } else {
    // 部分宽度：单个循环处理每行的边界清理和填充。
    const stride = screenWidth << 1 // 2 Int32s per cell
    const rowLen = maxX - startX
    const checkLeft = startX > 0
    const checkRight = maxX < screenWidth
    let leftEdge = (rowBase + startX) << 1
    let rightEdge = (rowBase + maxX - 1) << 1
    let fillStart = rowBase + startX

    for (let y = startY; y < maxY; y++) {
      // 左边界：如果 startX 处的单元格是 SpacerTail，则
      // 区域外的 startX-1 处的宽字符将变为孤立。清除它。
      if (checkLeft) {
        // leftEdge 指向 startX 单元格的 word0；+1 是其 word1
        if ((cells[leftEdge + 1]! & WIDTH_MASK) === CellWidth.SpacerTail) {
          // startX-1 处单元格的 word1 是 leftEdge-1；word0 是 leftEdge-2
          const prevW1 = leftEdge - 1
          if ((cells[prevW1]! & WIDTH_MASK) === CellWidth.Wide) {
            cells[prevW1 - 1] = EMPTY_CHAR_INDEX
            cells[prevW1] = packWord1(screen.emptyStyleId, 0, CellWidth.Narrow)
            damageMinX = startX - 1
          }
        }
      }

      // 右边界：如果 maxX-1 处的单元格是 Wide，其 maxX 处的
      // SpacerTail（区域外）将变为孤立。清除它。
      if (checkRight) {
        // rightEdge points to word0 of cell at maxX-1; +1 is its word1
        if ((cells[rightEdge + 1]! & WIDTH_MASK) === CellWidth.Wide) {
          // maxX 处单元格的 word1 是 rightEdge+3（+2 到下一个 word0，+1 到 word1）
          const nextW1 = rightEdge + 3
          if ((cells[nextW1]! & WIDTH_MASK) === CellWidth.SpacerTail) {
            cells[nextW1 - 1] = EMPTY_CHAR_INDEX
            cells[nextW1] = packWord1(screen.emptyStyleId, 0, CellWidth.Narrow)
            damageMaxX = maxX + 1
          }
        }
      }

      cells64.fill(EMPTY_CELL_VALUE, fillStart, fillStart + rowLen)
      leftEdge += stride
      rightEdge += stride
      fillStart += screenWidth
    }
  }

  // 整个区域的 damage 更新一次
  const regionRect = {
    x: damageMinX,
    y: startY,
    width: damageMaxX - damageMinX,
    height: maxY - startY,
  }
  if (screen.damage) {
    screen.damage = unionRect(screen.damage, regionRect)
  } else {
    screen.damage = regionRect
  }
}

/**
 * 在 [top, bottom] 范围内（包含，0 索引）移动全宽行。
 * n > 0 向上移动（模拟 CSI n S）；n < 0 向下移动（CSI n T）。
 * 空出的行被清除。不更新 damage。cells 和
 * noSelect 位图都被移动，因此当此操作应用于滚动
 * 快速路径期间的 next.screen 时，文本选区标记保持对齐。
 */
export function shiftRows(screen: Screen, top: number, bottom: number, n: number): void {
  if (n === 0 || top < 0 || bottom >= screen.height || top > bottom) {
    return
  }
  const w = screen.width
  const cells64 = screen.cells64
  const noSel = screen.noSelect
  const sw = screen.softWrap
  const absN = Math.abs(n)
  if (absN > bottom - top) {
    cells64.fill(EMPTY_CELL_VALUE, top * w, (bottom + 1) * w)
    noSel.fill(0, top * w, (bottom + 1) * w)
    sw.fill(0, top, bottom + 1)
    return
  }
  if (n > 0) {
    // SU：行 top+n..bottom → top..bottom-n；清除 bottom-n+1..bottom
    cells64.copyWithin(top * w, (top + n) * w, (bottom + 1) * w)
    noSel.copyWithin(top * w, (top + n) * w, (bottom + 1) * w)
    sw.copyWithin(top, top + n, bottom + 1)
    cells64.fill(EMPTY_CELL_VALUE, (bottom - n + 1) * w, (bottom + 1) * w)
    noSel.fill(0, (bottom - n + 1) * w, (bottom + 1) * w)
    sw.fill(0, bottom - n + 1, bottom + 1)
  } else {
    // SD：行 top..bottom+n → top-n..bottom；清除 top..top-n-1
    cells64.copyWithin((top - n) * w, top * w, (bottom + n + 1) * w)
    noSel.copyWithin((top - n) * w, top * w, (bottom + n + 1) * w)
    sw.copyWithin(top - n, top, bottom + n + 1)
    cells64.fill(EMPTY_CELL_VALUE, top * w, (top - n) * w)
    noSel.fill(0, top * w, (top - n) * w)
    sw.fill(0, top, top - n)
  }
}

// 匹配 OSC 8 ; ; URI BEL
const OSC8_REGEX = new RegExp(`^${ESC}\\]8${SEP}${SEP}([^${BEL}]*)${BEL}$`)
// OSC8 前缀：ESC ] 8 ; ——对绝大多数样式（SGR = ESC [）跳过正则的廉价检查
export const OSC8_PREFIX = `${ESC}]8${SEP}`

export function extractHyperlinkFromStyles(styles: AnsiCode[]): Hyperlink | null {
  for (const style of styles) {
    const code = style.code
    if (code.length < 5 || !code.startsWith(OSC8_PREFIX)) {
      continue
    }
    const match = code.match(OSC8_REGEX)
    if (match) {
      return match[1] || null
    }
  }
  return null
}

export function filterOutHyperlinkStyles(styles: AnsiCode[]): AnsiCode[] {
  return styles.filter(
    (style) => !style.code.startsWith(OSC8_PREFIX) || !OSC8_REGEX.test(style.code),
  )
}

// ---

/**
 * 返回两个屏幕之间所有更改的数组。供测试使用。
 * 生产代码应使用 diffEach() 以避免分配。
 */
export function diff(
  prev: Screen,
  next: Screen,
): [point: Point, removed: Cell | undefined, added: Cell | undefined][] {
  const output: [Point, Cell | undefined, Cell | undefined][] = []
  diffEach(
    prev,
    next,
    (x: number, y: number, removed: Cell | undefined, added: Cell | undefined) => {
      // 复制单元格，因为 diffEach 重用对象
      output.push([
        { x, y },
        removed ? { ...removed } : undefined,
        added ? { ...added } : undefined,
      ])
      return undefined
    },
  )
  return output
}

type DiffCallback = (
  x: number,
  y: number,
  removed: Cell | undefined,
  added: Cell | undefined,
) => boolean | undefined

/**
 * 类似 diff()，但对每次更改调用回调而非构建数组。
 * 重用两个 Cell 对象以避免每次更改的分配。回调必须不
 * 保留对 Cell 对象的引用——它们的内容每次调用都会被覆盖。
 *
 * 如果回调曾经返回 true，则返回 true（提前退出信号）。
 */
export function diffEach(prev: Screen, next: Screen, cb: DiffCallback): boolean {
  const prevWidth = prev.width
  const nextWidth = next.width
  const prevHeight = prev.height
  const nextHeight = next.height

  let region: Rectangle
  if (prevWidth === 0 && prevHeight === 0) {
    region = { x: 0, y: 0, width: nextWidth, height: nextHeight }
  } else if (next.damage) {
    region = next.damage
    if (prev.damage) {
      region = unionRect(region, prev.damage)
    }
  } else if (prev.damage) {
    region = prev.damage
  } else {
    region = { x: 0, y: 0, width: 0, height: 0 }
  }

  if (prevHeight > nextHeight) {
    region = unionRect(region, {
      x: 0,
      y: nextHeight,
      width: prevWidth,
      height: prevHeight - nextHeight,
    })
  }
  if (prevWidth > nextWidth) {
    region = unionRect(region, {
      x: nextWidth,
      y: 0,
      width: prevWidth - nextWidth,
      height: prevHeight,
    })
  }

  const maxHeight = Math.max(prevHeight, nextHeight)
  const maxWidth = Math.max(prevWidth, nextWidth)
  const endY = Math.min(region.y + region.height, maxHeight)
  const endX = Math.min(region.x + region.width, maxWidth)

  if (prevWidth === nextWidth) {
    return diffSameWidth(prev, next, region.x, endX, region.y, endY, cb)
  }
  return diffDifferentWidth(prev, next, region.x, endX, region.y, endY, cb)
}

/**
 * 扫描两个 Int32Array 之间下一个不同的单元格。
 * 返回第一个差异之前匹配的单元格数，
 * 如果所有单元格都匹配则返回 `count`。小巧纯净，适合 JIT 内联。
 */
function findNextDiff(a: Int32Array, b: Int32Array, w0: number, count: number): number {
  for (let i = 0; i < count; i++, w0 += 2) {
    const w1 = w0 | 1
    if (a[w0] !== b[w0] || a[w1] !== b[w1]) {
      return i
    }
  }
  return count
}

/**
 * 两个屏幕都在边界内时的行 diff。
 * 用 findNextDiff 扫描差异，解包并对每个差异调用 cb。
 */
function diffRowBoth(
  prevCells: Int32Array,
  nextCells: Int32Array,
  prev: Screen,
  next: Screen,
  ci: number,
  y: number,
  startX: number,
  endX: number,
  prevCell: Cell,
  nextCell: Cell,
  cb: DiffCallback,
): boolean {
  let x = startX
  while (x < endX) {
    const skip = findNextDiff(prevCells, nextCells, ci, endX - x)
    x += skip
    ci += skip << 1
    if (x >= endX) {
      break
    }
    cellAtCI(prev, ci, prevCell)
    cellAtCI(next, ci, nextCell)
    if (cb(x, y, prevCell, nextCell)) {
      return true
    }
    x++
    ci += 2
  }
  return false
}

/**
 * 对仅存在于 prev 中的行（高度缩小）发出移除。
 * 不能跳过空单元格——终端仍有上一帧的
 * 内容需要清除。
 */
function diffRowRemoved(
  prev: Screen,
  ci: number,
  y: number,
  startX: number,
  endX: number,
  prevCell: Cell,
  cb: DiffCallback,
): boolean {
  for (let x = startX; x < endX; x++, ci += 2) {
    cellAtCI(prev, ci, prevCell)
    if (cb(x, y, prevCell, undefined)) {
      return true
    }
  }
  return false
}

/**
 * 对仅存在于 next 中的行（高度增长）发出添加。
 * 跳过空/未写入的单元格。
 */
function diffRowAdded(
  nextCells: Int32Array,
  next: Screen,
  ci: number,
  y: number,
  startX: number,
  endX: number,
  nextCell: Cell,
  cb: DiffCallback,
): boolean {
  for (let x = startX; x < endX; x++, ci += 2) {
    if (nextCells[ci] === 0 && nextCells[ci | 1] === 0) {
      continue
    }
    cellAtCI(next, ci, nextCell)
    if (cb(x, y, undefined, nextCell)) {
      return true
    }
  }
  return false
}

/**
 * 对相同宽度的两个屏幕进行 diff。
 * 将每行分派到小型、JIT 友好的函数。
 */
function diffSameWidth(
  prev: Screen,
  next: Screen,
  startX: number,
  endX: number,
  startY: number,
  endY: number,
  cb: DiffCallback,
): boolean {
  const prevCells = prev.cells
  const nextCells = next.cells
  const width = prev.width
  const prevHeight = prev.height
  const nextHeight = next.height
  const stride = width << 1

  const prevCell: Cell = {
    char: ' ',
    styleId: 0,
    width: CellWidth.Narrow,
    hyperlink: undefined,
  }
  const nextCell: Cell = {
    char: ' ',
    styleId: 0,
    width: CellWidth.Narrow,
    hyperlink: undefined,
  }

  const rowEndX = Math.min(endX, width)
  let rowCI = (startY * width + startX) << 1

  for (let y = startY; y < endY; y++) {
    const prevIn = y < prevHeight
    const nextIn = y < nextHeight

    if (prevIn && nextIn) {
      if (
        diffRowBoth(
          prevCells,
          nextCells,
          prev,
          next,
          rowCI,
          y,
          startX,
          rowEndX,
          prevCell,
          nextCell,
          cb,
        )
      ) {
        return true
      }
    } else if (prevIn) {
      if (diffRowRemoved(prev, rowCI, y, startX, rowEndX, prevCell, cb)) {
        return true
      }
    } else if (nextIn) {
      if (diffRowAdded(nextCells, next, rowCI, y, startX, rowEndX, nextCell, cb)) {
        return true
      }
    }

    rowCI += stride
  }

  return false
}

/**
 * 回退方案：对不同宽度的两个屏幕进行 diff（窗口调整）。
 * prev 和 next 单元格数组使用独立的索引。
 */
function diffDifferentWidth(
  prev: Screen,
  next: Screen,
  startX: number,
  endX: number,
  startY: number,
  endY: number,
  cb: DiffCallback,
): boolean {
  const prevWidth = prev.width
  const nextWidth = next.width
  const prevCells = prev.cells
  const nextCells = next.cells

  const prevCell: Cell = {
    char: ' ',
    styleId: 0,
    width: CellWidth.Narrow,
    hyperlink: undefined,
  }
  const nextCell: Cell = {
    char: ' ',
    styleId: 0,
    width: CellWidth.Narrow,
    hyperlink: undefined,
  }

  const prevStride = prevWidth << 1
  const nextStride = nextWidth << 1
  let prevRowCI = (startY * prevWidth + startX) << 1
  let nextRowCI = (startY * nextWidth + startX) << 1

  for (let y = startY; y < endY; y++) {
    const prevIn = y < prev.height
    const nextIn = y < next.height
    const prevEndX = prevIn ? Math.min(endX, prevWidth) : startX
    const nextEndX = nextIn ? Math.min(endX, nextWidth) : startX
    const bothEndX = Math.min(prevEndX, nextEndX)

    let prevCI = prevRowCI
    let nextCI = nextRowCI

    for (let x = startX; x < bothEndX; x++) {
      if (
        prevCells[prevCI] === nextCells[nextCI] &&
        prevCells[prevCI + 1] === nextCells[nextCI + 1]
      ) {
        prevCI += 2
        nextCI += 2
        continue
      }
      cellAtCI(prev, prevCI, prevCell)
      cellAtCI(next, nextCI, nextCell)
      prevCI += 2
      nextCI += 2
      if (cb(x, y, prevCell, nextCell)) {
        return true
      }
    }

    if (prevEndX > bothEndX) {
      prevCI = prevRowCI + ((bothEndX - startX) << 1)
      for (let x = bothEndX; x < prevEndX; x++) {
        cellAtCI(prev, prevCI, prevCell)
        prevCI += 2
        if (cb(x, y, prevCell, undefined)) {
          return true
        }
      }
    }

    if (nextEndX > bothEndX) {
      nextCI = nextRowCI + ((bothEndX - startX) << 1)
      for (let x = bothEndX; x < nextEndX; x++) {
        if (nextCells[nextCI] === 0 && nextCells[nextCI | 1] === 0) {
          nextCI += 2
          continue
        }
        cellAtCI(next, nextCI, nextCell)
        nextCI += 2
        if (cb(x, y, undefined, nextCell)) {
          return true
        }
      }
    }

    prevRowCI += prevStride
    nextRowCI += nextStride
  }

  return false
}

/**
 * 将矩形区域标记为 noSelect（从文本选区中排除）。
 * 钳位到屏幕边界。当 <NoSelect> 框渲染时
 * 从 output.ts 调用。无 damage 追踪——noSelect 不影响终端输出，
 * 仅影响直接读取它的 getSelectedText/applySelectionOverlay。
 */
export function markNoSelectRegion(
  screen: Screen,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const maxX = Math.min(x + width, screen.width)
  const maxY = Math.min(y + height, screen.height)
  const noSel = screen.noSelect
  const stride = screen.width
  for (let row = Math.max(0, y); row < maxY; row++) {
    const rowStart = row * stride
    noSel.fill(1, rowStart + Math.max(0, x), rowStart + maxX)
  }
}
