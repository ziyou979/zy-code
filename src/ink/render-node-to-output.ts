import indentString from 'indent-string'
import { applyTextStyles } from './colorize.js'
import type { DOMElement } from './dom.js'
import getMaxWidth from './get-max-width.js'
import type { Rectangle } from './layout/geometry.js'
import { LayoutDisplay, LayoutEdge, type LayoutNode } from './layout/node.js'
import { nodeCache, pendingClears } from './node-cache.js'
import type Output from './output.js'
import renderBorder from './render-border.js'
import type { Screen } from './screen.js'
import { type StyledSegment, squashTextNodesToSegments } from './squash-text-nodes.js'
import type { Color } from './styles.js'
import { isXtermJs } from './terminal.js'
import { widestLine } from './widest-line.js'
import wrapText from './wrap-text.js'

// 匹配 ScrollKeybindingHandler.tsx 中的 detectXtermJsWheel() — 曲线
// 和 drain 必须在终端检测上保持一致。TERM_PROGRAM 检查是同步
// 回退方案；isXtermJs() 是权威的 XTVERSION 探测结果。
function isXtermJsHost(): boolean {
  return process.env.TERM_PROGRAM === 'vscode' || isXtermJs()
}

// 每帧暂存数据：当任何节点的 yoga 位置/尺寸与其
// 缓存值不同，或有子节点被移除时设置。ink.tsx 读取它以决定
// 本帧是否需要全量损坏的重锤（PR #20120）。
// 在 alt-screen 和 main-screen 上均生效。稳态帧
//（spinner 跳动、时钟跳动、文本追加到固定高度框）不会
// 改变布局 → 窄化损坏范围 → O(变化单元格) 的 diff 而非
// O(行数×列数)。
let layoutShifted = false

export function resetLayoutShifted(): void {
  layoutShifted = false
}

export function didLayoutShift(): boolean {
  return layoutShifted
}

// DECSTBM 滚动优化提示。当 ScrollBox 的 scrollTop 在
// 帧之间变化（且没有其他移动）时，log-update.ts 可以发出
// 硬件滚动（DECSTBM + SU/SD）而非重写整个
// 视口。top/bottom 是 0 索引的包含性屏幕行；delta > 0 =
// 内容上移（scrollTop 增加，CSI n S）。
export type ScrollHint = { top: number; bottom: number; delta: number }
let scrollHint: ScrollHint | null = null

// 上一帧中 position:absolute 节点的矩形，供
// ScrollBox 的 blit+shift 第三遍修复使用（见使用处）。记录在
// 三个路径 — 全渲染 nodeCache.set、节点级 blit 提前返回、
// blitEscapingAbsoluteDescendants — 因此干净覆盖层的连续滚动
// 仍然保有该矩形。
let absoluteRectsPrev: Rectangle[] = []
let absoluteRectsCur: Rectangle[] = []

export function resetScrollHint(): void {
  scrollHint = null
  absoluteRectsPrev = absoluteRectsCur
  absoluteRectsCur = []
}

export function getScrollHint(): ScrollHint | null {
  return scrollHint
}

// 本帧 drain 后仍留有 pendingScrollDelta 的 ScrollBox DOM 节点（如果有）。
// renderer.ts 在渲染后调用 markDirty(it)，使下一帧的根 blit 检查
// 失败，从而继续 descend 以继续 drain。
// 没有这个的话，在 scrollbox 的 dirty 标志被清除后（约第 721 行），
// 下一帧会 blit root 而永远无法到达 scrollbox — drain 就会停滞。
let scrollDrainNode: DOMElement | null = null

export function resetScrollDrainNode(): void {
  scrollDrainNode = null
}

export function getScrollDrainNode(): DOMElement | null {
  return scrollDrainNode
}

// 本帧中触底跟随滚动事件。当流式内容
// 触发 scrollTop = maxScroll 时，ScrollBox 将 delta +
// 视口边界记录在此。ink.tsx 在渲染后消费它以将任何活跃
// 文本选择平移 -delta，使高亮保持锚定在文本上
//（原生终端行为 — 选择随内容滚动而上移，最终在顶部裁剪）。
// 此时 frontFrame 屏幕缓冲区仍持有旧内容 — captureScrolledRows
// 在 front/back 交换之前从中读取以保留复制文本。
export type FollowScroll = {
  delta: number
  viewportTop: number
  viewportBottom: number
}
let followScroll: FollowScroll | null = null

export function consumeFollowScroll(): FollowScroll | null {
  const f = followScroll
  followScroll = null
  return f
}

// ── 原生终端 drain（iTerm2/Ghostty 等 — 比例事件）──
// 每帧应用的最小行数。超过此值后，drain 按比例（约 3/4
// 剩余量）执行，因此大突发可在 log₄ 帧内追上，而尾部
// 平滑减速。硬上限为 innerHeight-1 以触发 DECSTBM 提示。
const SCROLL_MIN_PER_FRAME = 4

// ── xterm.js（VS Code）平滑 drain ──
// 低待处理量（≤5）在一帧内全部 drain — 慢速滚轮点击应
// 即时完成（点击 → 可见跳转 → 完成），而非微抖动的 1 行帧。
// 较高待处理量以小的固定步长 drain，使快速滚动动画
// 保持平滑（无大跳跃）。待处理量 >MAX 时将多余部分截断。
const SCROLL_INSTANT_THRESHOLD = 5 // ≤ this: drain all at once
const SCROLL_HIGH_PENDING = 12 // threshold for HIGH step
const SCROLL_STEP_MED = 2 // pending (INSTANT, HIGH): catch-up
const SCROLL_STEP_HIGH = 3 // pending ≥ HIGH: fast flick
const SCROLL_MAX_PENDING = 30 // snap excess beyond this

// xterm.js 自适应 drain。返回已应用的行数；会修改 pendingScrollDelta。
function drainAdaptive(node: DOMElement, pending: number, innerHeight: number): number {
  const sign = pending > 0 ? 1 : -1
  let abs = Math.abs(pending)
  let applied = 0
  // 截断超出动画窗口的多余部分，使大幅闪动不会惯性滑行。
  if (abs > SCROLL_MAX_PENDING) {
    applied += sign * (abs - SCROLL_MAX_PENDING)
    abs = SCROLL_MAX_PENDING
  }
  // ≤5: 全部 drain（慢速点击 = 即时）。以上：小的固定步长。
  const step =
    abs <= SCROLL_INSTANT_THRESHOLD
      ? abs
      : abs < SCROLL_HIGH_PENDING
        ? SCROLL_STEP_MED
        : SCROLL_STEP_HIGH
  applied += sign * step
  const rem = abs - step
  // 将总量限制在 innerHeight-1 以内，以触发 DECSTBM blit+shift 快速路径
  //（与 drainProportional 一致）。多余部分留在 pendingScrollDelta 中。
  const cap = Math.max(1, innerHeight - 1)
  const totalAbs = Math.abs(applied)
  if (totalAbs > cap) {
    const excess = totalAbs - cap
    node.pendingScrollDelta = sign * (rem + excess)
    return sign * cap
  }
  node.pendingScrollDelta = rem > 0 ? sign * rem : undefined
  return applied
}

// 原生比例 drain。step = max(MIN, floor(abs*3/4))，限制在
// innerHeight-1 以内以触发 DECSTBM + blit+shift 快速路径。
function drainProportional(node: DOMElement, pending: number, innerHeight: number): number {
  const abs = Math.abs(pending)
  const cap = Math.max(1, innerHeight - 1)
  const step = Math.min(cap, Math.max(SCROLL_MIN_PER_FRAME, (abs * 3) >> 2))
  if (abs <= step) {
    node.pendingScrollDelta = undefined
    return pending
  }
  const applied = pending > 0 ? step : -step
  node.pendingScrollDelta = pending - applied
  return applied
}

