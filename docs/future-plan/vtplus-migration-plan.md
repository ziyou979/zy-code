# CC VtPlusPlus 全屏渲染器架构逆向分析与 zy-code 移植方案

> 基于 Claude Code v2.1.179 二进制逆向（2026-06-17）
> zy-code fork 基线：Claude Code v2.1.88

---

## 一、问题背景

zy-code 全屏模式下，在底部展开折叠块时会出现**屏幕漂移**：
- 中间出现一段空白，闪烁后恢复
- 底部有明显的"跳转"感

CC v2.1.179 不存在此问题。根因是 CC 采用了完全不同的渲染架构。

---

## 二、CC VtPlusPlus 渲染器完整架构

### 2.1 渲染管线对比

```
zy-code:  Ink React → Yoga 布局 → render-node-to-output → screen buffer → log-update diff → 终端
CC:       Ink React → Yoga 布局 → render-node-to-output → screen buffer → frameSink(VtPlusPlus) → 终端
```

CC 在 Ink 渲染器和终端之间插入了一个 `frameSink` 层，由 `OMq` 类（VtPlusPlus 渲染器）实现。
`frameSink` 是 Ink 实例（`B5.get(process.stdout)`）上的一个属性，接收 `(frame, stylePool)` 参数。
如果 `frameSink` 返回 `true`，标准 log-update diff 被完全跳过。

### 2.2 VtPlusPlus 渲染器（`OMq` 类）完整字段

```typescript
class VtPlusPlusRenderer {
  out: WritableStream          // process.stdout
  cols: number                 // 终端列数
  rows: number                 // 终端行数
  buf: string                  // 当前帧的输出缓冲
  lastFrame: string            // 上一帧 draw() 的输出快照（帧级去重）
  syncOpen: boolean            // DEC 2026 同步更新是否开启
  suspended: boolean           // 是否被挂起（alt screen 激活时）
  restored: boolean            // 是否已恢复
  tailSlack: number            // 内容不足视口时的尾部空行数
  contentOverlayRows: number   // 被覆盖层遮挡的内容行数
  overlayRatchet: number       // 覆盖层行数棘轮（只增不减，防止抖动）
  onScreen: string[]           // 当前终端可见行数组
  replayPending: boolean       // 是否有待回放的 nativeHistory
  committedTop: number         // 已提交到终端的 scrollTop 位置
  nativeHistory: string[]      // 回滚缓冲（max 10000 行）
  pumpCursor: number           // tickPump 回放游标（-1 = 无回放）
  _backfillNeeded: boolean     // 冷启动需要回填
  _gapRange: {from: number, to: number} | null  // 滚动间隙
  contentHeight: number        // 内容区域高度 = rows - 底部区域高度
}
```

### 2.3 核心方法详解

#### `setup()`
初始化渲染器：重置状态，进入 alt screen，设置 DECSTBM 滚动区域为 `[1, contentHeight]`，清空底部区域。

#### `syncViewport({lines, scrollTop, scrollHeight, transcriptEnd}, contentHeight)`

**这是防闪烁的核心方法。** 每帧调用，负责将 Ink 帧的可视内容同步到终端。

执行流程：

1. **BSU 开启**：如果终端支持 DEC 2026，写入 BSU（Begin Synchronized Update）
2. **恢复覆盖层**：`restoreUnderContentOverlay()` — 如果上一帧有覆盖层遮挡了内容行，先恢复
3. **回放模式检查**：如果 `pumpCursor >= 0`（正在回放 nativeHistory），跳过 syncViewport
4. **replay 恢复**：如果 `replayPending`，将 `committedTop` 设为 `min(scrollTop, transcriptEnd)`
5. **间隙检测**：
   ```
   q = min(scrollTop, transcriptEnd)    // 新的滚动位置
   K = max(0, q - committedTop)         // 向下滚动的行数
   if K > 0:
     w = min(K, onScreen.length)        // 可推入回滚的行数
     // 1. 将 onScreen 的前 w 行推入 nativeHistory
     // 2. 发出光标到内容区底部 + w 个 LF（触发终端原生滚动）
     // 3. 更新 committedTop
     A = committedTop + w
     committedTop = q
     // 4. 如果还有间隙（onScreen 不够推），记录 gapRange
     if A < q:
       _gapRange = {from: A, to: q}
     // 5. 如果 nativeHistory 为空但 q > 0，需要回填
     if nativeHistory.length === 0 && q > 0:
       _backfillNeeded = true
   ```
6. **内容区高度同步**：如果 `contentHeight` 变化，更新 DECSTBM 滚动区域
7. **行级 diff 写入**：
   ```
   O = max(0, committedTop - scrollTop)  // onScreen 中的偏移
   T = contentHeight                      // 视口高度
   z = min(lines.length, T)              // 可用内容行数
   $ = max(0, z - O)                     // 实际写入行数
   for each row w in [0, T):
     A = (w < $) ? lines[O + w] : ""     // 新内容
     if onScreen[w] === A: continue       // 行级去重
     write CSI(y+1, 1) + A + RESET + EL   // 光标定位 + 内容 + 重置 + 清行
     onScreen[w] = A
   ```
8. **尾部空行记录**：`tailSlack = max(0, T - $)`

#### `consumeGapRange()` / `consumeBackfillNeeded()`
消费间隙/回填标志（读取后清除）。由 frameSink 调用，用于判断是否需要从 Ink DOM 回填缺失内容。

