import {
  type AnsiCode,
  type StyledChar,
  styledCharsFromTokens,
  tokenize,
} from '@alcalzone/ansi-tokenize'
import { logForDebugging } from '../utils/debug.js'
import { getGraphemeSegmenter } from '../utils/intl.js'
import sliceAnsi from '../utils/sliceAnsi.js'
import { reorderBidi } from './bidi.js'
import { type Rectangle, unionRect } from './layout/geometry.js'
import {
  blitRegion,
  CellWidth,
  clearRegion,
  extractHyperlinkFromStyles,
  filterOutHyperlinkStyles,
  markNoSelectRegion,
  OSC8_PREFIX,
  resetScreen,
  type Screen,
  type StylePool,
  setCellAt,
  shiftRows,
} from './screen.js'
import { stringWidth } from './stringWidth.js'
import { widestLine } from './widest-line.js'

/**
 * 带有预计算终端宽度、styleId 和 hyperlink 的字素簇。
 * 每个唯一行构建一次（通过 charCache 缓存），因此每字符热循环
 * 只是属性读取 + setCellAt — 每帧无 stringWidth、无样式内联、
 * 无 hyperlink 提取。
 *
 * styleId 可安全缓存：StylePool 是会话级别的（永不重置）。
 * hyperlink 存储为字符串（非内联 ID），因为 hyperlinkPool
 * 每 5 分钟重置一次；setCellAt 每帧内联它（便宜的 Map.get）。
 */
type ClusteredChar = {
  value: string
  width: number
  styleId: number
  hyperlink: string | undefined
}

/**
 * 收集来自渲染树的 write/blit/clear/clip 操作，然后
 * 在 `get()` 中将它们应用到 Screen 缓冲区。Screen 是用于
 * 与前一帧进行比较以生成终端更新的内容。
 */

type Options = {
  width: number
  height: number
  stylePool: StylePool
  /**
   * 要渲染的屏幕。使用前会重置。
   * 对于双缓冲，传入可复用的 screen。否则创建一个新的。
   */
  screen: Screen
}

export type Operation =
  | WriteOperation
  | ClipOperation
  | UnclipOperation
  | BlitOperation
  | ClearOperation
  | NoSelectOperation
  | ShiftOperation

type WriteOperation = {
  type: 'write'
  x: number
  y: number
  text: string
  /**
   * 每行软换行标志，与 text.split('\n') 并行。softWrap[i]=true
   * 表示第 i 行是第 i-1 行的延续（`\n` 之前由
   * 单词换行插入，而非源文件中的）。索引 0 始终为 false。
   * Undefined 表示生产者未跟踪换行（例如 fills、
   * raw-ansi）— 屏幕的每行位图保持不变。
   */
  softWrap?: boolean[]
}

type ClipOperation = {
  type: 'clip'
  clip: Clip
}

export type Clip = {
  x1: number | undefined
  x2: number | undefined
  y1: number | undefined
  y2: number | undefined
}

/**
 * 交叉两个 clip。轴上的 `undefined` 表示无界；另一个
 * clip 的边界获胜。如果两者都有界，取更紧的约束
 *（最大最小值，最小最大值）。如果结果区域为空
 *（x1 >= x2 或 y1 >= y2），被其裁剪的写入将被丢弃。
 */
function intersectClip(parent: Clip | undefined, child: Clip): Clip {
  if (!parent) {
    return child
  }
  return {
    x1: maxDefined(parent.x1, child.x1),
    x2: minDefined(parent.x2, child.x2),
    y1: maxDefined(parent.y1, child.y1),
    y2: minDefined(parent.y2, child.y2),
  }
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) {
    return b
  }
  if (b === undefined) {
    return a
  }
  return Math.max(a, b)
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) {
    return b
  }
  if (b === undefined) {
    return a
  }
  return Math.min(a, b)
}

type UnclipOperation = {
  type: 'unclip'
}

type BlitOperation = {
  type: 'blit'
  src: Screen
  x: number
  y: number
  width: number
  height: number
}

type ShiftOperation = {
  type: 'shift'
  top: number
  bottom: number
  n: number
}

type ClearOperation = {
  type: 'clear'
  region: Rectangle
  /**
   * 当清除是针对绝对定位节点的旧边界时设置。
   * 绝对节点覆盖普通流兄弟节点，所以它们的陈旧绘制是
   * 早期兄弟节点的干净子树 blit 错误地从
   * prevScreen 恢复的内容。普通流兄弟节点的清除没有这个问题 —
   * 它们的旧位置不可能被绘制在兄弟节点上方。
   */
  fromAbsolute?: boolean
}