// OSC 8 超链接转义序列。空参数 (;;) — ansi-tokenize 仅
// 识别这个确切前缀。id= 参数（用于分组换行）
// 在 termio/osc.ts link() 中的终端输出时添加。
const OSC = '\u001B]'
const BEL = '\u0007'

function wrapWithOsc8Link(text: string, url: string): string {
  return `${OSC}8;;${url}${BEL}${text}${OSC}8;;${BEL}`
}

/**
 * 构建纯文本中每个字符位置到其 segment 索引的映射。
 * 返回一个数组，其中 charToSegment[i] 是字符 i 的 segment 索引。
 */
function buildCharToSegmentMap(segments: StyledSegment[]): number[] {
  const map: number[] = []
  for (let i = 0; i < segments.length; i++) {
    const len = segments[i]!.text.length
    for (let j = 0; j < len; j++) {
      map.push(i)
    }
  }
  return map
}

/**
 * 对换行后的文本应用样式，将每个字符映射回其原始 segment。
 * 即使文本跨行换行，也能保留每个 segment 的样式。
 *
 * @param trimEnabled - 是否启用空白修剪（wrap-trim 模式）。
 *   为 true 时，跳过原始文本中被修剪掉的空白。
 *   为 false 时（wrap 模式），保留所有空白，因此无需跳过。
 */
function applyStylesToWrappedText(
  wrappedPlain: string,
  segments: StyledSegment[],
  charToSegment: number[],
  originalPlain: string,
  trimEnabled: boolean = false,
): string {
  const lines = wrappedPlain.split('\n')
  const resultLines: string[] = []

  let charIndex = 0
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!

    // 在 trim 模式下，跳过本行开头被修剪掉的空白。
    // 仅当原始文本有空白但输出行不以空白开头时才跳过
    //（意味着已被修剪）。如果两者都有空白，则
    // 空白被保留了，不应跳过。
    if (trimEnabled && line.length > 0) {
      const lineStartsWithWhitespace = /\s/.test(line[0]!)
      const originalHasWhitespace =
        charIndex < originalPlain.length && /\s/.test(originalPlain[charIndex]!)

      // 仅当原始文本有空白但行没有时才跳过
      if (originalHasWhitespace && !lineStartsWithWhitespace) {
        while (charIndex < originalPlain.length && /\s/.test(originalPlain[charIndex]!)) {
          charIndex++
        }
      }
    }

    let styledLine = ''
    let runStart = 0
    let runSegmentIndex = charToSegment[charIndex] ?? 0

    for (let i = 0; i < line.length; i++) {
      const currentSegmentIndex = charToSegment[charIndex] ?? runSegmentIndex

      if (currentSegmentIndex !== runSegmentIndex) {
        // 刷出当前 run
        const runText = line.slice(runStart, i)
        const segment = segments[runSegmentIndex]
        if (segment) {
          let styled = applyTextStyles(runText, segment.styles)
          if (segment.hyperlink) {
            styled = wrapWithOsc8Link(styled, segment.hyperlink)
          }
          styledLine += styled
        } else {
          styledLine += runText
        }
        runStart = i
        runSegmentIndex = currentSegmentIndex
      }

      charIndex++
    }

    // 刷出最后一个 run
    const runText = line.slice(runStart)
    const segment = segments[runSegmentIndex]
    if (segment) {
      let styled = applyTextStyles(runText, segment.styles)
      if (segment.hyperlink) {
        styled = wrapWithOsc8Link(styled, segment.hyperlink)
      }
      styledLine += styled
    } else {
      styledLine += runText
    }

    resultLines.push(styledLine)

    // 跳过原始文本中对应于此换行的换行符。
    // 当原始文本包含实际换行符（而不仅仅是
    // 换行插入的换行符）时需要此操作。没有这个，charIndex 会不同步，
    // 因为换行符存在于 originalPlain/charToSegment 中但不在
    // split 后的行中。
    if (charIndex < originalPlain.length && originalPlain[charIndex] === '\n') {
      charIndex++
    }

    // 在 trim 模式下，跳过换行时被换行符替换的空白。
    // 我们跳过原始文本中的空白，直到遇到与下一行首字符
    // 匹配的字符。这处理了如下情况：
    // - "AB   \tD" 换行成 "AB\n\tD" — 跳过空格直到遇到 tab
    // 在非 trim 模式下，空白被保留，因此无需跳过。
    if (trimEnabled && lineIdx < lines.length - 1) {
      const nextLine = lines[lineIdx + 1]!
      const nextLineFirstChar = nextLine.length > 0 ? nextLine[0] : null

      // 跳过空白，直到遇到匹配下一行首字符的字符
      while (charIndex < originalPlain.length && /\s/.test(originalPlain[charIndex]!)) {
        // 如果找到了下一行开头的字符则停止
        if (nextLineFirstChar !== null && originalPlain[charIndex] === nextLineFirstChar) {
          break
        }
        charIndex++
      }
    }
  }

  return resultLines.join('\n')
}

/**
 * 换行文本并记录哪些输出行是软换行延续行
 *（即行前的 `\n` 是由 word-wrap 插入的，而非来自
 * 源文本）。wrapAnsi 已经独立处理每个输入行，因此
 * 此处逐输入行换行与单次整体字符串换行输出相同，
 * 同时让我们可以标记每块的来源。
 * 截断模式永远不会添加换行（cli-truncate 是整体字符串操作），所以
 * 它们直接走默认分支，softWrap 为 undefined — 不追踪，行为
 * 与 pre-softWrap 路径不变。
 */
function wrapWithSoftWrap(
  plainText: string,
  maxWidth: number,
  textWrap: Parameters<typeof wrapText>[2],
): { wrapped: string; softWrap: boolean[] | undefined } {
  if (textWrap !== 'wrap' && textWrap !== 'wrap-trim') {
    return {
      wrapped: wrapText(plainText, maxWidth, textWrap),
      softWrap: undefined,
    }
  }
  const origLines = plainText.split('\n')
  const outLines: string[] = []
  const softWrap: boolean[] = []
  for (const orig of origLines) {
    const pieces = wrapText(orig, maxWidth, textWrap).split('\n')
    for (let i = 0; i < pieces.length; i++) {
      outLines.push(pieces[i]!)
      softWrap.push(i > 0)
    }
  }
  return { wrapped: outLines.join('\n'), softWrap }
}

// 如果父容器是 `<Box>`，文本节点将被视为树中的独立节点
// 并在布局中拥有自己的坐标。
// 为确保文本节点正确对齐，取第一个文本节点的 X 和 Y
// 并将其作为其余节点的偏移量
// 仅考虑第一个节点，因为其他文本节点不能有 margin 或 padding，
// 所以它们的坐标将相对于第一个节点
function applyPaddingToText(node: DOMElement, text: string, softWrap?: boolean[]): string {
  const yogaNode = node.childNodes[0]?.yogaNode

  if (yogaNode) {
    const offsetX = yogaNode.getComputedLeft()
    const offsetY = yogaNode.getComputedTop()
    text = '\n'.repeat(offsetY) + indentString(text, offsetX)
    if (softWrap && offsetY > 0) {
      // 为每个 padding 行前置 `false`，使索引保持对齐
      // 与 text.split('\n')。就地修改 — 调用者拥有该数组。
      softWrap.unshift(...Array<boolean>(offsetY).fill(false))
    }
  }

  return text
}