#### `primeBackfill(lines: string[])`
将回填行推入 `nativeHistory`，设置 `replayPending = true`，`pumpCursor` 指向新增行的起始位置。
如果 `nativeHistory` 已有内容，清空 `onScreen`（强制全量重绘）。

#### `tickPump()`
渐进式回放 nativeHistory，每帧 100 行（`CHT = 100`）：
- 设置 DECSTBM 为 `[1, 2]`（仅 2 行的滚动区域）
- 写入 100 行到前 2 行，每行后跟 LF 触发滚动
- 恢复 DECSTBM 为 `[1, contentHeight]`
- 返回 `true` 表示还有更多行需要回放

#### `draw(layout)`
原子绘制最终帧：
1. BSU 开启
2. 进入内容区 DECSTBM
3. 恢复覆盖层遮挡
4. 更新内容区高度
5. 清空底部区域行
6. 清空尾部空行（`tailSlack`）
7. 写入底部区域（输入框等）
8. 写入覆盖层（如果有）
9. **帧级去重**：与 `lastFrame` 比较，完全相同则跳过写入
10. ESU 关闭 + `commitImmediate()`

#### `computeLayout(bottomLines, overlayLines)`
计算布局：`contentHeight = max(2, rows - max(iO_, bottomLines.length))`，其中 `iO_ = 4`（底部最小高度）。

#### `handleResize(cols, rows)`
终端尺寸变化处理：
- 列数变化或行数减少 → 完全重置（清屏 + 重放 nativeHistory）
- 仅行数增加 → 调整 DECSTBM 区域

#### `suspend()` / `resume(cols, rows)`
alt screen 激活时挂起（写入 `pg` = exit alt screen），恢复时重新进入并重放。

### 2.4 frameSink 集成点（`Vf4` 函数 = FullscreenLayout 等价）

```javascript
function Vf4({scrollable, bottom, pushUp, overlay, scrollRef}) {
  const {columns, rows} = useTerminalSize()
  const vtppRef = useRef(null)
  const bottomRef = useRef(null)
  const overlayRef = useRef(null)
  const transcriptEndRef = useRef(null)

  useInsertionEffect(() => {
    const ink = B5.get(process.stdout)  // 获取 Ink 实例
    if (!ink) return
    const vtpp = new OMq(process.stdout, columns, rows)
    vtpp.setup()
    vtppRef.current = vtpp
    let wasSuspended = false

    // 注册 frameSink — 拦截每一帧 Ink 输出
    ink.frameSink = (frame, stylePool) => {
      const g = vtppRef.current
      if (!g) return false

      // alt screen 激活时挂起 VtPlusPlus
      if (ink.isAltScreenActive) {
        if (!wasSuspended) g.suspend(), wasSuspended = true
        return false
      }
      if (wasSuspended) wasSuspended = false, g.resume(g.cols, g.rows)

      // 1. 回放 nativeHistory（如果有）
      const tickMore = g.tickPump()

      // 2. 提取底部和覆盖层行
      const bottomLines = extractLines(frame, stylePool, bottomRef.current)
      const overlayLines = extractLines(frame, stylePool, overlayRef.current)

      // 3. 计算布局
      const layout = g.computeLayout(bottomLines, overlayLines)

      // 4. 提取可滚动区域的可见行
      const scrollDom = scrollRef.current?.getDomElement()
      if (scrollDom) {
        const cached = MA.get(scrollDom)  // 布局缓存
        const lines = []
        if (cached && cached.height > 0) {
          const end = Math.min(cached.y + cached.height, frame.screen.height)
          for (let y = cached.y; y < end; y++)
            lines.push(extractLine(frame.screen, stylePool, y))
        }
        const scrollHeight = scrollDom.scrollHeight ?? 0
        const transcriptEnd = computeTranscriptEnd(transcriptEndRef.current, scrollDom) ?? scrollHeight

        // 5. 同步视口（核心防闪烁逻辑）
        g.syncViewport(
          {lines, scrollTop: scrollDom.scrollTop ?? 0, scrollHeight, transcriptEnd},
          layout.contentHeight
        )
      }

      // 6. 间隙检测 + 回填
      let needTick = false
      if (scrollDom) {
        const gap = g.consumeGapRange()
        const backfill = g.consumeBackfillNeeded()
        if (gap || backfill) {
          const from = gap ? gap.from : 0
          const to = gap ? gap.to : (scrollDom.scrollTop ?? 0)
          const backfillLines = renderBackfill(scrollDom, from, to, g.cols, stylePool)
          if (backfillLines.length > 0) {
            g.primeBackfill(backfillLines)
            needTick = true
          }
        }
      }

      // 7. 原子绘制
      g.draw(layout)

      return (tickMore || needTick) ? "tick" : true
      // 返回 true = 跳过标准 log-update diff
      // 返回 "tick" = 跳过 diff + 请求下一帧继续（回放未完成）
    }

    return () => {
      ink.frameSink = null
      vtpp.restore()
      vtppRef.current = null
    }
  }, [])

  // 终端尺寸变化
  useLayoutEffect(() => {
    vtppRef.current?.handleResize(columns, rows)
  }, [columns, rows])

  return (
    <Box flexDirection="column" height={rows} width="100%" flexShrink={0}>
      <ScrollBox ref={scrollRef} flexGrow={1} flexDirection="column" stickyScroll={true}>
        {scrollable}
      </ScrollBox>
      <Box ref={bottomRef} flexDirection="column" flexShrink={0} minHeight={4} maxHeight={rows - 2}>
        {pushUp}
        {bottom}
      </Box>
      {overlay && (
        <Box ref={overlayRef} flexDirection="column" flexShrink={0}
             position="absolute" bottom={0} left={0} right={0} opaque={true}>
          {overlay}
        </Box>
      )}
    </Box>
  )
}
```