type NoSelectOperation = {
  type: 'noSelect'
  region: Rectangle
}

export default class Output {
  width: number
  height: number
  private readonly stylePool: StylePool
  private screen: Screen

  private readonly operations: Operation[] = []

  private charCache: Map<string, ClusteredChar[]> = new Map()

  constructor(options: Options) {
    const { width, height, stylePool, screen } = options

    this.width = width
    this.height = height
    this.stylePool = stylePool
    this.screen = screen

    resetScreen(screen, width, height)
  }

  /**
   * 复用此 Output 用于新帧。归零屏幕缓冲区，清除
   * 操作列表（保留底层存储），并限制 charCache
   * 增长。跨帧保留 charCache 是主要优势 — 大多数
   * 行在渲染之间不变化，所以 tokenize + grapheme 聚类
   * 成为缓存命中。
   */
  reset(width: number, height: number, screen: Screen): void {
    this.width = width
    this.height = height
    this.screen = screen
    this.operations.length = 0
    resetScreen(screen, width, height)
    if (this.charCache.size > 16384) {
      this.charCache.clear()
    }
  }

  /**
   * 从屏幕区域复制单元格（blit = 块图像传输）。
   */
  blit(src: Screen, x: number, y: number, width: number, height: number): void {
    this.operations.push({ type: 'blit', src, x, y, width, height })
  }

  /**
   * 在 [top, bottom] 范围内移动全宽行。n > 0 = 向上。镜像
   * DECSTBM + SU/SD 对终端的操作。与 blit() 配对使用，在纯滚动期间
   * 复用 prevScreen 内容，避免完整子节点重新渲染。
   */
  shift(top: number, bottom: number, n: number): void {
    this.operations.push({ type: 'shift', top, bottom, n })
  }

  /**
   * 通过写入空单元格清除区域。用于节点缩小时
   * 确保上一帧的陈旧内容被移除。
   */
  clear(region: Rectangle, fromAbsolute?: boolean): void {
    this.operations.push({ type: 'clear', region, fromAbsolute })
  }

  /**
   * 标记区域为不可选择（从全屏文本
   * 选择复制 + 高亮中排除）。由 <NoSelect> 用于围栏
   * 装订线（行号、差异符号）。在 blit/write 之后应用，所以
   * 无论什么 blit 到该区域，标记都获胜。
   */
  noSelect(region: Rectangle): void {
    this.operations.push({ type: 'noSelect', region })
  }

  write(x: number, y: number, text: string, softWrap?: boolean[]): void {
    if (!text) {
      return
    }

    this.operations.push({
      type: 'write',
      x,
      y,
      text,
      softWrap,
    })
  }

  clip(clip: Clip) {
    this.operations.push({
      type: 'clip',
      clip,
    })
  }

  unclip() {
    this.operations.push({
      type: 'unclip',
    })
  }

