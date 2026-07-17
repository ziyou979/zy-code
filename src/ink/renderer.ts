import { logForDebugging } from 'src/utils/debug.js'
import { type DOMElement, markDirty } from './dom.js'
import type { Frame } from './frame.js'
import { consumeAbsoluteRemovedFlag } from './nodeCache.js'
import Output from './output.js'
import renderNodeToOutput, {
  getScrollDrainNode,
  getScrollHint,
  resetLayoutShifted,
  resetScrollDrainNode,
  resetScrollHint,
} from './renderNodeToOutput.js'
import { createScreen, type StylePool } from './screen.js'

export type RenderOptions = {
  frontFrame: Frame
  backFrame: Frame
  isTTY: boolean
  terminalWidth: number
  terminalRows: number
  altScreen: boolean
  // 当上一帧的 screen buffer 在渲染后被修改（selection overlay）时为 true，
  // 或被清空为空白（进入 alt-screen / 窗口大小变化 / SIGCONT），
  // 或被重置为 0×0（forceRedraw）。从这样的 prevScreen 进行 blit 会
  // 复制过时的反色单元格、空白或无内容。当为 false 时，blit 是安全的。
  prevFrameContaminated: boolean
}

export type Renderer = (options: RenderOptions) => Frame

export default function createRenderer(node: DOMElement, stylePool: StylePool): Renderer {
  // 在帧之间复用 Output，使 charCache（tokenize + grapheme clustering）
  // 得以保留——大多数行在渲染之间不会发生变化。
  let output: Output | undefined
  return (options) => {
    const { frontFrame, backFrame, isTTY, terminalWidth, terminalRows } = options
    const prevScreen = frontFrame.screen
    const backScreen = backFrame.screen
    // 从 back buffer 的 screen 读取 pool——pool 可能在帧之间被替换
    //（generational reset），所以不能在闭包中捕获它们
    const charPool = backScreen.charPool
    const hyperlinkPool = backScreen.hyperlinkPool

    // 如果 yoga 节点不存在或布局尚未计算完成，则返回空帧。
    // 在调用 calculateLayout() 之前，getComputedHeight() 返回 NaN。
    // 同时检查无效的尺寸（负数、Infinity），这会在创建数组时导致 RangeError。
    const computedHeight = node.yogaNode?.getComputedHeight()
    const computedWidth = node.yogaNode?.getComputedWidth()
    const hasInvalidHeight =
      computedHeight === undefined || !Number.isFinite(computedHeight) || computedHeight < 0
    const hasInvalidWidth =
      computedWidth === undefined || !Number.isFinite(computedWidth) || computedWidth < 0

    if (!node.yogaNode || hasInvalidHeight || hasInvalidWidth) {
      // 输出日志以帮助诊断根本原因（使用 --debug 标志时可见）
      if (node.yogaNode && (hasInvalidHeight || hasInvalidWidth)) {
        logForDebugging(
          `Invalid yoga dimensions: width=${computedWidth}, height=${computedHeight}, ` +
            `childNodes=${node.childNodes.length}, terminalWidth=${terminalWidth}, terminalRows=${terminalRows}`,
        )
      }
      return {
        screen: createScreen(terminalWidth, 0, stylePool, charPool, hyperlinkPool),
        viewport: { width: terminalWidth, height: terminalRows },
        cursor: { x: 0, y: 0, visible: true },
      }
    }

    const width = Math.floor(node.yogaNode.getComputedWidth())
    const yogaHeight = Math.floor(node.yogaNode.getComputedHeight())
    // Alt-screen：screen buffer 就是 alt buffer——高度始终精确等于
    // terminalRows。<AlternateScreen> 用 <Box height={rows} flexShrink={0}>
    // 包裹子节点，所以 yogaHeight 应该等于 terminalRows。但如果某些内容
    // 渲染成了该 Box 的兄弟节点（bug：MessageSelector 在 <FullscreenLayout>
    // 外部），yogaHeight 会超过 rows，导致下面的所有假设（viewport +1 hack、
    // cursor.y clamp、log-update 的 heightDelta===0 fast path）被破坏，
    // virtual/physical 光标不同步。此处的 clamp 强制不变量：
    // 溢出写入落在 y >= screen.height，setCellAt 会丢弃它们。
    // 这样兄弟节点不可见（显而易见，易于排查），而不是污染整个终端。
    const height = options.altScreen ? terminalRows : yogaHeight
    if (options.altScreen && yogaHeight > terminalRows) {
      logForDebugging(
        `alt-screen: yoga height ${yogaHeight} > terminalRows ${terminalRows} — ` +
          `something is rendering outside <AlternateScreen>. Overflow clipped.`,
        { level: 'warn' },
      )
    }
    const screen = backScreen ?? createScreen(width, height, stylePool, charPool, hyperlinkPool)
    if (output) {
      output.reset(width, height, screen)
    } else {
      output = new Output({ width, height, stylePool, screen })
    }

    resetLayoutShifted()
    resetScrollHint()
    resetScrollDrainNode()

    // prevFrameContaminated：selection overlay 在渲染后修改了返回的 screen
    // buffer（在 ink.tsx 中），resetFramesForAltScreen() 将其替换为空白，
    // 或 forceRedraw() 将其重置为 0×0。在下一帧进行 blit 会复制过时的反色
    // 单元格 / 空白 / 无内容。当 clean 时，blit 为稳态帧（spinner tick、
    // text stream）恢复 O(unchanged) fast path。
    // 移除 absolute-positioned 节点会污染 prevScreen：它可能覆盖过
    // 非兄弟节点（例如 tree order 中较早的 ScrollBox 上的 overlay），
    // 因此它们的 blit 会恢复被移除节点的像素。hasRemovedChild 仅保护
    // 直接兄弟节点。Normal-flow 的移除不会跨子树绘制，没有问题。
    const absoluteRemoved = consumeAbsoluteRemovedFlag()
    renderNodeToOutput(node, output, {
      prevScreen: absoluteRemoved || options.prevFrameContaminated ? undefined : prevScreen,
    })

    const renderedScreen = output.get()

    // Drain 延续：渲染清除了 scrollbox.dirty，因此下一帧的 root blit
    // 会跳过该子树。markDirty 会遍历祖先节点，使下一帧能够下降。
    // 在渲染之后完成，以免 renderNodeToOutput 末尾的 clear-dirty 覆盖此标记。
    const drainNode = getScrollDrainNode()
    if (drainNode) {
      markDirty(drainNode)
    }

    return {
      scrollHint: options.altScreen ? getScrollHint() : null,
      scrollDrainPending: drainNode !== null,
      screen: renderedScreen,
      viewport: {
        width: terminalWidth,
        // Alt screen：伪造 viewport.height = rows + 1，使得
        // shouldClearScreen() 的 `screen.height >= viewport.height` 检查
        //（该检查将恰好填满的内容视为"溢出"，用于 scrollback 目的）永远不会触发。
        // Alt-screen 内容始终恰好为 `rows` 高（通过 <Box height={rows}>），
        // 但从不滚动——下方 cursor.y clamp 使光标恢复不会发出 LF。
        // 使用标准 diff 路径时，每一帧都是增量的；无需 fullResetSequence_CAUSES_FLICKER。
        height: options.altScreen ? terminalRows + 1 : terminalRows,
      },
      cursor: {
        x: 0,
        // 在 alt screen 中，保持光标位于视口内。当
        // screen.height === terminalRows 恰好相等时（内容填满 alt
        // screen），cursor.y = screen.height 会触发 log-update 的
        // cursor-restore LF（在最后一行），导致 alt buffer 顶部滚动一行，
        // 使 diff 的光标模型不同步。光标已隐藏，其位置仅用于 diff 坐标。
        y: options.altScreen
          ? Math.max(0, Math.min(screen.height, terminalRows) - 1)
          : screen.height,
        // 有动态输出需要渲染时隐藏光标（仅在 TTY 模式下）
        visible: !isTTY || screen.height === 0,
      },
    }
  }
}