### 2.5 回填渲染（`xHT` 函数）

当检测到间隙时，从 Ink DOM 渲染缺失行：

```javascript
function renderBackfill(scrollDom, from, to, cols, stylePool) {
  const content = scrollDom.childNodes[0]  // ScrollBox 的内容包裹节点
  if (!content) return []
  if ((scrollDom.scrollHeight ?? 0) <= 0 || to <= from) return []

  const ink = B5.get(process.stdout)
  if (!ink) return []

  const endY = Math.ceil(to)
  const startY = Math.max(0, Math.floor(from), endY - 10000)  // max 10000 行
  const count = endY - startY
  if (count <= 0) return []

  // 创建临时 screen buffer
  const screen = createScreen(cols, count, stylePool, ink.getCharPool(), ink.getHyperlinkPool())
  screen.clip({y1: 0, y2: count})

  // 从 Ink DOM 渲染内容到临时 screen（offsetY = -startY 实现滚动偏移）
  renderNodeToOutput(content, screen, {offsetX: 0, offsetY: -startY, prevScreen: undefined})
  screen.unclip()

  // 提取每行文本
  content.dirty = true  // 标记为脏，使下一帧重新渲染
  const lines = []
  for (let y = 0; y < count; y++)
    lines.push(extractLine(screen.get(), stylePool, y))
  return lines
}
```

### 2.6 CC ScrollBox 的额外特性

#### `followGrowth` 属性
```javascript
// CC render-node-to-output 中的 atBottom 判断：
let t = node.attributes.followGrowth !== false  // 默认 true
let atBottom = sticky || (n !== false && t && grew && scrollTop >= prevMaxScroll)
```

即使 `stickyScroll` 被显式设为 `false`（用户手动滚动过），只要 `followGrowth` 不为 `false`（默认 true）且内容增长，仍然自动跟随到底部。

zy-code 没有此属性，只有 `sticky || (grew && scrollTop >= prevMaxScroll)`。

#### `scrollTopRendered` 字段
```javascript
// CC:
let JH = zH - (node.scrollTopRendered ?? zH)  // 与上一帧渲染位置比较
if (JH !== 0) {
  followScroll = {delta: JH, viewportTop, viewportBottom}
}
node.scrollTopRendered = zH  // 记录本次渲染位置

// zy-code: 使用 contentCached.y 间接推断，无 scrollTopRendered 字段
```

### 2.7 常量定义

| 常量 | 值 | 含义 |
|------|-----|------|
| `CHT` | 100 | tickPump 每帧回放行数 |
| `nO_` | 10000 | nativeHistory 最大行数 |
| `iO_` | 4 | 底部区域最小高度 |
| `UU_` | `\x1B[0m` | SGR 重置 |
| `KMq` | `\x1B[K` | EL（擦除到行尾） |
| `Y2H` | `\x1B[2K` | EL2（擦除整行） |
| `CG_` | BSU | Begin Synchronized Update |
| `PtH` | ESU | End Synchronized Update |
| `jp` | enter alt screen | 进入 alt screen |
| `pg` | exit alt screen | 退出 alt screen |
| `FM` | cursor visible | 显示光标 |

---

## 三、zy-code 当前渲染管线分析

### 3.1 渲染流程

```
React commit
  → scheduleRender (throttled, microtask deferred)
  → onRender()
    → calculateLayout() (Yoga)
    → renderer() (render-node-to-output.ts)
      → renderNodeToOutput(node, output, {prevScreen})
      → 生成 screen buffer + scrollHint + scrollDrainNode
    → applySelectionOverlay / applySearchHighlight (alt screen)
    → log.render(prevFrame, frame, altScreen, decstbmSafe)
      → DECSTBM 滚动优化 (shiftRows + CSI SU/SD)
      → 逐行 diff (diffEach)
      → 缩小处理 (eraseLines)
      → 增长处理 (光标下移 + 新行写入)
      → fullResetSequence_CAUSES_FLICKER (回退：清屏重绘)
    → 输出 diff 到终端
```

### 3.2 闪烁触发路径