  get(): Screen {
    const screen = this.screen
    const screenWidth = this.width
    const screenHeight = this.height

    // 跟踪 blit 与写入单元格数用于调试
    let blitCells = 0
    let writeCells = 0

    // 传递 1：展开 damage 以覆盖清除区域并实际清除
    // 屏幕缓冲区中的单元格。这防止了陈旧内容在
    // blit 从 prevScreen 复制或 damage 边界比
    // 旧内容窄时存活（例如，文本在同一行内缩小）。
    //
    // 同时收集来自绝对定位节点的清除。绝对
    // 节点覆盖普通流兄弟节点；当它缩小时，其清除被
    // 推送到那些兄弟节点的干净子树 blits 之后（DOM 顺序）。
    // blit 从 prevScreen 复制绝对节点自己的陈旧绘制，
    // 由于 clear 只是 damage-only，幽灵在 diff 中存活。普通
    // 流清除不需要这个 — 普通流节点的旧位置
    // 不可能被绘制在兄弟节点当前位置的上方。
    const absoluteClears: Rectangle[] = []
    for (const operation of this.operations) {
      if (operation.type !== 'clear') {
        continue
      }
      const { x, y, width, height } = operation.region
      const startX = Math.max(0, x)
      const startY = Math.max(0, y)
      const maxX = Math.min(x + width, screenWidth)
      const maxY = Math.min(y + height, screenHeight)
      if (startX >= maxX || startY >= maxY) {
        continue
      }
      const rect = {
        x: startX,
        y: startY,
        width: maxX - startX,
        height: maxY - startY,
      }
      screen.damage = screen.damage ? unionRect(screen.damage, rect) : rect
      clearRegion(screen, startX, startY, maxX - startX, maxY - startY)
      if (operation.fromAbsolute) {
        absoluteClears.push(rect)
      }
    }

    const clips: Clip[] = []

    for (const operation of this.operations) {
      switch (operation.type) {
        case 'clear':
          // 传递 1 中已处理
          continue

        case 'clip':
          // 与父 clip 交叉（如果有），这样嵌套的
          // overflow:hidden 盒子不能写入其祖先的
          // clip 区域之外。没有这个，在滚动框底部
          // 带有 overflow:hidden 的消息会推送它自己的 clip（基于其
          // 布局边界，已由 -scrollTop 转换），可以
          // 扩展到滚动框视口下方 — 写入逃逸到
          // 兄弟底部部分的行中。
          clips.push(intersectClip(clips.at(-1), operation.clip))
          continue

        case 'unclip':
          clips.pop()
          continue

        case 'blit': {
          // 使用 TypedArray.set() 从源屏幕区域批量复制单元格。
          // 跟踪 damage 确保 diff() 检查 blitted 单元格的陈旧内容
          // 当父节点 blit 了一个之前包含子节点内容的区域时。
          const {
            src,
            x: regionX,
            y: regionY,
            width: regionWidth,
            height: regionHeight,
          } = operation
          // 与 active clip 交叉 — 子节点的干净 blit 传递其完整
          // 缓存的 rect，但父 ScrollBox 可能已缩小（pill 挂载）。
          // 没有这个，blit 会写入超过 ScrollBox 新底边
          // 进入 pill 的行。
          const clip = clips.at(-1)
          const startX = Math.max(regionX, clip?.x1 ?? 0)
          const startY = Math.max(regionY, clip?.y1 ?? 0)
          const maxY = Math.min(
            regionY + regionHeight,
            screenHeight,
            src.height,
            clip?.y2 ?? Infinity,
          )
          const maxX = Math.min(regionX + regionWidth, screenWidth, src.width, clip?.x2 ?? Infinity)
          if (startX >= maxX || startY >= maxY) {
            continue
          }
          // 跳过被绝对定位节点清除覆盖的行。
          // 绝对节点覆盖普通流兄弟节点，所以 prevScreen 在
          // 该区域保存绝对节点的陈旧绘制 — blit
          // 会将其复制回来产生幽灵。见上方 absoluteClears 收集。
          if (absoluteClears.length === 0) {
            blitRegion(screen, src, startX, startY, maxX, maxY)
            blitCells += (maxY - startY) * (maxX - startX)
            continue
          }
          let rowStart = startY
          for (let row = startY; row <= maxY; row++) {
            const excluded =
              row < maxY &&
              absoluteClears.some(
                (r) => row >= r.y && row < r.y + r.height && startX >= r.x && maxX <= r.x + r.width,
              )
            if (excluded || row === maxY) {
              if (row > rowStart) {
                blitRegion(screen, src, startX, rowStart, maxX, row)
                blitCells += (row - rowStart) * (maxX - startX)
              }
              rowStart = row + 1
            }
          }
        }

        case 'shift': {
          shiftRows(screen, (operation as any).top, (operation as any).bottom, (operation as any).n)
        }

        case 'write': {
          const { text, softWrap } = operation as any
          let { x, y } = operation as any
          let lines = text.split('\n')
          let swFrom = 0
          let prevContentEnd = 0

          const clip = clips.at(-1)

          if (clip) {
            const clipHorizontally = typeof clip?.x1 === 'number' && typeof clip?.x2 === 'number'

            const clipVertically = typeof clip?.y1 === 'number' && typeof clip?.y2 === 'number'

            // 如果文本完全在裁剪区域之外，
            // 跳到下一个操作以避免不必要的计算
            if (clipHorizontally) {
              const width = widestLine(text)

              if (x + width <= clip.x1! || x >= clip.x2!) {
                continue
              }
            }

            if (clipVertically) {
              const height = lines.length

              if (y + height <= clip.y1! || y >= clip.y2!) {
                continue
              }
            }

            if (clipHorizontally) {
              lines = lines.map((line) => {
                const from = x < clip.x1! ? clip.x1! - x : 0
                const width = stringWidth(line)
                const to = x + width > clip.x2! ? clip.x2! - x : width
                let sliced = sliceAnsi(line, from, to)
                // 宽字符（CJK、emoji）占用 2 个单元格。当 `to` 落在
                // 宽字符的第一个单元格上时，sliceAnsi 包含
                // 整个字形并导致结果溢出 clip.x2 一个单元格，
                // 将 SpacerTail 写入相邻兄弟节点。重新切片
                // 一个单元格之前；宽字符正好是 2 个单元格，所以
                // 一次重试总是合适。
                if (stringWidth(sliced) > to - from) {
                  sliced = sliceAnsi(line, from, to - 1)
                }
                return sliced
              })

              if (x < clip.x1!) {
                x = clip.x1!
              }
            }

            if (clipVertically) {
              const from = y < clip.y1! ? clip.y1! - y : 0
              const height = lines.length
              const to = y + height > clip.y2! ? clip.y2! - y : height

              // 如果第一行可见行是软换行延续，我们
              // 需要裁剪的前一行内容末尾，这样
              // screen.softWrap[lineY] 正确记录连接点
              // 即使该行的单元格从未被写入。
              if (softWrap && from > 0 && softWrap[from] === true) {
                prevContentEnd = x + stringWidth(lines[from - 1]!)
              }

              lines = lines.slice(from, to)
              swFrom = from

              if (y < clip.y1!) {
                y = clip.y1!
              }
            }
          }

          const swBits = screen.softWrap
          let offsetY = 0

          for (const line of lines) {
            const lineY = y + offsetY
            // 如果 `text` 高于屏幕高度，行可能在屏幕外
            if (lineY >= screenHeight) {
              break
            }
            const contentEnd = writeLineToScreen(
              screen,
              line,
              x,
              lineY,
              screenWidth,
              this.stylePool,
              this.charCache,
            )
            writeCells += contentEnd - x
            // 见 Screen.softWrap 文档字符串了解编码。contentEnd
            // 来自 writeLineToScreen 是制表符展开感知的，不同于
            // x+stringWidth(line) 将制表符视为宽度 0。
            if (softWrap) {
              const isSW = softWrap[swFrom + offsetY] === true
              swBits[lineY] = isSW ? prevContentEnd : 0
              prevContentEnd = contentEnd
            }
            offsetY++
          }
        }
      }
    }

    // noSelect 操作放在最后，这样它们优先于 blits（从 prevScreen 复制 noSelect）
    // 和 writes（不触及 noSelect）。这样
    // <NoSelect> 盒子正确地围栏其区域，即使父节点
    // 执行 blit，并且在帧之间移动 <NoSelect> 时正确地清除旧区域
    //（resetScreen 已经将位图归零）。
    for (const operation of this.operations) {
      if (operation.type === 'noSelect') {
        const { x, y, width, height } = operation.region
        markNoSelectRegion(screen, x, y, width, height)
      }
    }

    // 记录 blit/写入比例用于调试 - 高写入比例表明 blitting 未正常工作
    const totalCells = blitCells + writeCells
    if (totalCells > 1000 && writeCells > blitCells) {
      logForDebugging(
        `High write ratio: blit=${blitCells}, write=${writeCells} (${((writeCells / totalCells) * 100).toFixed(1)}% writes), screen=${screenHeight}x${screenWidth}`,
      )
    }

    return screen
  }
}