// 节点布局完成后，将每个节点渲染到 output 对象，随后渲染到终端
function renderNodeToOutput(
  node: DOMElement,
  output: Output,
  {
    offsetX = 0,
    offsetY = 0,
    prevScreen,
    skipSelfBlit = false,
    inheritedBackgroundColor,
  }: {
    offsetX?: number
    offsetY?: number
    prevScreen: Screen | undefined
    // 强制此节点 descend 而非 blit 自己的矩形，同时
    // 仍将 prevScreen 传递给子节点。用于非不透明绝对
    // 覆盖层覆盖在损坏的裁剪区域上：覆盖层的完整矩形有
    // 透明间隙（prevScreen 中的陈旧底层内容），但其
    // 不透明后代的较窄矩形可以安全 blit。
    skipSelfBlit?: boolean
    inheritedBackgroundColor?: Color
  },
): void {
  const { yogaNode } = node

  if (yogaNode) {
    if (yogaNode.getDisplay() === LayoutDisplay.None) {
      // 如果节点之前可见现在隐藏，清除旧位置
      if (node.dirty) {
        const cached = nodeCache.get(node)
        if (cached) {
          output.clear({
            x: Math.floor(cached.x),
            y: Math.floor(cached.y),
            width: Math.floor(cached.width),
            height: Math.floor(cached.height),
          })
          // 也清除后代的缓存 — hideInstance 的 markDirty 只向上
          // 遍历，因此后代的 .dirty 保持 false。它们的 nodeCache 条目
          // 会保留隐藏前的矩形。取消隐藏时，如果位置没有变化，
          // 约第 432 行的 blit 检查会通过并从 prevScreen 复制 EMPTY 单元格
          //（在此处清除）→ 内容消失。
          dropSubtreeCache(node)
          layoutShifted = true
        }
      }
      return
    }

    // Yoga 中的 Left 和 Top 位置相对于其父节点
    const x = offsetX + yogaNode.getComputedLeft()
    const yogaTop = yogaNode.getComputedTop()
    let y = offsetY + yogaTop
    const width = yogaNode.getComputedWidth()
    const height = yogaNode.getComputedHeight()

    // 绝对定位的覆盖层（如 bottom='100%' 的自动完成菜单）
    // 在延伸到视口上方时会计算出负的屏幕 y。如果不
    // 钳位，setCellAt 会丢弃 y<0 的单元格，裁剪掉内容的顶部
    //（自动完成中的最佳匹配）。通过钳位到 0，我们将元素
    // 下移使顶部行可见，底部在下方溢出 —
    // opaque 属性确保它覆盖下面的任何内容。
    if (y < 0 && node.style.position === 'absolute') {
      y = 0
    }

    // 检查是否可以跳过此子树（干净节点且布局未变）。
    // 从上一屏 blit 单元格而非重新渲染。
    const cached = nodeCache.get(node)
    if (
      !node.dirty &&
      !skipSelfBlit &&
      node.pendingScrollDelta === undefined &&
      cached &&
      cached.x === x &&
      cached.y === y &&
      cached.width === width &&
      cached.height === height &&
      prevScreen
    ) {
      const fx = Math.floor(x)
      const fy = Math.floor(y)
      const fw = Math.floor(width)
      const fh = Math.floor(height)
      output.blit(prevScreen, fx, fy, fw, fh)
      if (node.style.position === 'absolute') {
        absoluteRectsCur.push(cached)
      }
      // 绝对后代可能绘制在此节点布局边界之外
      //（如 position='absolute' bottom='100%' 的斜杠菜单浮在上方）。
      // 如果损坏的兄弟节点重新渲染并覆盖了这些
      // 单元格，上面的 blit 仅恢复了此节点自己的矩形 —
      // 绝对后代的单元格丢失了。从 prevScreen 重新 blit 它们
      // 使覆盖层得以保留。
      blitEscapingAbsoluteDescendants(node, output, prevScreen, fx, fy, fw, fh)
      return
    }

    // 重新渲染时清除旧位置的陈旧内容。
    // Dirty: 内容变化。Moved: 位置/尺寸变化（例如，上方的兄弟节点
    // 改变了高度），旧单元格仍在终端上。
    const positionChanged =
      cached !== undefined &&
      (cached.x !== x || cached.y !== y || cached.width !== width || cached.height !== height)
    if (positionChanged) {
      layoutShifted = true
    }
    if (cached && (node.dirty || positionChanged)) {
      output.clear(
        {
          x: Math.floor(cached.x),
          y: Math.floor(cached.y),
          width: Math.floor(cached.width),
          height: Math.floor(cached.height),
        },
        node.style.position === 'absolute',
      )
    }

    // 在删除之前读取 — hasRemovedChild 禁用 prevScreen blitting
    // 以防止兄弟节点恢复陈旧的溢出内容。
    const clears = pendingClears.get(node)
    const hasRemovedChild = clears !== undefined
    if (hasRemovedChild) {
      layoutShifted = true
      for (const rect of clears) {
        output.clear({
          x: Math.floor(rect.x),
          y: Math.floor(rect.y),
          width: Math.floor(rect.width),
          height: Math.floor(rect.height),
        })
      }
      pendingClears.delete(node)
    }

    // Yoga 将此节点压缩到零高度（在高度受限的
    // 父节点中溢出）且兄弟节点落在相同的 y 上。跳过渲染 — 两者都会
    // 写入同一行；如果兄弟节点的内容较短，此节点的
    // 尾部字符会残留（如 "false" + "true" = "truee"）。上面的清除
    // 已处理了可见→压缩的过渡。
    //
    // 兄弟重叠检查是关键：Yoga 的像素网格舍入
    // 可能给盒子 h=0 的同时仍为它留一行（下一个兄弟节点在
    // y+1 而非 y）。HelpV2 的第三个快捷键列就会遇到 — 无条件跳过
    // 会导致 /help 输出中丢失 "ctrl + z to suspend"。
    if (height === 0 && siblingSharesY(node, yogaNode)) {
      nodeCache.set(node, { x, y, width, height, top: yogaTop })
      node.dirty = false
      return
    }

    if (node.nodeName === 'ink-raw-ansi') {
      // 预渲染的 ANSI 内容。生产者已按宽度换行并
      // 输出了终端就绪的转义码。跳过 squash、measure、wrap 和
      // 样式重新应用 — output.write() 直接将 ANSI 解析为单元格。
      const text = node.attributes['rawText'] as string
      if (text) {
        output.write(x, y, text)
      }
    } else if (node.nodeName === 'ink-text') {
      const segments = squashTextNodesToSegments(
        node,
        inheritedBackgroundColor ? { backgroundColor: inheritedBackgroundColor } : undefined,
      )

      // 首先获取纯文本以检查是否需要换行
      const plainText = segments.map((s) => s.text).join('')

      if (plainText.length > 0) {
        // 上游 Ink 在此处使用未钳位的 getMaxWidth(yogaNode)。该
        // 宽度来自 Yoga 的 AtMost pass，可能超过实际
        // 屏幕空间（见 getMaxWidth 文档）。Yoga 为此节点的高度
        // 已反映了受限的 Exactly pass，因此在此钳位
        // 换行宽度使行数与布局一致。
        // 没有这个，超出屏幕边缘的字符会被
        // setCellAt 的边界检查丢弃。
        const maxWidth = Math.min(getMaxWidth(yogaNode), output.width - x)
        const textWrap = node.style.textWrap ?? 'wrap'

        // 检查是否需要换行
        const needsWrapping = widestLine(plainText) > maxWidth

        let text: string
        let softWrap: boolean[] | undefined
        if (needsWrapping && segments.length === 1) {
          // 单个 segment: 先换行纯文本，然后对每行应用样式
          const segment = segments[0]!
          const w = wrapWithSoftWrap(plainText, maxWidth, textWrap)
          softWrap = w.softWrap
          text = w.wrapped
            .split('\n')
            .map((line) => {
              let styled = applyTextStyles(line, segment.styles)
              // 对每行应用 OSC 8 超链接，使每行可独立
              // 点击。output.ts 按换行拆分并对每行
              // 单独 token 化，因此对整个块的单一包裹
              // 只会将超链接应用到第一行。
              if (segment.hyperlink) {
                styled = wrapWithOsc8Link(styled, segment.hyperlink)
              }
              return styled
            })
            .join('\n')
        } else if (needsWrapping) {
          // 多个 segment 需要换行：先换行纯文本，然后重新应用
          // 每个 segment 基于字符位置的样式。这样可以保留
          // 每个 segment 的样式，即使文本跨行换行。
          const w = wrapWithSoftWrap(plainText, maxWidth, textWrap)
          softWrap = w.softWrap
          const charToSegment = buildCharToSegmentMap(segments)
          text = applyStylesToWrappedText(
            w.wrapped,
            segments,
            charToSegment,
            plainText,
            textWrap === 'wrap-trim',
          )
          // 超链接在 applyStylesToWrappedText 中通过
          // wrapWithOsc8Link 逐 run 处理，类似于样式的逐 run 应用。
        } else {
          // 无需换行：直接应用样式
          text = segments
            .map((segment) => {
              let styledText = applyTextStyles(segment.text, segment.styles)
              if (segment.hyperlink) {
                styledText = wrapWithOsc8Link(styledText, segment.hyperlink)
              }
              return styledText
            })
            .join('')
        }

        text = applyPaddingToText(node, text, softWrap)

        output.write(x, y, text, softWrap)
      }
    } else if (node.nodeName === 'ink-box') {
      const boxBackgroundColor = node.style.backgroundColor ?? inheritedBackgroundColor

      // 将此 box 的区域标记为不可选（全屏文本
      // 选择）。noSelect 操作在 output.get() 的 blits/writes 之后
      // 应用，因此无论渲染到该区域的什么内容都生效 —
      // 包括 box 干净时从 prevScreen blit 的内容（操作在
      // 此处的 dirty-render 路径和约第 235 行的 blit 快速路径上均发出，
      // 因为 blitRegion 会复制 noSelect 位图和单元格）。
      //
      // 'from-left-edge' 从第 0 列扩展排除范围，使任何
      // 上游缩进（工具前缀、树线）也被覆盖 —
      // 在 diff 侧栏上多行拖拽不应选中第 0 行的
      // `  ⎿  ` 前缀或第 1 行及以下的空白单元格。
      if (node.style.noSelect) {
        const boxX = Math.floor(x)
        const fromEdge = node.style.noSelect === 'from-left-edge'
        output.noSelect({
          x: fromEdge ? 0 : boxX,
          y: Math.floor(y),
          width: fromEdge ? boxX + Math.floor(width) : Math.floor(width),
          height: Math.floor(height),
        })
      }

      const overflowX = node.style.overflowX ?? node.style.overflow
      const overflowY = node.style.overflowY ?? node.style.overflow
      const clipHorizontally = overflowX === 'hidden' || overflowX === 'scroll'
      const clipVertically = overflowY === 'hidden' || overflowY === 'scroll'
      const isScrollY = overflowY === 'scroll'

      const needsClip = clipHorizontally || clipVertically
      let y1: number | undefined
      let y2: number | undefined
      if (needsClip) {
        const clipXStart = clipHorizontally
          ? x + yogaNode.getComputedBorder(LayoutEdge.Left)
          : undefined

        const clipXEnd = clipHorizontally
          ? x + yogaNode.getComputedWidth() - yogaNode.getComputedBorder(LayoutEdge.Right)
          : undefined

        y1 = clipVertically ? y + yogaNode.getComputedBorder(LayoutEdge.Top) : undefined

        y2 = clipVertically
          ? y + yogaNode.getComputedHeight() - yogaNode.getComputedBorder(LayoutEdge.Bottom)
          : undefined

        output.clip({ x1: clipXStart, x2: clipXEnd, y1, y2 })
      }

      if (isScrollY) {
        // 滚动容器遵循 ScrollBox 组件结构：
        // 单个带有 flexShrink:0 的内容包裹节点（不会收缩
        // 以适应），其子节点是可滚动的条目。scrollHeight
        // 来自包裹节点的内在 Yoga 高度。包裹节点通过
        // -scrollTop 平移其 Y 来渲染；其子节点针对可见窗口
        // 进行裁剪。
        const padTop = yogaNode.getComputedPadding(LayoutEdge.Top)
        const innerHeight = Math.max(
          0,
          (y2 ?? y + height) - (y1 ?? y) - padTop - yogaNode.getComputedPadding(LayoutEdge.Bottom),
        )

        const content = node.childNodes.find((c) => (c as DOMElement).yogaNode) as
          | DOMElement
          | undefined
        const contentYoga = content?.yogaNode
        // scrollHeight 是内容包裹节点的内在高度。
        // 不要加上 getComputedTop() — 那是包裹节点在
        // 视口内的偏移（等于滚动容器的
        // paddingTop），而 innerHeight 已减去 padding，因此
        // 包含它会重复计算 padding 并膨胀 maxScroll。
        const scrollHeight = contentYoga?.getComputedHeight() ?? 0
        // 在覆盖之前捕获上一帧的滚动边界 — 触底
        // 跟随检查与上一帧的最大值比较。
        const prevScrollHeight = node.scrollHeight ?? scrollHeight
        const prevInnerHeight = node.scrollViewportHeight ?? innerHeight
        node.scrollHeight = scrollHeight
        node.scrollViewportHeight = innerHeight
        // 滚动区域（padding 内部）开始的绝对屏幕缓冲区行。
        // 通过 ScrollBoxHandle.getViewportTop() 暴露，使
        // 拖拽滚动可以检测拖拽何时离开滚动视口。
        node.scrollViewportTop = (y1 ?? y) + padTop

        const maxScroll = Math.max(0, scrollHeight - innerHeight)
        // scrollAnchor: 滚动使锚定元素的顶部位于
        // 视口顶部（加偏移量）。Yoga 是最新的 — 同一 calculateLayout
        // pass 刚生成 scrollHeight。比 scrollTo(N) 更可靠的替代方案，
        // 后者固化了一个在节流渲染时已过期的数字。元素 ref
        // 将读取推迟到此刻。一次性快照。
        // 之前的 eased-seek 版本（约 5 帧的比例 drain）
        // 在不触发 React notify 的情况下移动 scrollTop → 父节点的量化
        // store 快照从未更新 → StickyTracker 获取了陈旧的 range props
        // → firstVisible 出错。此外：SCROLL_MIN_PER_FRAME=4 与 snap-at-1
        // 在 delta=2 时无限 ping-pong。平滑需要 drain-end notify
        // 管道；先发布即时版本。stickyScroll 会覆盖此行为。
        if (node.scrollAnchor) {
          const anchorTop = node.scrollAnchor.el.yogaNode?.getComputedTop()
          if (anchorTop != null) {
            node.scrollTop = anchorTop + node.scrollAnchor.offset
            node.pendingScrollDelta = undefined
          }
          node.scrollAnchor = undefined
        }
        // 触底跟随。位置检查：如果 scrollTop 在（或超过）
        // 上一帧的最大值，固定到新的最大值。滚离 → 停止跟随；
        // 滚回（或 scrollToBottom/sticky 属性）→ 恢复。sticky
        // 标志在冷启动（首次布局前 scrollTop=0）
        // 和远距离 scrollToBottom（标志在 scrollTop 移动前设置）时
        // 通过 OR 加入 — 命令式字段优先于属性，因此
        // scrollTo/scrollBy 可以打破粘性。pendingDelta<0 守卫：
        // 当内容快速进入时不要取消正在进行的向上滚动。
        // 在 follow 之前捕获 scrollTop，使 ink.tsx 可以按相同 delta 平移任何
        // 活跃文本选择（原生终端行为：
        // 视图继续滚动，高亮随文本上移）。
        const scrollTopBeforeFollow = node.scrollTop ?? 0
        const sticky = node.stickyScroll ?? Boolean(node.attributes['stickyScroll'])
        const prevMaxScroll = Math.max(0, prevScrollHeight - prevInnerHeight)
        // 位置检查仅在内容增长时有效 — 虚拟化可能
        // 短暂缩小 scrollHeight（尾部卸载 + 陈旧的 heightCache
        // 占位符）使 scrollTop >= prevMaxScroll 为真是伪影，而非
        // 因为用户在底部。
        const grew = scrollHeight >= prevScrollHeight
        const atBottom = sticky || (grew && scrollTopBeforeFollow >= prevMaxScroll)
        if (atBottom && (node.pendingScrollDelta ?? 0) >= 0) {
          node.scrollTop = maxScroll
          node.pendingScrollDelta = undefined
          // 同步标志使 useVirtualScroll 的 isSticky() 与位置
          // 状态一致 — 粘性损坏但处于底部（滚轮抖动、在最大值处点击选择）
          // 否则会使 useVirtualScroll 的 clamp 将视口
          // 保持在新流式内容之前。scrollTo/scrollBy 设为
          // false；此处恢复为 true，与 scrollToBottom() 相同。
          // 仅在 (a) 位置在底部且 (b) 标志
          // 被 scrollTo/scrollBy 显式破坏（===false）时恢复。当
          // undefined（从未被用户操作设置）时保持不动 — 设置它会
          // 使 sticky 标志默认为粘性并锁定
          // 直接 scrollTop 写入（如 alt-screen-perf 测试）。
          if (node.stickyScroll === false && scrollTopBeforeFollow >= prevMaxScroll) {
            node.stickyScroll = true
          }
        }
        const followDelta = (node.scrollTop ?? 0) - scrollTopBeforeFollow
        if (followDelta > 0) {
          const vpTop = node.scrollViewportTop ?? 0
          followScroll = {
            delta: followDelta,
            viewportTop: vpTop,
            viewportBottom: vpTop + innerHeight - 1,
          }
        }
        // Drain pendingScrollDelta。原生终端（比例突发
        // 事件）使用比例 drain；xterm.js（VS Code，稀疏事件 +
        // 应用侧加速曲线）使用自适应小步长 drain。isXtermJs()
        // 依赖异步 XTVERSION 探测，但到此代码运行时
        //（pendingScrollDelta 仅由滚轮事件设置，>>50ms 之后
        // 启动）探测已解析 — 与 wheel-accel 曲线依赖的时序保证相同。
        let cur = node.scrollTop ?? 0
        const pending = node.pendingScrollDelta
        const cMin = node.scrollClampMin
        const cMax = node.scrollClampMax
        const haveClamp = cMin !== undefined && cMax !== undefined
        if (pending !== undefined && pending !== 0) {
          // 即使超过 clamp 也继续 drain — 下面的 render-clamp
          // 无论如何都将视觉上保持在挂载边缘。在此硬停止
          // 会导致启停抖动：drain 触及边缘 → 暂停 → React
          // 提交 → clamp 变宽 → drain 恢复 → 再次触及边缘。让
          // scrollTop 在 clamp 滞后时平滑前进，在 React 的提交频率下
          // 给出连续的视觉滚动（clamp 每次提交赶上）。
          // 但超过 clamp 时限制 drain 节流，使
          // scrollTop 不会超出挂载范围 5000 行
          //（slide-cap 随后需要 200 次提交才能赶上 = 在边缘
          // 感知长时间卡顿）。超过 clamp 的 drain 限制在约 4 行/
          // 帧，大致匹配 React 的滑动速率，使差距保持
          // 有界且输入停止后能快速赶上。
          const pastClamp =
            haveClamp && ((pending < 0 && cur < cMin) || (pending > 0 && cur > cMax))
          const eff = pastClamp ? Math.min(4, innerHeight >> 3) : innerHeight
          cur += isXtermJsHost()
            ? drainAdaptive(node, pending, eff)
            : drainProportional(node, pending, eff)
        } else if (pending === 0) {
          // 相反的 scrollBy 调用抵消为零 — 清除以避免调度
          // 无限循环的无操作 drain 帧。
          node.pendingScrollDelta = undefined
        }
        let scrollTop = Math.max(0, Math.min(cur, maxScroll))
        // 虚拟滚动 clamp：如果 scrollTop 超出了当前挂载的
        // 范围（在 React 重新渲染之前突发 PageUp），在已挂载
        // 子节点的边缘渲染而非空白占位符。不要写回
        // node.scrollTop — 钳位值仅用于本次绘制；真实的
        // scrollTop 保持不动，使 React 的下次提交能看到目标并挂载
        // 正确的范围。此处不调度 scrollDrainNode 使
        // clamp 保持被动 — React 提交 → resetAfterCommit → onRender 将
        // 用新的边界重新绘制。
        const clamped = haveClamp ? Math.max(cMin, Math.min(scrollTop, cMax)) : scrollTop
        node.scrollTop = scrollTop
        // Clamp 触及顶部/底部消耗任何余量。仅在
        // clamp 之后设置 drainPending，避免调度浪费的无操作帧。
        if (scrollTop !== cur) node.pendingScrollDelta = undefined
        if (node.pendingScrollDelta !== undefined) scrollDrainNode = node
        scrollTop = clamped

        if (content && contentYoga) {
          // 计算内容包裹节点应用滚动
          // 偏移后的绝对渲染位置，然后裁剪渲染其子节点。
          const contentX = x + contentYoga.getComputedLeft()
          const contentY = y + contentYoga.getComputedTop() - scrollTop
          // layoutShifted 检测间隙：当 scrollTop 移动 >= 视口
          // 高度（批量 PageUp、快速滚轮）时，每个可见子节点被
          // 裁剪（缓存丢弃），每个新可见子节点没有
          // 缓存 — 因此子节点的 positionChanged 检查无法触发。
          // 内容包裹节点的缓存 y（编码了 -scrollTop）是
          // 唯一能感知滚动的节点。
          const contentCached = nodeCache.get(content)
          let hint: ScrollHint | null = null
          if (contentCached && contentCached.y !== contentY) {
            // delta = newScrollTop - oldScrollTop（正数 = 向下滚动）。
            // 如果容器本身没有移动
            // 且偏移在视口内，捕获 DECSTBM 提示 — 否则无论如何都需要
            // 全量重写，而 layoutShifted 保持为回退方案。
            const delta = contentCached.y - contentY
            const regionTop = Math.floor(y + contentYoga.getComputedTop())
            const regionBottom = regionTop + innerHeight - 1
            if (
              cached?.y === y &&
              cached.height === height &&
              innerHeight > 0 &&
              Math.abs(delta) < innerHeight
            ) {
              hint = { top: regionTop, bottom: regionBottom, delta }
              scrollHint = hint
            } else {
              layoutShifted = true
            }
          }
          // 快速路径：滚动（已捕获提示）使用可用的 prevScreen。
          // 将 prevScreen 的滚动区域 blit 到 next.screen，原地
          // 按 delta 偏移（镜像 DECSTBM），然后仅渲染边缘行。嵌套
          // 裁剪使子节点写入不进入稳定行 — 跨越
          // 边缘+稳定的高子节点仍会渲染但稳定单元格被
          // 裁剪，保留 blit。避免重新渲染每个可见
          // 子节点（对长语法高亮文本代价昂贵）。
          //
          // 当 content.dirty（如滚动底部的流式文本）时，
          // 我们仍使用快速路径 — 脏子节点几乎
          // 总是在边缘行（新内容出现的底部）。
          // 边缘渲染后，稳定行中的任何脏子节点在
          // 第二遍中重新渲染，避免显示陈旧的 blitted
          // 内容。
          //
          // 守卫：快速路径仅处理纯滚动或底部追加。
          // 子节点删除/插入以不匹配
          // 滚动 delta 的方式改变内容高度 — 回退到完整路径，使
          // 删除的子节点不留下陈旧单元格，偏移的兄弟节点
          // 在新位置渲染。
          const scrollHeight = contentYoga.getComputedHeight()
          const prevHeight = contentCached?.height ?? scrollHeight
          const heightDelta = scrollHeight - prevHeight
          const safeForFastPath =
            !hint || heightDelta === 0 || (hint.delta > 0 && heightDelta === hint.delta)
          // scrollHint 在捕获提示时在上方设置。如果 safeForFastPath
          // 为 false，完整路径渲染的 next.screen 与
          // DECSTBM 偏移不匹配 — 发出 DECSTBM 会留下陈旧行（表现为
          // 向上滚动 + 流式时内容渗出）。清除它。
          if (!safeForFastPath) scrollHint = null
          if (hint && prevScreen && safeForFastPath) {
            const { top, bottom, delta } = hint
            const w = Math.floor(width)
            output.blit(prevScreen, Math.floor(x), top, w, bottom - top + 1)
            output.shift(top, bottom, delta)
            // 边缘行：新内容进入视口。
            const edgeTop = delta > 0 ? bottom - delta + 1 : top
            const edgeBottom = delta > 0 ? bottom : top - delta - 1
            output.clear({
              x: Math.floor(x),
              y: edgeTop,
              width: w,
              height: edgeBottom - edgeTop + 1,
            })
            output.clip({
              x1: undefined,
              x2: undefined,
              y1: edgeTop,
              y2: edgeBottom + 1,
            })
            // 在第一遍之前快照脏子节点 — 第一遍
            // 会清除 dirty 标志，跨越边缘的子节点在
            // 第二遍中会被遗漏，没有此快照的话。
            const dirtyChildren = content.dirty
              ? new Set(content.childNodes.filter((c) => (c as DOMElement).dirty))
              : null
            renderScrolledChildren(
              content,
              output,
              contentX,
              contentY,
              hasRemovedChild,
              undefined,
              // 以子节点局部坐标裁剪到边缘（contentY 偏移的反向）。
              edgeTop - contentY,
              edgeBottom + 1 - contentY,
              boxBackgroundColor,
              true,
            )
            output.unclip()

            // 第二遍：重新渲染稳定行中屏幕
            // 位置与偏移后旧像素位置不匹配的子节点。
            // 覆盖两种情况：
            //   1. 脏子节点 — 内容变化，无论位置如何 blitted 像素都是
            //      陈旧的。
            //   2. 中间增长点下方的干净子节点 — 当上方脏的
            //      兄弟节点增长时，它们的 yogaTop 增加但
            //      scrollTop 增加相同量（粘性），因此它们的
            //      screenY 是恒定的。偏移将旧像素移到了
            //      screenY-delta（错误）；它们应保持在 screenY。没有
            //      这个，流式时 spinner/tmux-monitor 会在偏移位置
            //      残留（如三重 spinner、pill 重复）。
            //   对于底部追加（常见情况），所有干净子节点都在
            //   增长点上方；它们的 screenY 减少了 delta 且
            //   偏移将它们放到了正确位置 — 此处跳过，保持
            //   快速路径。
            if (dirtyChildren) {
              const edgeTopLocal = edgeTop - contentY
              const edgeBottomLocal = edgeBottom + 1 - contentY
              const spaces = ' '.repeat(w)
              // 跟踪到目前为止已迭代子节点的累计高度变化。
              // 干净子节点的 yogaTop 不变当且仅当此值为零（其
              // 上方没有兄弟节点增长/缩小/挂载）。为零时，跳过
              // 检查 cached.y−delta === screenY 简化为 delta === delta
              //（恒等式）→ 跳过而无需读取 yoga。恢复了
              // #24536 牺牲的 O(dirty)：对于底部追加，脏子节点
              // 在最后（所有干净子节点跳过）；对于虚拟滚动范围
              // 偏移，topSpacer 缩小 + 新条目高度自平衡
              // 为零，在到达干净块之前。中间增长
              // 使偏移非零 → 增长点后的干净子节点
              // 落入 yoga + 下面的细粒度检查，
              // 保留 ghost-box 修复。
              let cumHeightShift = 0
              for (const childNode of content.childNodes) {
                const childElem = childNode as DOMElement
                const isDirty = dirtyChildren.has(childNode)
                if (!isDirty && cumHeightShift === 0) {
                  if (nodeCache.has(childElem)) continue
                  // 未缓存 = 上一帧被裁剪，现在重新进入。blit
                  // 从未绘制它 → 落入 yoga + 渲染。
                  // 高度不变（干净），因此 cumHeightShift 保持 0。
                }
                const cy = childElem.yogaNode
                if (!cy) continue
                const childTop = cy.getComputedTop()
                const childH = cy.getComputedHeight()
                const childBottom = childTop + childH
                if (isDirty) {
                  const prev = nodeCache.get(childElem)
                  cumHeightShift += childH - (prev ? prev.height : 0)
                }
                // 跳过被裁剪的子节点（在视口外）
                if (childBottom <= scrollTop || childTop >= scrollTop + innerHeight) continue
                // 跳过完全在边缘行内的子节点（已渲染）
                if (childTop >= edgeTopLocal && childBottom <= edgeBottomLocal) continue
                const screenY = Math.floor(contentY + childTop)
                // 到达此处的干净子节点有 cumHeightShift ≠ 0 或
                // 无缓存。精确重新检查：cached.y − delta 是
                // 偏移留下旧像素的位置；如果它等于新 screenY 则
                // blit 正确（偏移在此子节点重新平衡，或
                // yogaTop 恰好抵消）。无缓存 → blit 从未
                // 绘制它 → 渲染。
                if (!isDirty) {
                  const childCached = nodeCache.get(childElem)
                  if (childCached && Math.floor(childCached.y) - delta === screenY) {
                    continue
                  }
                }
                // 用空格擦除此子节点的区域以覆盖陈旧的
                // blitted 内容 — output.clear() 仅扩展损坏范围，
                // 无法清零 blit 已写入的单元格。
                const screenBottom = Math.min(
                  Math.floor(contentY + childBottom),
                  Math.floor((y1 ?? y) + padTop + innerHeight),
                )
                if (screenY < screenBottom) {
                  const fill = Array(screenBottom - screenY)
                    .fill(spaces)
                    .join('\n')
                  output.write(Math.floor(x), screenY, fill)
                  output.clip({
                    x1: undefined,
                    x2: undefined,
                    y1: screenY,
                    y2: screenBottom,
                  })
                  renderNodeToOutput(childElem, output, {
                    offsetX: contentX,
                    offsetY: contentY,
                    prevScreen: undefined,
                    inheritedBackgroundColor: boxBackgroundColor,
                  })
                  output.unclip()
                }
              }
            }

            // 第三遍：修复绝对
            // 覆盖层偏移副本落地的行。blit 复制了 prevScreen 单元格，包括
            // 覆盖层像素（覆盖层在此 ScrollBox 之后渲染，因此它们
            // 绘制到了 prevScreen 的滚动区域）。偏移后，这些
            // 像素位于 (rect.y - delta) — 边缘渲染和
            // 覆盖层自身的重新渲染都不覆盖它们。擦除并重新渲染
            // ScrollBox 内容，使 diff 写入正确的单元格。
            const spaces = absoluteRectsPrev.length ? ' '.repeat(w) : ''
            for (const r of absoluteRectsPrev) {
              if (r.y >= bottom + 1 || r.y + r.height <= top) continue
              const shiftedTop = Math.max(top, Math.floor(r.y) - delta)
              const shiftedBottom = Math.min(bottom + 1, Math.floor(r.y + r.height) - delta)
              // 如果完全在边缘行内则跳过（已渲染）。
              if (shiftedTop >= edgeTop && shiftedBottom <= edgeBottom + 1) continue
              if (shiftedTop >= shiftedBottom) continue
              const fill = Array(shiftedBottom - shiftedTop)
                .fill(spaces)
                .join('\n')
              output.write(Math.floor(x), shiftedTop, fill)
              output.clip({
                x1: undefined,
                x2: undefined,
                y1: shiftedTop,
                y2: shiftedBottom,
              })
              renderScrolledChildren(
                content,
                output,
                contentX,
                contentY,
                hasRemovedChild,
                undefined,
                shiftedTop - contentY,
                shiftedBottom - contentY,
                boxBackgroundColor,
                true,
              )
              output.unclip()
            }
          } else {
            // 完整路径。两种子情况：
            //
            // 滚动但无可用的提示（大跳跃、容器移动）：
            // prevScreen 中的子节点位置已陈旧。清除视口
            // 并禁用 blit，使子节点不恢复偏移的内容。
            //
            // 无滚动（spinner 跳动、内容编辑）：prevScreen 中
            // 的子节点位置仍然有效。跳过视口清除并传递
            // prevScreen，使未变化的子节点 blit。脏子节点已通过
            // 自己的缓存矩形清除自清除。没有这个，ScrollBox 内的
            // spinner 每帧强制全量内容重写 — 在 tmux 上的宽终端
            //（无 BSU/ESU）带宽跨越块边界，帧撕裂。
            const scrolled = contentCached && contentCached.y !== contentY
            if (scrolled && y1 !== undefined && y2 !== undefined) {
              output.clear({
                x: Math.floor(x),
                y: Math.floor(y1),
                width: Math.floor(width),
                height: Math.floor(y2 - y1),
              })
            }
            // positionChanged（ScrollBox 高度缩小 — pill 挂载）意味着
            // 跨越旧底部边缘的子节点会 blit 其完整缓存
            // 矩形超出新裁剪。output.ts 现在裁剪 blit，但也
            // 在此处禁用 prevScreen，使部分行的子节点在
            // 正确的边界重新渲染，而非 blit 一个被裁剪（截断）的旧
            // 矩形。
            renderScrolledChildren(
              content,
              output,
              contentX,
              contentY,
              hasRemovedChild,
              scrolled || positionChanged ? undefined : prevScreen,
              scrollTop,
              scrollTop + innerHeight,
              boxBackgroundColor,
            )
          }
          nodeCache.set(content, {
            x: contentX,
            y: contentY,
            width: contentYoga.getComputedWidth(),
            height: contentYoga.getComputedHeight(),
          })
          content.dirty = false
        }
      } else {
        // 在渲染子节点之前用背景色填充内部。
        // 这覆盖了 padding 区域和空白空间；子节点文本通过
        // inheritedBackgroundColor 继承颜色，因此写入的单元格也
        // 获得背景。
        // 为子节点禁用 prevScreen：填充在每次渲染时覆盖整个
        // 内部，因此来自 prevScreen 的子节点 blit 会恢复
        // 陈旧单元格（如果背景改变则为错误背景色）在新鲜填充之上。
        const ownBackgroundColor = node.style.backgroundColor
        if (ownBackgroundColor || node.style.opaque) {
          const borderLeft = yogaNode.getComputedBorder(LayoutEdge.Left)
          const borderRight = yogaNode.getComputedBorder(LayoutEdge.Right)
          const borderTop = yogaNode.getComputedBorder(LayoutEdge.Top)
          const borderBottom = yogaNode.getComputedBorder(LayoutEdge.Bottom)
          const innerWidth = Math.floor(width) - borderLeft - borderRight
          const innerHeight = Math.floor(height) - borderTop - borderBottom
          if (innerWidth > 0 && innerHeight > 0) {
            const spaces = ' '.repeat(innerWidth)
            const fillLine = ownBackgroundColor
              ? applyTextStyles(spaces, { backgroundColor: ownBackgroundColor })
              : spaces
            const fill = Array(innerHeight).fill(fillLine).join('\n')
            output.write(x + borderLeft, y + borderTop, fill)
          }
        }

        renderChildren(
          node,
          output,
          x,
          y,
          hasRemovedChild,
          // backgroundColor 和 opaque 都禁用子节点 blit：填充
          // 在每次渲染时覆盖整个内部，因此任何
          // 布局位置偏移的子节点会从 prevScreen blit 陈旧单元格
          // 在新鲜填充之上。之前 opaque 保持 blit 启用
          // 基于假设：纯空格填充 + 未变化子节点 =
          // 有效组合，但子节点确实可能重新定位（ScrollBox 重新测量
          // 在重新渲染时 → /permissions 主体在 Down 箭头时空白，#25436）。
          ownBackgroundColor || node.style.opaque ? undefined : prevScreen,
          boxBackgroundColor,
        )
      }

      if (needsClip) {
        output.unclip()
      }

      // 在子节点之后渲染边框，确保不被子节点
      // 清除操作覆盖。当子节点缩小时，它会清除旧区域，
      // 可能与父节点边框现在所在的位置重叠。
      renderBorder(x, y, node, output)
    } else if (node.nodeName === 'ink-root') {
      renderChildren(node, output, x, y, hasRemovedChild, prevScreen, inheritedBackgroundColor)
    }

    // 缓存布局边界用于脏检测
    const rect = { x, y, width, height, top: yogaTop }
    nodeCache.set(node, rect)
    if (node.style.position === 'absolute') {
      absoluteRectsCur.push(rect)
    }
    node.dirty = false
  }
}