`fullResetSequence_CAUSES_FLICKER` 在以下场景触发（[log-update.ts](../../src/ink/log-update.ts#L455)）：

1. **视口尺寸变化**（行 135）：`viewport.height < prev.height || width 变化`
2. **内容从溢出缩小到视口内**（行 192）：`prevHadScrollback && nextFitsViewport && isShrinking`
3. **回滚区行变化**（行 220）：`prevHadScrollback && !isGrowing && scrollbackChangeY >= 0`
4. **缩小超过视口容量**（行 242）：`linesToClear > prev.viewport.height`

在 alt-screen 模式下，zy-code 通过 `viewport.height = terminalRows + 1`（[renderer.ts:135](../../src/ink/renderer.ts#L135)）缓解了 #2 和 #3，但不完全消除。

### 3.3 DECSTBM 快速路径限制

[render-node-to-output.ts:827-870](../../src/ink/render-node-to-output.ts#L827) 中的 `safeForFastPath` 判断：

```typescript
const safeForFastPath =
  !hint || heightDelta === 0 || (hint.delta > 0 && heightDelta === hint.delta)
if (!safeForFastPath) {
  scrollHint = null  // 清除提示，回退到完整 diff 路径
}
```

展开折叠块时，内容高度增长（`heightDelta > 0`），sticky 跟随使 scrollTop 移动 `heightDelta` 行。
此时 `hint.delta = heightDelta`，理论上 `safeForFastPath = true`。

但如果展开的内容跨越了虚拟滚动边界（新挂载的子节点改变了 Yoga 布局），`contentCached.y` 可能与预期不符，导致 `delta >= innerHeight` → `layoutShifted = true` → 全量重写。

### 3.4 关键文件清单

| 文件 | 职责 |
|------|------|
| [src/ink/ink.tsx](../../src/ink/ink.tsx) | Ink 类主入口，onRender 调用 renderer + log.render |
| [src/ink/renderer.ts](../../src/ink/renderer.ts) | 渲染器：Yoga 布局 → renderNodeToOutput → Frame |
| [src/ink/render-node-to-output.ts](../../src/ink/render-node-to-output.ts) | DOM → screen buffer 渲染，sticky follow，DECSTBM 提示 |
| [src/ink/log-update.ts](../../src/ink/log-update.ts) | screen buffer diff → 终端输出序列，fullReset 回退 |
| [src/ink/components/ScrollBox.tsx](../../src/ink/components/ScrollBox.tsx) | ScrollBox 组件 + 命令式滚动 API |
| [src/hooks/useVirtualScroll.ts](../../src/hooks/useVirtualScroll.ts) | 虚拟滚动 hook，useDeferredValue 时间切片 |
| [src/components/FullscreenLayout.tsx](../../src/components/FullscreenLayout.tsx) | 全屏布局组件，divider/pill/sticky 管理 |
| [src/ink/terminal.ts](../../src/ink/terminal.ts) | 终端能力检测（DEC 2026、DECSTBM 支持） |
| [src/ink/termio/csi.ts](../../src/ink/termio/csi.ts) | CSI 序列（DECSTBM、SU/SD、光标移动） |
| [src/ink/termio/dec.ts](../../src/ink/termio/dec.ts) | DEC 序列（BSU/ESU 同步更新） |

---

## 四、移植方案

### 4.1 方案选型

| 方案 | 工作量 | 效果 | 风险 |
|------|--------|------|------|
| A. 完整移植 VtPlusPlus | 大（~2000 行） | 根治 | 需要改 Ink 类，影响面大 |
| B. 渐进式增强 | 中（~800 行） | 大幅缓解 | 可分阶段上线，风险可控 |
| C. 最小补丁 | 小（~200 行） | 部分缓解 | 不改变架构，治标不治本 |

**推荐方案 B**：渐进式增强，分 4 个阶段实施。每个阶段独立可验证，可随时停止。

### 4.2 阶段一：添加 `followGrowth` + `scrollTopRendered`（最小补丁）

**目标**：消除 sticky 被打破时的跟丢问题，提高滚动位置追踪精度。

**改动文件**：
- `src/ink/components/ScrollBox.tsx` — 添加 `followGrowth` 属性
- `src/ink/render-node-to-output.ts` — 添加 `scrollTopRendered` 字段，修改 atBottom 判断
- `src/components/FullscreenLayout.tsx` — 传递 `followGrowth` 属性
- `src/ink/global.d.ts` — 添加 `followGrowth` 和 `scrollTopRendered` 类型声明

**具体改动**：

1. ScrollBox 添加 `followGrowth` 属性传递：
```typescript
// ScrollBox.tsx
export type ScrollBoxProps = Except<Styles, ...> & {
  ref?: Ref<ScrollBoxHandle>
  stickyScroll?: boolean
  followGrowth?: boolean  // 新增
}
// 在 inkBoxProps 中传递
...(followGrowth !== undefined ? { followGrowth } : {})
```

2. render-node-to-output.ts 修改 atBottom 判断：
```typescript
// 现有：
const atBottom = sticky || (grew && scrollTopBeforeFollow >= prevMaxScroll)

// 改为：
const followGrowth = node.attributes.followGrowth !== false
const atBottom = sticky || (followGrowth && grew && scrollTopBeforeFollow >= prevMaxScroll)
```

3. 添加 `scrollTopRendered` 追踪：
```typescript
// 在 drain 之后、渲染之前
const renderedDelta = scrollTop - (node.scrollTopRendered ?? scrollTop)
if (renderedDelta !== 0) {
  followScroll = {
    delta: renderedDelta,
    viewportTop: node.scrollViewportTop ?? 0,
    viewportBottom: (node.scrollViewportTop ?? 0) + innerHeight - 1,
  }
}
node.scrollTopRendered = scrollTop
```

**验证**：手动滚动离开底部 → 新消息到达 → 应自动跟随到底部。

### 4.3 阶段二：优化 DECSTBM 快速路径（减少 fullReset 触发）

**目标**：展开折叠块时避免 `layoutShifted = true` 和 `safeForFastPath = false`。

**改动文件**：
- `src/ink/render-node-to-output.ts` — 优化 `safeForFastPath` 判断
- `src/ink/log-update.ts` — alt-screen 模式下更宽松的 fullReset 条件

**具体改动**：

1. 放宽 `safeForFastPath` 判断：
```typescript
// 现有：仅允许 heightDelta === 0 或 heightDelta === hint.delta
// 改为：允许 heightDelta > 0 且 hint.delta > 0（内容增长 + 向下滚动）
const safeForFastPath =
  !hint ||
  heightDelta === 0 ||
  (hint.delta > 0 && heightDelta > 0 && hint.delta >= heightDelta * 0.5)
```

2. alt-screen 模式下跳过 scrollback 相关的 fullReset：
```typescript
// log-update.ts render() 方法中
// alt-screen 模式下，内容始终在视口内，不需要 scrollback 检查
if (altScreen) {
  // 跳过 prevHadScrollback && nextFitsViewport && isShrinking 检查
  // 跳过 scrollbackChangeY >= 0 检查
  // 直接进入 diff 路径
}
```

3. 展开/折叠场景的预计算：在 VirtualMessageList 中，展开/折叠时预先设置 scrollHint：
```typescript
// 在 onItemClick 回调中
const handleClick = (msg) => {
  const oldHeight = getItemHeight(msg)
  setExpandedKeys(...)
  // 下一帧渲染前，预计算 heightDelta 并通知 ScrollBox
  requestAnimationFrame(() => {
    const newHeight = getItemHeight(msg)
    scrollRef.current?.notifyContentResize(newHeight - oldHeight)
  })
}
```

**验证**：在底部展开一个大折叠块 → 不应出现空白闪烁。

### 4.4 阶段三：实现 frameSink 框架（VtPlusPlus 雏形）

**目标**：在 Ink 类中添加 `frameSink` 属性，实现行级 diff + 帧级去重，替代 log-update 的 fullReset 路径。

**新增文件**：
- `src/ink/vtplus/VtPlusPlusRenderer.ts` — VtPlusPlus 渲染器类
- `src/ink/vtplus/frameSink.ts` — frameSink 集成逻辑
- `src/ink/vtplus/lineExtractor.ts` — 从 screen buffer 提取行文本

**改动文件**：
- `src/ink/ink.tsx` — 添加 `frameSink` 属性，onRender 中优先调用 frameSink
- `src/components/FullscreenLayout.tsx` — useInsertionEffect 中注册 frameSink

**VtPlusPlusRenderer 核心实现**（简化版，不含 nativeHistory/tickPump）：

```typescript
export class VtPlusPlusRenderer {
  private out: WritableStream
  private cols: number
  private rows: number
  private buf = ''
  private lastFrame = ''
  private onScreen: string[] = []
  private committedTop = 0
  private contentHeight: number
  private syncOpen = false

  constructor(out: WritableStream, cols: number, rows: number) {
    this.out = out
    this.cols = cols
    this.rows = rows
    this.contentHeight = Math.max(2, rows - 4)  // iO_ = 4
  }

  setup(): void {
    this.buf += ENTER_ALT_SCREEN
    this.buf += CURSOR_DOWN.repeat(this.rows - this.contentHeight)
    this.buf += SET_SCROLL_REGION(1, this.contentHeight)
    for (let y = this.contentHeight; y < this.rows; y++) this.clearLine(y)
    this.commitImmediate()
  }

  syncViewport(
    state: {lines: string[]; scrollTop: number; scrollHeight: number; transcriptEnd: number},
    contentHeight: number,
  ): void {
    // BSU
    if (!this.syncOpen && syncOutputSupported()) {
      this.buf += BSU
      this.syncOpen = true
    }

    const q = Math.min(state.scrollTop, state.transcriptEnd)
    const K = Math.max(0, q - this.committedTop)

    if (K > 0) {
      // 向下滚动：将 onScreen 行推出
      const w = Math.min(K, this.onScreen.length)
      if (w > 0) {
        this.buf += CURSOR_TO(this.contentHeight, 1)
        this.buf += '\n'.repeat(w)
        this.onScreen.splice(0, w)
      }
      this.committedTop = q
    }

    // 内容区高度变化
    if (contentHeight !== this.contentHeight) {
      this.contentHeight = contentHeight
      this.buf += SET_SCROLL_REGION(1, Math.max(2, contentHeight))
    }

    // 行级 diff 写入
    const offset = Math.max(0, this.committedTop - state.scrollTop)
    const T = this.contentHeight
    const available = Math.min(state.lines.length, T)
    const writeCount = Math.max(0, available - offset)

    while (this.onScreen.length < T) this.onScreen.push('')
    while (this.onScreen.length > T) this.onScreen.pop()

    for (let w = 0; w < T; w++) {
      const line = w < writeCount ? state.lines[offset + w] : ''
      if (this.onScreen[w] === line) continue
      this.buf += CURSOR_TO(w + 1, 1) + line + SGR_RESET + ERASE_TO_END
      this.onScreen[w] = line
    }
  }

  draw(layout: {
    contentHeight: number
    bottomTop: number
    bottomLines: string[]
    overlayLines: string[]
  }): void {
    if (layout.contentHeight !== this.contentHeight) {
      this.contentHeight = layout.contentHeight
      this.buf += SET_SCROLL_REGION(1, Math.max(2, layout.contentHeight))
    }
    // 清空底部区域
    for (let y = this.contentHeight; y < this.rows; y++) this.clearLine(y)
    // 写入底部
    this.writeOverlayLines(layout.bottomTop, layout.bottomLines)

    // 帧级去重
    const frameOutput = this.buf
    if (!this.syncOpen && frameOutput === this.lastFrame) {
      this.buf = ''
      this.syncOpen = false
      return
    }
    this.lastFrame = frameOutput
    if (syncOutputSupported()) this.buf += ESU
    this.syncOpen = false
    this.commitImmediate()
  }

  // ... restore(), handleResize(), clearLine(), writeOverlayLines(), commitImmediate()
}
```

**Ink 类改动**：

```typescript
// ink.tsx
export default class Ink {
  // 新增
  frameSink: ((frame: Frame, stylePool: StylePool) => boolean | "tick") | null = null
  isAltScreenActive = false  // 新增：外部 alt screen 状态

  private onRender = (): void => {
    // ... 现有渲染逻辑生成 frame ...

    // 新增：frameSink 优先
    if (this.frameSink && this.altScreenActive) {
      const result = this.frameSink(frame, this.stylePool)
      if (result === true || result === "tick") {
        // frameSink 处理了输出，跳过 log-update diff
        this.backFrame = this.frontFrame
        this.frontFrame = frame
        if (result === "tick") {
          this.scheduleRender()  // 请求下一帧继续
        }
        return
      }
    }

    // 现有 log-update diff 路径
    const diff = this.log.render(prevFrame, frame, this.altScreenActive, SYNC_OUTPUT_SUPPORTED)
    // ...
  }
}
```

**FullscreenLayout 改动**：

```typescript
// FullscreenLayout.tsx
useInsertionEffect(() => {
  const ink = getInkInstance()
  if (!ink) return
  const vtpp = new VtPlusPlusRenderer(process.stdout, columns, rows)
  vtpp.setup()

  ink.frameSink = (frame, stylePool) => {
    // ... 提取行、syncViewport、draw
    return true
  }

  return () => {
    ink.frameSink = null
    vtpp.restore()
  }
}, [])
```

**验证**：
- 基本渲染正确（文本、颜色、边框）
- 滚动正常（滚轮、PgUp/PgDn、scrollToBottom）
- 展开/折叠无闪烁
- 底部输入框正确显示

### 4.5 阶段四：实现 gap 检测 + backfill（完整 VtPlusPlus）

**目标**：实现 nativeHistory 回滚缓冲 + tickPump 渐进式回放，支持快速滚动和会话恢复时的无缝回填。

**新增内容**：
- `nativeHistory: string[]` — 回滚缓冲（max 10000 行）
- `pumpCursor` — 回放游标
- `consumeGapRange()` / `consumeBackfillNeeded()` — 间隙检测
- `primeBackfill(lines)` — 回填注入
- `tickPump()` — 渐进式回放（100 行/帧）
- `suspend()` / `resume()` — alt screen 挂起/恢复
- `handleResize()` — 完整尺寸变化处理（重放）

**关键实现**：

```typescript
syncViewport(state, contentHeight) {
  // ... 现有逻辑 ...

  if (K > 0) {
    const w = Math.min(K, this.onScreen.length)
    if (w > 0) {
      // 推入 nativeHistory
      for (let f = 0; f < w; f++) {
        this.nativeHistory.push(this.onScreen.shift()!)
      }
      // 截断超出上限的旧记录
      if (this.nativeHistory.length > MAX_HISTORY) {
        this.nativeHistory.splice(0, this.nativeHistory.length - MAX_HISTORY)
      }
    }
    const newCommitted = this.committedTop + w
    this.committedTop = q
    // 间隙检测
    if (newCommitted < q) {
      this._gapRange = {from: newCommitted, to: q}
    }
    // 回填需求检测
    if (this.nativeHistory.length === 0 && q > 0) {
      this._backfillNeeded = true
    }
  }
}

tickPump(): boolean {
  if (this.pumpCursor < 0) return false
  const history = this.nativeHistory
  this.buf += SET_SCROLL_REGION(1, 2)
  const end = Math.min(this.pumpCursor + PUMP_BATCH, history.length)
  for (; this.pumpCursor < end; this.pumpCursor++) {
    this.buf += CURSOR_TO(1, 1) + history[this.pumpCursor] + SGR_RESET + ERASE_LINE
    this.buf += CURSOR_TO(2, 1) + '\n'
  }
  this.buf += SET_SCROLL_REGION(1, Math.max(2, this.contentHeight))
  this.lastFrame = ''
  this.commitImmediate()
  if (this.pumpCursor >= history.length) this.pumpCursor = -1
  return this.pumpCursor >= 0
}
```

**frameSink 中的回填集成**：

```typescript
ink.frameSink = (frame, stylePool) => {
  const tickMore = vtpp.tickPump()

  // ... 提取行、syncViewport ...

  // 间隙检测 + 回填
  const gap = vtpp.consumeGapRange()
  const backfill = vtpp.consumeBackfillNeeded()
  if (gap || backfill) {
    const from = gap ? gap.from : 0
    const to = gap ? gap.to : (scrollDom.scrollTop ?? 0)
    const lines = renderBackfillFromDOM(scrollDom, from, to, cols, stylePool)
    if (lines.length > 0) {
      vtpp.primeBackfill(lines)
    }
  }

  vtpp.draw(layout)
  return (tickMore || gap || backfill) ? "tick" : true
}
```

**验证**：
- 快速 PageUp 滚动 → 无空白闪烁，内容渐进式回填
- 会话恢复（resume）→ 回滚历史正确显示
- `/clear` 后 → nativeHistory 正确清空
- 终端尺寸变化 → 重放正确

---

## 五、实施计划

### 5.1 时间线

| 阶段 | 预估工时 | 优先级 | 可独立上线 |
|------|----------|--------|------------|
| 阶段一：followGrowth + scrollTopRendered | 1-2 天 | P0 | ✅ |
| 阶段二：DECSTBM 快速路径优化 | 2-3 天 | P0 | ✅ |
| 阶段三：frameSink 框架 | 5-7 天 | P1 | ✅ |
| 阶段四：gap 检测 + backfill | 5-7 天 | P2 | ✅ |

### 5.2 阶段一 + 阶段二预期效果

阶段一和二不需要改变渲染架构，仅优化现有 diff 路径：
- 消除 sticky 被打破时的跟丢问题
- 减少 `fullResetSequence_CAUSES_FLICKER` 在展开/折叠场景的触发
- **预期消除 80% 的可见闪烁**

### 5.3 阶段三 + 阶段四预期效果

完整移植 VtPlusPlus 渲染器：
- 行级 diff + 帧级去重 → 零闪烁
- gap 检测 + backfill → 快速滚动无空白
- nativeHistory → 原生终端回滚支持
- **预期消除 100% 的可见闪烁**

### 5.4 风险与回退

| 风险 | 影响 | 缓解 |
|------|------|------|
| frameSink 与 log-update 冲突 | 渲染异常 | frameSink 仅在 alt-screen 模式启用，默认走 log-update |
| VtPlusPlus 行提取与 Ink DOM 不一致 | 内容错位 | 行提取使用与 render-node-to-output 相同的 `extractLine` 函数 |
| nativeHistory 内存泄漏 | RSS 增长 | max 10000 行硬上限 + 定期截断 |
| 终端不支持 DEC 2026 | 中间态可见 | 检测 `SYNC_OUTPUT_SUPPORTED`，不支持时仍用 diff 路径 |
| tmux 透传 | DECSTBM 原子性破坏 | tmux 检测 → 禁用 frameSink，回退 log-update |

### 5.5 测试策略

1. **单元测试**：VtPlusPlusRenderer 的 syncViewport / draw / tickPump 逻辑
2. **集成测试**：frameSink 与 Ink 渲染管线的交互
3. **手动验证矩阵**：

| 场景 | 验证点 |
|------|--------|
| 底部展开折叠块 | 无闪烁、无空白 |
| 底部折叠已展开块 | 无闪烁、内容正确收缩 |
| 流式输出 | 无闪烁、sticky 跟随 |
| 快速 PageUp | 渐进式回填、无空白 |
| 会话恢复 | 回滚历史正确 |
| 终端尺寸变化 | 重放正确 |
| tmux 内运行 | 回退 log-update，功能正常 |
| VS Code 终端 | xterm.js 适配正常 |
| `/clear` | nativeHistory 清空 |
| 外部编辑器（vim） | suspend/resume 正确 |

---

## 六、附录

### 6.1 CC 二进制关键偏移量

| 内容 | 偏移 | 函数/类 |
|------|------|---------|
| VtPlusPlus 类定义 | ~214864000 | `OMq` |
| FullscreenLayout 等价 | ~213653000 | `Vf4` |
| ScrollBox 等价 | ~213653866 | `vpO` |
| render-node-to-output | ~206257000 | scroll/sticky 逻辑 |
| ScrollKeybindingHandler | ~214175000 | `Pfq` |
| divider hook | ~214870000 | `Bf4` |
| 全屏布局组件 | ~214875000 | `fMq` |

### 6.2 zy-code 关键文件

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/ink/ink.tsx` | 2043 | Ink 类主入口 |
| `src/ink/renderer.ts` | 153 | 渲染器 |
| `src/ink/render-node-to-output.ts` | 1415 | DOM → screen buffer |
| `src/ink/log-update.ts` | 690 | screen buffer diff |
| `src/ink/components/ScrollBox.tsx` | 264 | ScrollBox 组件 |
| `src/hooks/useVirtualScroll.ts` | ~600 | 虚拟滚动 |
| `src/components/FullscreenLayout.tsx` | 556 | 全屏布局 |

### 6.3 DECSTBM / BSU / ESU 序列参考

```
DECSTBM:  CSI top;bottom r    — 设置滚动区域
SU:       CSI n S              — 向上滚动 n 行（内容下移）
SD:       CSI n T              — 向下滚动 n 行（内容上移）
BSU:      CSI ? 2026h          — 开始同步更新（DEC 2026）
ESU:      CSI ? 2026l          — 结束同步更新
CUP:      CSI row;col H        — 光标定位
EL:       CSI K                — 擦除到行尾
EL2:      CSI 2K               — 擦除整行
ED2:      CSI 2J               — 擦除整屏
```

---

## 七、实施记录与已知问题（2026-06-17 更新）

### 7.1 已完成

| 阶段 | 状态 | 说明 |
|------|------|------|
| Phase 1: followGrowth + scrollTopRendered | ✅ 已应用 | dom.ts, ScrollBox.tsx, render-node-to-output.ts, FullscreenLayout.tsx |
| Phase 2: alt-screen fullReset 跳过 | ✅ 已应用 | log-update.ts 中 3 处 `!altScreen` 守卫 |
| Phase 3: frameSink + 全屏行级 diff | ✅ 已应用 | VtPlusPlusRenderer.ts, ink.tsx, FullscreenLayout.tsx |
| turn_duration 持久化修复 | ✅ 已应用 | replQueryFlow.ts 中直接调用 recordTranscript |

### 7.2 Phase 2 安全放宽（已回滚）

以下改动曾尝试但已回滚（导致底部消息丢失）：
- `safeForFastPath` 放宽 `delta >= heightDelta * 0.5` — DECSTBM blit+shift 漏渲染底部新行
- `followDelta` 改用 `scrollTopRendered` — followScroll 误触发，文本选择错位

### 7.3 Phase 4 已知问题（syncViewport/drawBottom 路径）

Phase 4 的内容/底部区分割路径（syncViewport + drawBottom + DECSTBM）在实现过程中遇到以下问题，**当前 renderFrame 使用 Phase 3 全屏行级 diff 作为稳定回退**。Phase 4 方法保留在 VtPlusPlusRenderer 类中供后续修复。

#### 问题 1：底部消息丢失（"处理完成，耗时xx秒"不可见）

**表现**：启用 syncViewport/drawBottom 后，新对话中最后一条系统消息（turn_duration）不可见。

**根因分析**：
- `drawBottom` 使用 `EL2`（CSI 2K，擦除整行）清除底部区域
- 底部区域起始行 `bottomTop = contentY + contentHeight`
- `contentHeight` 来自 `nodeCache.get(scrollDom).height`
- 当 nodeCache 的 height 与实际 ScrollBox 渲染高度在某些帧不一致时（例如 Yoga 布局更新时序差异），`bottomTop` 可能落在内容区最后一行上
- `drawBottom` 的 `EL2` 擦除了内容区最后一行（即 "处理完成" 消息）
- 随后 `drawBottom` 写入底部区域内容（输入框），覆盖了被擦除的消息

**CC 为什么不受影响**：
- CC 的 `Vf4`（FullscreenLayout 等价）将 ScrollBox 和底部区域分别用独立 `ref` 引用
- CC 的 `computeLayout` 从底部 DOM 元素的 `nodeCache` 条目计算 `bottomTop`，而非从 ScrollBox 的 `height` 推导
- zy-code 只有 `scrollRef`，底部区域位置通过 `contentY + contentHeight` 推算，依赖 nodeCache 精度

**修复方向**：
- 为 FullscreenLayout 的底部区域添加独立 `ref`
- 从底部 DOM 元素的 nodeCache 条目直接获取 `bottomTop`，而非从 ScrollBox height 推算
- 或：`drawBottom` 只清除 `this.contentHeight` 以下的行（使用 syncViewport 更新后的值），不使用 `layout.bottomTop`

#### 问题 2：快速滚动内容重复

**表现**：快速 PageUp/PageDown 时，屏幕上出现重复内容。

**根因分析**：
- `syncViewport` 的 LF 滚动（`cursorPosition(contentHeight, 1) + '\n'.repeat(w)`）依赖 DECSTBM 滚动区域精确匹配 `contentHeight`
- 当 `contentHeight` 在帧间变化时，DECSTBM 可能未及时更新（CC 顺序：LF 在前，contentHeight 更新在后）
- LF 不在正确的滚动区域底部 → 终端不滚动 → `onScreen.shift()` 已执行 → 行级 diff 跳过应更新行
- 向上滚动时 `offset > 0`，顶部新进入的行不被写入

**CC 为什么不受影响**：
- CC 的目标终端（iTerm2、WezTerm 等）都支持 DEC 2026（BSU/ESU），`syncOpen = true`，帧级去重被跳过
- CC 的 `draw()` 也有相同的去重模式，但在 `syncOpen = true` 时不触发
- zy-code 需要支持 macOS Terminal.app（不支持 DEC 2026），去重可能误触发

**修复方向**：
- 向上滚动时 `committedTop = q` + `onScreen = []`（强制全量重写）— 已实现
- 向下滚动时如果 `contentHeight` 变化，跳过 LF 滚动，直接全量重写
- 或：不使用 LF 终端原生滚动，改为纯行级 diff（Phase 3 方式）

#### 问题 3：帧级去重误清 syncViewport 输出

**表现**：不滚动时内容也重复。

**根因分析**：
- `drawBottom` 的帧级去重 `this.buf = ''` 清除了整个缓冲（包括 syncViewport 的内容区写入）
- 当底部区域未变化时，去重触发，内容区更新丢失
- 仅在 `SYNC_OUTPUT_SUPPORTED = false` 时发生（macOS Terminal.app）

**修复**：帧级去重移到 `renderFrame`，覆盖 syncViewport + drawBottom 完整输出 — 已实现

### 7.4 当前稳定状态

```
renderFrame:
  tickPump()           — 回放 nativeHistory（当前不激活）
  BSU                  — 同步更新开始
  全屏行级 diff        — 提取所有行，与 onScreen[] 逐行比较
  帧级去重             — 覆盖完整输出
  ESU + commit         — 同步更新结束 + 写入终端
```

Phase 4 方法（syncViewport、drawBottom、tickPump、nativeHistory、committedTop 等）保留在类中，通过环境变量 `ZY_CODE_VTPLUS=1` 可切换到 Phase 4 路径进行测试。