function stylesEqual(a: AnsiCode[], b: AnsiCode[]): boolean {
  if (a === b) {
    return true // Reference equality fast path
  }
  const len = a.length
  if (len !== b.length) {
    return false
  }
  if (len === 0) {
    return true // Both empty
  }
  for (let i = 0; i < len; i++) {
    if (a[i]!.code !== b[i]!.code) {
      return false
    }
  }
  return true
}

/**
 * 将带有 ANSI 码的字符串转换为带有正确字素
 * 聚类的带样式字符。修复 ansi-tokenize 将字素簇（如家庭
 * emoji）拆分为单个码点的问题。
 *
 * 还为每个样式运行预计算 styleId + hyperlink（不是每个字符）—
 * 一个 80 字符的行有 3 个样式运行，执行 3 次 intern 调用而不是 80 次。
 */
function styledCharsWithGraphemeClustering(
  chars: StyledChar[],
  stylePool: StylePool,
): ClusteredChar[] {
  const charCount = chars.length
  if (charCount === 0) {
    return []
  }

  const result: ClusteredChar[] = []
  const bufferChars: string[] = []
  let bufferStyles: AnsiCode[] = chars[0]!.styles

  for (let i = 0; i < charCount; i++) {
    const char = chars[i]!
    const styles = char.styles

    // 样式不同，所以需要刷新并开始新缓冲区
    if (bufferChars.length > 0 && !stylesEqual(styles, bufferStyles)) {
      flushBuffer(bufferChars.join(''), bufferStyles, stylePool, result)
      bufferChars.length = 0
    }

    bufferChars.push(char.value)
    bufferStyles = styles
  }

  // 最终刷新
  if (bufferChars.length > 0) {
    flushBuffer(bufferChars.join(''), bufferStyles, stylePool, result)
  }

  return result
}