// 溢出污染：内容向右/下溢出，因此干净兄弟节点
// 在脏/已删除兄弟节点之后可能在 prevScreen 中包含陈旧溢出。
// 对脏子节点之后的兄弟节点禁用 blit — 但仍将 prevScreen
// 传递给脏子节点本身，使其干净后代可以 blit。脏
// 子节点自己的 blit 检查已失败（node.dirty=true 在约第 216 行），因此
// 传递 prevScreen 仅惠及其子树。
// 对于已删除的子节点，我们不知道其原始位置，因此
// 保守地为所有子节点禁用 blit。
//
// 被裁剪的子节点（两个轴上 overflow hidden/scroll）不会溢出
// 到后续兄弟节点 — 其内容限制在布局边界内。
// 对它们跳过污染检查，使后续兄弟节点仍可 blit。
// 没有这个，ScrollBox 内的 spinner 每次
// 跳动都会弄脏包裹节点，底部提示区域永远无法 blit → 每帧 100% 写入。
//
// 例外：绝对定位的被裁剪子节点可能有布局边界
// 与任意兄弟节点重叠，因此裁剪无济于事。
//
// 重叠污染（seenDirtyClipped）：后续绝对兄弟节点其
// 矩形位于脏裁剪子节点边界内会从 prevScreen blit 陈旧单元格
// — 被裁剪的子节点刚在本帧重写了这些单元格。
// clipsBothAxes 跳过仅防护溢出（被裁剪子节点
// 在边界外绘制），不防护重叠（绝对兄弟节点
// 在其内部绘制）。对于非不透明绝对兄弟节点，skipSelfBlit 强制
// descend（全宽矩形有透明间隙 → 陈旧 blit），同时
// 仍传递 prevScreen 使不透明后代可以 blit 其较窄
// 矩形（NewMessagesPill 的内部 Text 带 backgroundColor）。不透明
// 绝对兄弟节点填充整个矩形 — 直接 blit 是安全的。
function renderChildren(
  node: DOMElement,
  output: Output,
  offsetX: number,
  offsetY: number,
  hasRemovedChild: boolean,
  prevScreen: Screen | undefined,
  inheritedBackgroundColor: Color | undefined,
): void {
  let seenDirtyChild = false
  let seenDirtyClipped = false
  for (const childNode of node.childNodes) {
    const childElem = childNode as DOMElement
    // 在渲染之前捕获 dirty — renderNodeToOutput 清除此标志
    const wasDirty = childElem.dirty
    const isAbsolute = childElem.style.position === 'absolute'
    renderNodeToOutput(childElem, output, {
      offsetX,
      offsetY,
      prevScreen: hasRemovedChild || seenDirtyChild ? undefined : prevScreen,
      // 在 seenDirtyClipped 上短路（常见情况下为 false），因此
      // opaque/bg 读取不会每帧每子节点发生。
      skipSelfBlit:
        seenDirtyClipped &&
        isAbsolute &&
        !childElem.style.opaque &&
        childElem.style.backgroundColor === undefined,
      inheritedBackgroundColor,
    })
    if (wasDirty && !seenDirtyChild) {
      if (!clipsBothAxes(childElem) || isAbsolute) {
        seenDirtyChild = true
      } else {
        seenDirtyClipped = true
      }
    }
  }
}