function flushBuffer(
  buffer: string,
  styles: AnsiCode[],
  stylePool: StylePool,
  out: ClusteredChar[],
): void {
  // 为整个样式运行计算 styleId + hyperlink 一次。
  // 此缓冲区中的每个字素共享相同的样式。
  //
  // 单独提取和跟踪 hyperlink，从样式中过滤。
  // 始终检查 OSC 8 代码以过滤，不仅在提取 URL 时。
  // 分词器将 OSC 8 关闭代码（空 URL）视为
  // 活动样式，所以即使没有 hyperlink
  // URL 存在也必须过滤。
  const hyperlink = extractHyperlinkFromStyles(styles) ?? undefined
  const hasOsc8Styles =
    hyperlink !== undefined ||
    styles.some((s) => s.code.length >= OSC8_PREFIX.length && s.code.startsWith(OSC8_PREFIX))
  const filteredStyles = hasOsc8Styles ? filterOutHyperlinkStyles(styles) : styles
  const styleId = stylePool.intern(filteredStyles)

  for (const { segment: grapheme } of getGraphemeSegmenter().segment(buffer)) {
    out.push({
      value: grapheme,
      width: stringWidth(grapheme),
      styleId,
      hyperlink,
    })
  }
}

/**
 * 将单行字符写入屏幕缓冲区。
 * 从 Output.get() 中提取，这样 JSC 可以优化这个紧密的
 * 单态循环独立运行 — 更好的寄存器分配、
 * setCellAt 内联和类型反馈，而不是埋在
 * 300 行的分发函数中。
 *
 * 返回结束列（x + 视觉宽度，包括制表符展开）这样
 * 调用者可以在 screen.softWrap 中记录它，而无需通过 stringWidth() 重新遍历
 * 行。调用者将调试单元格数计算为 end-x。
 */
function writeLineToScreen(
  screen: Screen,
  line: string,
  x: number,
  y: number,
  screenWidth: number,
  stylePool: StylePool,
  charCache: Map<string, ClusteredChar[]>,
): number {
  let characters = charCache.get(line)
  if (!characters) {
    characters = reorderBidi(
      styledCharsWithGraphemeClustering(styledCharsFromTokens(tokenize(line)), stylePool),
    )
    charCache.set(line, characters)
  }

  let offsetX = x

  for (let charIdx = 0; charIdx < characters.length; charIdx++) {
    const character = characters[charIdx]!
    const codePoint = character.value.codePointAt(0)

    // 处理导致光标移动不匹配的 C0 控制字符（0x00-0x1F）。
    // stringWidth 将它们视为宽度 0，但终端可能
    // 以不同方式移动光标。
    if (codePoint !== undefined && codePoint <= 0x1f) {
      // 制表符（0x09）：展开为空格以到达下一个制表位
      if (codePoint === 0x09) {
        const tabWidth = 8
        const spacesToNextStop = tabWidth - (offsetX % tabWidth)
        for (let i = 0; i < spacesToNextStop && offsetX < screenWidth; i++) {
          setCellAt(screen, offsetX, y, {
            char: ' ',
            styleId: stylePool.none,
            width: CellWidth.Narrow,
            hyperlink: undefined,
          })
          offsetX++
        }
      }
      // ESC（0x1B）：跳过 ansi-tokenize 未识别的不完整转义序列。
      // ansi-tokenize 只解析 SGR 序列（ESC[...m）
      // 和 OSC 8 hyperlink（ESC]8;;url BEL）。其他序列如光标
      // 移动、屏幕清除或终端标题成为单个字符
      // 令牌，我们需要在这里跳过它们。
      else if (codePoint === 0x1b) {
        const nextChar = characters[charIdx + 1]?.value
        const nextCode = nextChar?.codePointAt(0)
        if (nextChar === '(' || nextChar === ')' || nextChar === '*' || nextChar === '+') {
          // 字符集选择：ESC ( X、ESC ) X 等。
          // 跳过中间字符和字符集指示符
          charIdx += 2
        } else if (nextChar === '[') {
          // CSI 序列：ESC [ ... final-byte
          // Final byte 在 0x40-0x7E 范围内（@、A-Z、[\]^_`、a-z、{|}~）
          // 例如：ESC[2J（清除）、ESC[?25l（光标隐藏）、ESC[H（归位）
          charIdx++ // 跳过 [
          while (charIdx < characters.length - 1) {
            charIdx++
            const c = characters[charIdx]?.value.codePointAt(0)
            // Final byte 终止序列
            if (c !== undefined && c >= 0x40 && c <= 0x7e) {
              break
            }
          }
        } else if (
          nextChar === ']' ||
          nextChar === 'P' ||
          nextChar === '_' ||
          nextChar === '^' ||
          nextChar === 'X'
        ) {
          // 基于字符串的序列由 BEL（0x07）或 ST（ESC \）终止：
          // - OSC：ESC ] ...（操作系统命令）
          // - DCS：ESC P ...（设备控制字符串）
          // - APC：ESC _ ...（应用程序命令）
          // - PM： ESC ^ ...（隐私消息）
          // - SOS：ESC X ...（字符串开始）
          charIdx++ // 跳过引入字符
          while (charIdx < characters.length - 1) {
            charIdx++
            const c = characters[charIdx]?.value
            // BEL（0x07）终止序列
            if (c === '\x07') {
              break
            }
            // ST（字符串终止符）是 ESC \
            // 当我们看到 ESC 时，检查下一个字符是否是反斜杠
            if (c === '\x1b') {
              const nextC = characters[charIdx + 1]?.value
              if (nextC === '\\') {
                charIdx++ // 也跳过反斜杠
                break
              }
            }
          }
        } else if (nextCode !== undefined && nextCode >= 0x30 && nextCode <= 0x7e) {
          // 单字符转义序列：ESC 后跟 0x30-0x7E
          //（排除已处理的多字符引入符）
          // - Fp 范围（0x30-0x3F）：ESC 7（保存光标）、ESC 8（恢复）
          // - Fe 范围（0x40-0x5F）：ESC D（索引）、ESC M（反向索引）
          // - Fs 范围（0x60-0x7E）：ESC c（重置）
          charIdx++ // 跳过命令字符
        }
      }
      // 回车（0x0D）：将光标移动到第 0 列，跳过它
      // 退格（0x08）：将光标左移，跳过它
      // 响铃（0x07）、垂直制表（0x0B）、换页（0x0C）：跳过
      // 所有其他控制字符（0x00-0x06、0x0E-0x1F）：跳过
      // 注意：换行（0x0A）已由行分割处理
      continue
    }

    // 零宽度字符（组合标记、ZWNJ、ZWS 等）
    // 不占用终端单元格 — 将它们存储为 Narrow 单元格
    // 会使虚拟光标与实际终端光标不同步。
    // 宽度已在聚类时计算一次（通过 charCache 缓存）。
    const charWidth = character.width
    if (charWidth === 0) {
      continue
    }

    const isWideCharacter = charWidth >= 2

    // 宽字符在最后一列无法容纳 — 终端会将其换行到
    // 下一行，使我们的光标模型不同步。放置一个 SpacerHead
    // 标记空白列，匹配终端行为。
    if (isWideCharacter && offsetX + 2 > screenWidth) {
      setCellAt(screen, offsetX, y, {
        char: ' ',
        styleId: stylePool.none,
        width: CellWidth.SpacerHead,
        hyperlink: undefined,
      })
      offsetX++
      continue
    }

    // styleId + hyperlink 在聚类时预计算（每个
    // 样式运行一次，通过 charCache 缓存）。热循环现在只是属性
    // 读取 — 每帧无 intern、无 extract、无 filter。
    setCellAt(screen, offsetX, y, {
      char: character.value,
      styleId: character.styleId,
      width: isWideCharacter ? CellWidth.Wide : CellWidth.Narrow,
      hyperlink: character.hyperlink,
    })
    offsetX += isWideCharacter ? 2 : 1
  }

  return offsetX
}