function clipsBothAxes(node: DOMElement): boolean {
  const ox = node.style.overflowX ?? node.style.overflow
  const oy = node.style.overflowY ?? node.style.overflow
  return (ox === 'hidden' || ox === 'scroll') && (oy === 'hidden' || oy === 'scroll')
}

// 当 Yoga 将盒子压缩到 h=0 时，重影仅在兄弟节点
// 落在相同的计算 top 时发生 — 两者都写入该行，
// 较短内容会留下较长内容的尾部可见。Yoga 的像素网格
// 舍入可能给出 h=0 同时仍推进下一个兄弟节点的 top
//（HelpV2 的第三个快捷键列），因此仅 h=0 不够。
function siblingSharesY(node: DOMElement, yogaNode: LayoutNode): boolean {
  const parent = node.parentNode
  if (!parent) return false
  const myTop = yogaNode.getComputedTop()
  const siblings = parent.childNodes
  const idx = siblings.indexOf(node)
  for (let i = idx + 1; i < siblings.length; i++) {
    const sib = (siblings[i] as DOMElement).yogaNode
    if (!sib) continue
    return sib.getComputedTop() === myTop
  }
  // 没有下一个带 yoga 节点的兄弟节点 — 检查前一个。尾部
  // 一连串 h=0 的盒子会彼此共享 y。
  for (let i = idx - 1; i >= 0; i--) {
    const sib = (siblings[i] as DOMElement).yogaNode
    if (!sib) continue
    return sib.getComputedTop() === myTop
  }
  return false
}

// 当节点 blit 时，其绝对定位的后代绘制在
// 节点布局边界之外不会被 blit 覆盖（blit 仅复制
// 节点自己的矩形）。如果脏兄弟节点重新渲染并覆盖了这些
// 单元格，我们必须从 prevScreen 重新 blit 它们使覆盖层得以保留。
// 例如：PromptInputFooter 的斜杠菜单使用 position='absolute' bottom='100%'
// 悬浮在 prompt 上方；上方 ScrollBox 中的 spinner 跳动重新渲染
// 并覆盖这些单元格。没有这个，菜单在下一帧消失。
function blitEscapingAbsoluteDescendants(
  node: DOMElement,
  output: Output,
  prevScreen: Screen,
  px: number,
  py: number,
  pw: number,
  ph: number,
): void {
  const pr = px + pw
  const pb = py + ph
  for (const child of node.childNodes) {
    if (child.nodeName === '#text') continue
    const elem = child as DOMElement
    if (elem.style.position === 'absolute') {
      const cached = nodeCache.get(elem)
      if (cached) {
        absoluteRectsCur.push(cached)
        const cx = Math.floor(cached.x)
        const cy = Math.floor(cached.y)
        const cw = Math.floor(cached.width)
        const ch = Math.floor(cached.height)
        // 仅 blit 延伸到父节点布局边界之外的矩形 —
        // 父矩形内的单元格已被父 blit 覆盖。
        if (cx < px || cy < py || cx + cw > pr || cy + ch > pb) {
          output.blit(prevScreen, cx, cy, cw, ch)
        }
      }
    }
    // 递归 — 绝对后代可以任意深嵌套
    blitEscapingAbsoluteDescendants(elem, output, prevScreen, px, py, pw, ph)
  }
}

// 渲染滚动容器的子节点，带视口裁剪。
// scrollTopY..scrollBottomY 是子节点局部 Yoga 坐标中的可见窗口
//（即 getComputedTop() 返回的值）。完全在此窗口之外的子节点
// 被跳过；其 nodeCache 条目被删除，因此如果它们稍后重新进入
// 视口，不会为现在被兄弟节点占用的位置发出陈旧清除。
function renderScrolledChildren(
  node: DOMElement,
  output: Output,
  offsetX: number,
  offsetY: number,
  hasRemovedChild: boolean,
  prevScreen: Screen | undefined,
  scrollTopY: number,
  scrollBottomY: number,
  inheritedBackgroundColor: Color | undefined,
  // 为 true 时（DECSTBM 快速路径），被裁剪的子节点保留其缓存 —
  // blit+shift 将稳定行放入 next.screen，因此不会读取陈旧缓存。
  // 避免每帧遍历 O(总子节点数 * 子树深度)。
  preserveCulledCache = false,
): void {
  let seenDirtyChild = false
  // 跟踪到目前为止已迭代脏子节点的累计高度偏移。当
  // 为零时，干净子节点的 yogaTop 不变（上方没有兄弟节点增长），
  // 因此 cached.top 是新鲜的，裁剪检查跳过 yoga。底部追加
  // 的脏子节点在最后 → 之前所有干净子节点命中缓存 →
  // O(dirty) 而非 O(mounted)。中间增长在脏子节点后
  // 使偏移非零 → 后续子节点读取 yoga（正确
  // 裁剪所需，因为它们的 yogaTop 已偏移）。
  let cumHeightShift = 0
  for (const childNode of node.childNodes) {
    const childElem = childNode as DOMElement
    const cy = childElem.yogaNode
    if (cy) {
      const cached = nodeCache.get(childElem)
      let top: number
      let height: number
      if (cached?.top !== undefined && !childElem.dirty && cumHeightShift === 0) {
        top = cached.top
        height = cached.height
      } else {
        top = cy.getComputedTop()
        height = cy.getComputedHeight()
        if (childElem.dirty) {
          cumHeightShift += height - (cached ? cached.height : 0)
        }
        // 刷新缓存的 top，使下一帧的 cumShift===0 路径保持
        // 正确。对于 preserveCulledCache=true 的被裁剪子节点，这是
        // 唯一的刷新点 — 没有它，中间增长帧
        // 会留下陈旧的 tops，在下帧误触发。
        if (cached) cached.top = top
      }
      const bottom = top + height
      if (bottom <= scrollTopY || top >= scrollBottomY) {
        // 被裁剪 — 在可见窗口之外。丢弃子树中
        // 的陈旧缓存条目，使此子节点重新进入时不会在
        // 现在被兄弟节点占用的位置触发清除。滚动变化时的
        // 视口清除处理可见区域重绘。
        if (!preserveCulledCache) dropSubtreeCache(childElem)
        continue
      }
    }
    const wasDirty = childElem.dirty
    renderNodeToOutput(childElem, output, {
      offsetX,
      offsetY,
      prevScreen: hasRemovedChild || seenDirtyChild ? undefined : prevScreen,
      inheritedBackgroundColor,
    })
    if (wasDirty) {
      seenDirtyChild = true
    }
  }
}

function dropSubtreeCache(node: DOMElement): void {
  nodeCache.delete(node)
  for (const child of node.childNodes) {
    if (child.nodeName !== '#text') {
      dropSubtreeCache(child as DOMElement)
    }
  }
}

// 导出用于测试
export { buildCharToSegmentMap, applyStylesToWrappedText }

export default renderNodeToOutput
