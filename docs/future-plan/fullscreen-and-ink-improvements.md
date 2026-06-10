# 全屏模式 & Ink 渲染引擎：zy-code vs Claude Code v2.1.167 差异分析与改进方案

> 最后更新：2026-06-06
> 基于 Claude Code v2.1.167 二进制逆向 + zy-code 源码逐函数对比。
> zy-code fork 基线：Claude Code v2.1.88，当前差距 79 个版本。

---

## 一、全屏模式（Fullscreen / TUI）差异

### 1.1 分辨率函数对比

**zy-code** `isFullscreenEnvEnabled()` — 4 层判断：

```
1. ZY_CODE_NO_FLICKER=0 → false（显式关闭）
2. ZY_CODE_NO_FLICKER=1 → true（显式开启）
3. tmux -CC 检测 → false（自动禁用）
4. isInternalBuild() → true/false（蚂蚁内部默认开）
```

**CC 167** `ffH()` + `A9()` — 8+ 层判断：

```
1. bg_forced_on    → CLAUDE_CODE_SESSION_KIND==="bg" 强制开启
2. env_off         → NO_FLICKER=0 或 DISABLE_ALTERNATE_SCREEN=1
3. env_on          → NO_FLICKER=1
4. tmux_cc_auto_off → tmux -CC 自动禁用
5. win_ssh_auto_off → Windows + SSH (ConPTY) 自动禁用
6. settings_on/off → userSettings.tui 持久化偏好
7. downsell_on     → Downsell 推广机制触发
8. gb_on/gb_off   → GrowthBook feature flag 灰度
```

**关键差异**：
- zy-code 缺少 bg 会话强制、Windows+SSH 检测、settings 持久化、推广管线
- CC 167 用 feature flag 替代 isInternalBuild()，可面向外部用户灰度

### 1.2 返回值设计

| 维度 | zy-code | CC 167 |
|------|---------|--------|
| 返回类型 | `boolean` | 原因字符串（12 种）→ 映射为 `"fullscreen"` / `"default"` |
| 遥测归因 | 仅 debug 日志 | 精确记录每个决策原因 |

CC 167 的 `ffH()` 返回 `"bg_forced_on"` / `"env_off"` / `"tmux_cc_auto_off"` 等字符串，`xt9(reason)` 再映射为渲染器名。好处是遥测可以精确归因：「用户为什么进入了这个渲染器」。

### 1.3 `/tui` 命令（zy-code 完全缺失）

CC 167 有完整的 `/tui` 命令：

```
/tui fullscreen → 切换到全屏渲染器
/tui default   → 切回经典渲染器
```

实现逻辑：
1. 后台会话拒绝切换：`"Background sessions always use the fullscreen renderer..."`
2. 有后台任务运行时拒绝：`"Cannot switch renderers while background tasks are running"`
3. 写入 `userSettings.tui` 到 settings.json
4. 遥测 `tengu_tui_command`（含 from/to/session_age/scroll_decay 等参数）
5. 切回 default 时弹反馈输入框：`"What made you switch back?"`
6. 调用 `gC_(mode)` → `relaunchInto()` 重启进程 + `--resume` 恢复会话

`gC_()` 热切换实现：

```javascript
function gC_(mode, extraArgs) {
  return relaunchInto({
    freshIfNoTranscript: true,
    extraArgs,
    env: { CLAUDE_CODE_TUI_JUST_SWITCHED: mode },
    dropEnv: ["CLAUDE_CODE_NO_FLICKER", "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN",
              "CLAUDE_CODE_FORCE_FULLSCREEN_UPSELL"]
  })
}
```

### 1.4 渐进推广管线（zy-code 完全缺失）

CC 167 有三层推广漏斗：

**Upsell 对话框**：
- 标题 "Try the new fullscreen renderer?"
- 列出好处：无闪烁输出、鼠标支持、选中自动复制
- 最多展示 3 次（`fullscreenUpsellSeenCount >= 3`）
- 确认后调 `gC_("fullscreen")` 热切换
- 遥测：`tengu_fullscreen_upsell_dialog_shown/accepted/dismissed`

**Downsell 提示条**（已进入全屏的用户看到）：
- 展示滚动/选中/点击操作技巧
- 提示 `/tui default` 可退回
- 展示 5 次后，如果用户没有显式设置 `tui`，自动写入 `{tui: "fullscreen"}` — **静默毕业**
- 遥测：`tengu_fullscreen_downsell_shown/persisted`

**Feature Flag 灰度**（GrowthBook）：
- `tengu_amber_creek` → 控制 downsell 路径
- `tengu_pewter_brook` → 控制 gb 灰度开关
- 服务端逐步推百分比

### 1.5 环境变量差异

| 环境变量 | CC 167 | zy-code |
|----------|--------|---------|
| 主开关 | `CLAUDE_CODE_NO_FLICKER` | `ZY_CODE_NO_FLICKER` |
| 仅退出 alt-screen | `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` | 无 |
| 禁用鼠标 | `CLAUDE_CODE_DISABLE_MOUSE` | `ZY_CODE_DISABLE_MOUSE` |
| 禁用鼠标点击 | `CLAUDE_CODE_DISABLE_MOUSE_CLICKS` | `ZY_CODE_DISABLE_MOUSE_CLICKS` |
| 切换后提示 | `CLAUDE_CODE_TUI_JUST_SWITCHED` | 无 |
| 强制 upsell | `CLAUDE_CODE_FORCE_FULLSCREEN_UPSELL` | 无 |
| 后台会话检测 | `CLAUDE_CODE_SESSION_KIND` | 无 |

### 1.6 tmux 提示差异

zy-code 已有 `maybeGetTmuxMouseHint()` — 提示设置 `mouse on`。

CC 167 新增 `getTmuxFocusHint()` — 检测 tmux `focus-events` 配置，提示用户添加 `set -g focus-events on`，解决 tmux 用户标签页焦点跟踪不生效的问题。

### 1.7 遥测事件对比

| 事件 | CC 167 | zy-code |
|------|:--:|:--:|
| `tengu_fullscreen_upsell_dialog_*` | ✅ | ❌ |
| `tengu_fullscreen_downsell_shown/persisted` | ✅ | ❌ |
| `tengu_tui_command` | ✅ | ❌ |
| `tengu_tui_refuse` | ✅ | ❌ |
| `tengu_tui_optout_reason` | ✅ | ❌ |
| debug 日志 `fullscreen disabled: ...` | ✅ | ✅ |

---

## 二、Ink 渲染引擎差异

### 2.1 已有能力（zy-code 与 CC 167 对齐）

以下核心能力 zy-code 已从 v2.1.88 基线继承或后续同步：

| 能力 | 说明 |
|------|------|
| 双缓冲差分渲染 | prevScreen/currScreen 二维单元格数组，cell-level diff |
| CharPool / StylePool / HyperlinkPool | 字符串驻留，减少 GC 压力 |
| 终端输出优化器 | 合并 cursorMove、抵消 cursor hide/show、去重 hyperlink |
| 同步输出 DEC 2026 | BSU/ESU 序列实现原子帧更新 |
| SGR 鼠标协议 | `\x1b[<button;col;row M/m`，hit-test + 事件冒泡/捕获 |
| 文本选择系统 | anchor+focus、双击选词/三击选行、跨视口滚动累积 |
| ScrollBox 虚拟滚动 | 命令式 API + sticky 模式 + DECSTBM 硬件滚动 |
| CJK IME 光标定位 | useDeclaredCursor hook 声明式光标停靠 |
| Kitty / modifyOtherKeys | 高级键盘事件解析 |
| BiDi 双向文本 | 软件重排序（Windows Terminal / VS Code） |
| React Reconciler 事件优先级 | Discrete/Continuous/Default 优先级调度 |
| 布局偏移检测 | layoutShifted + needsEraseBeforePaint |
| 搜索定位 | searchPositions + scanElementSubtree |
| 选中背景色 | setSelectionBgColor + withSelectionBg |
| OSC 21337 标签页状态 | useTabStatus hook |
| OSC 9;4 进度条 | terminal.ts 终端能力检测 |

### 2.2 缺失能力（CC 167 新增，zy-code 未同步）

#### P0 — 高优先级

**2.2.1 屏幕阅读器 / 无障碍模式**

CC 167 新增字段：`accessibilityMode`, `isScreenReaderEnabled`, `onRenderScreenReader()`

功能：检测终端屏幕阅读器，渲染时生成可朗读的文本描述，包括：
- 工具调用结果的文字化描述
- 代码变更的 diff 朗读格式
- 错误消息的结构化朗读

**改进方案**：
- 在 `src/ink/ink.tsx` Ink 类中添加 `accessibilityMode: boolean` 字段
- 新增 `onRenderScreenReader()` 方法，在每次 commit 后生成无障碍文本
- 通过终端 OSC 查询检测屏幕阅读器（如 `\x1b[?996n` 辅助功能查询）
- 添加 `ZY_CODE_ACCESSIBILITY=1` 环境变量强制开启

**2.2.2 GPU Atlas 主动重置**

CC 167 新增方法：`proactiveAtlasReset()`, `emitAtlasReset()`, `atlasKeys`

功能：检测终端 GPU 纹理图集（Atlas）溢出，主动触发重置防止渲染花屏。
- 长时间会话后终端 GPU 缓存饱和会导致字符显示异常
- 通过追踪样式数量阈值，主动清除并重建渲染状态

**改进方案**：
- 在 `src/ink/screen.ts` StylePool 中添加 `needsCompaction()` / `compact()` 方法（见 2.2.5）
- 在 `src/ink/ink.tsx` 中添加 `proactiveAtlasReset()` 方法
- 每 N 帧检查 StylePool 大小，超过阈值时触发 SGR reset + full repaint

**2.2.3 Alt Screen 交接协议**

CC 167 新增方法：`handoffAltScreen()`, `handoffRawMode()`, `probeExternalClear()`

功能：优雅处理外部进程（vim/less/pager）退出后的终端状态恢复。
- 外部进程可能修改了 alt-screen 状态
- `probeExternalClear()` 检测外部进程是否清屏
- `handoffAltScreen()` / `handoffRawMode()` 重新建立 alt-screen 和 raw mode

**改进方案**：
- 在 `src/ink/ink.tsx` 中添加 `handoffAltScreen()` 方法
- 监听 SIGCONT（Ctrl+Z 后 fg 恢复）和 focus-in 事件时触发
- `probeExternalClear()` 查询终端光标位置，判断是否需要 full repaint

**2.2.4 StylePool 压缩（Compaction）**

CC 167 在 StylePool 新增：`needsCompaction()`, `compact()`, `lastStyleLiveSize`

功能：长会话中 StylePool 持续增长，定期回收未使用的样式条目。
- `needsCompaction()` 检查活跃样式数与池大小的比率
- `compact()` 重建池，只保留当前帧使用的样式
- 解决 v2.1.153 changelog 中提到的 "terminal styling degrading in very long sessions"

**改进方案**：
- 在 `src/ink/screen.ts` StylePool 类中新增：
  ```typescript
  needsCompaction(): boolean {
    return this.liveSize > 0 && this.totalSize > this.liveSize * 2
  }
  compact(liveStyles: Set<number>): void {
    // 重建池，只保留 liveStyles 中的条目
  }
  ```
- 在 Ink 的 commit 循环中每 N 帧调用 `needsCompaction()`，为 true 时调用 `compact()`
- 同步到 `src/ink/ink.tsx` 的 `lastStyleLiveSize` 字段

#### P1 — 中优先级

**2.2.5 鼠标点击展开工具结果（Click-to-Expand）**

CC 167 新增：消息行级 `onClick` / `onMouseEnter` / `onMouseLeave` 事件处理 + `expandedSet` 状态管理

功能：在全屏模式下，用户可用鼠标点击折叠行（如 "Thought for 19s, searched for 2 patterns, read 2 files, ran 1 shell command"）展开对应明细。

**核心实现（逆向提取）**：

1. **gv3 消息行 Wrapper 组件**：每条消息被独立包裹，携带 onClick/hover 事件：
```javascript
function gv3({itemKey, msg, expanded, hovered, clickable, onClickK, onEnterK, onLeaveK, ...}) {
  return <Box
    backgroundColor={hovered ? "userMessageBackgroundHover" : undefined}
    paddingBottom={hovered ? 1 : undefined}
    onClick={clickable ? (e) => {
      if (e.hyperlinkUrl) return e.allowDefault()  // 超链接优先
      onClickK(itemKey, e.cellIsBlank)             // 传递 key + 空白判定
    } : undefined}
    onMouseEnter={clickable ? () => onEnterK(itemKey) : undefined}
    onMouseLeave={clickable ? () => onLeaveK(itemKey) : undefined}
    hoverIgnoresBlankCells={!expanded}  // 未展开时空白区不响应 hover
  >
    {renderItem(msg)}
  </Box>
}
```

2. **isItemClickable 判定逻辑**（决定哪些消息行可点击）：
```javascript
const isItemClickable = useCallback((msg) => {
  // 1. collapsed_read_search 类型始终可点击
  if (msg.type === "collapsed_read_search") return true
  // 2. goal_status 附件（有 reason 时）
  if (msg.type === "attachment") {
    if (verbose || isTranscriptMode) return false
    return msg.attachment?.type === "goal_status" && !!msg.attachment.reason
  }
  // 3. advisor_tool_result
  if (msg.type === "assistant") { /* advisor_tool_result 检查 */ }
  // 4. 工具结果：由工具自身的 isResultTruncated() 决定
  if (msg.type !== "user") return false
  let content = msg.message.content[0]
  if (content?.type !== "tool_result") return false
  if (content.is_error) return hasContent(content.content)
  let toolName = lookupToolUseById(content.tool_use_id)?.name
  return findTool(tools, toolName)?.isResultTruncated?.(msg.toolUseResult, {columns}) ?? false
}, [tools, verbose, isTranscriptMode])
```

3. **expandedSet 状态管理**（点击 toggle 单条消息）：
```javascript
const [expandedSet, setExpandedSet] = useState(() => new Set())

const onItemClick = useCallback((key) => {
  setExpandedSet((prev) => {
    let next = new Set(prev)
    if (next.has(key)) next.delete(key)  // 再次点击折叠
    else next.add(key)                    // 首次点击展开
    return next
  })
}, [])

// VirtualMessageList 中，空白单元格不触发
const handleClick = useCallback((key, isBlank) => {
  if (!isBlank) onItemClick(key)  // cellIsBlank 保护
}, [])
```

4. **渲染联动**：展开状态注入 verbose 参数：
```javascript
// Messages 组件中，展开的消息获得 verbose=true
verbose={verbose || isItemExpanded(msg) || (cursor?.expanded && idx === selectedIdx)}
```

**关键设计要点**：
- **粒度**：每条消息独立 toggle，点击 A 不影响 B 的展开状态
- **cellIsBlank 保护**：点击行内空白区域不触发展开，避免误操作
- **超链接优先**：`e.hyperlinkUrl` 存在时放行默认行为，不展开
- **hover 反馈**：`backgroundColor: "userMessageBackgroundHover"` + paddingBottom
- **hoverIgnoresBlankCells**：未展开时空白区不响应 hover，已展开时全行响应（便于折叠）

**改进方案**：
- 在 `src/components/Messages.tsx` 中新增 `expandedSet` 状态 + `isItemExpanded()` / `onItemClick()` 回调
- 修改消息渲染：展开时传 `verbose=true`
- 在消息行外层组件添加 Ink Box `onClick` / `onMouseEnter` / `onMouseLeave`
- 在 `src/Tool.ts` 的 Tool 接口中确认 `isResultTruncated()` 方法已存在（用于判定可点击性）
- 新增 `collapsed_read_search` 消息类型的可点击支持

**2.2.6 frameSink 外部帧消费**

CC 167 新增字段：`frameSink`

功能：允许外部消费者（如 IDE 扩展）订阅渲染帧，用于：
- 远程会话的帧转发
- 测试/录制回放
- 辅助功能层消费

**改进方案**：
- 在 Ink 类中添加 `frameSink?: (frame: Screen) => void` 回调
- 在 commit 后调用 `frameSink(currScreen)`
- 为 bridge 远程会话提供帧转发接口

**2.2.7 Overlay 签名追踪**

CC 167 新增字段：`prevOverlaySig`

功能：追踪 overlay 层（dialog/popup）的变化签名，避免 overlay 未变时重绘。
- 计算 overlay 子树的 hash 作为签名
- 与 `prevScreen` diff 配合，减少 overlay 层的无效重绘

**改进方案**：
- 在 `src/ink/ink.tsx` 中添加 `prevOverlaySig: string` 字段
- 在 commit 阶段计算 overlay 子树的简单 hash
- 如果签名未变则跳过 overlay 层的 diff 输出

**2.2.8 Full Repaint Sentinel**

CC 167 新增：`fullRepaintSentinelScreen`, `altScreenFullRepaint`

功能：特殊场景下强制全帧重绘的哨兵机制。
- 终端 resize、wake from sleep、外部进程退出等场景
- 设置 sentinel 后下一帧强制 full repaint 而非 diff

**改进方案**：
- 在 `src/ink/ink.tsx` 中添加 `fullRepaintSentinel: boolean`
- 在 SIGWINCH（resize）、SIGCONT（fg 恢复）时设置 sentinel
- commit 时如果 sentinel 为 true，跳过 diff 直接输出全帧

#### P2 — 低优先级

**2.2.9 LIVE_COUNTS 调试**

CC 167 新增：`LIVE_COUNTS`, `liveCountsEnabled`, `LIVE_COUNTS_INTERVAL_MS`

功能：开发模式下定期打印各 Pool（Char/Style/Hyperlink）的活跃 vs 总条目数，用于内存泄漏诊断。

**改进方案**：
- 添加 `ZY_CODE_LIVE_COUNTS=1` 环境变量
- 每 30 秒打印 Pool 统计到 stderr
- 仅 debug 构建启用

**2.2.10 nativeCursor / bgWorkerForceShowCursor**

CC 167 新增字段：`nativeCursor`, `bgWorkerForceShowCursor`

功能：
- `nativeCursor` — 在某些场景保留终端原生光标而非自绘
- `bgWorkerForceShowCursor` — 后台 worker 强制显示光标（辅助功能相关）

**改进方案**：
- 在 Ink 类中添加对应字段
- 主要服务于无障碍模式和后台会话场景

---

## 三、改进方案（按优先级排列）

### Phase 1 — 基础设施（P0，预计 2-3 周）

#### Task 1.1：StylePool 压缩

**目标**：解决长会话渲染退化问题。

**改动文件**：
- `src/ink/screen.ts` — StylePool 新增 `needsCompaction()` / `compact()` / `liveSize`
- `src/ink/ink.tsx` — commit 循环中调用压缩检查

**实现**：
```typescript
// screen.ts - StylePool
private _liveCount = 0

needsCompaction(): boolean {
  return this._liveCount > 0 && this._totalSize > this._liveCount * 3
}

compact(liveIndices: Set<number>): void {
  // 重建池，只保留 liveIndices 中的条目
  // 重新映射所有 Screen 单元格中的样式索引
}

// ink.tsx - commit 循环
if (this.frameCount % 100 === 0 && stylePool.needsCompaction()) {
  const live = this.collectLiveStyleIndices(currScreen)
  stylePool.compact(live)
  this.needsEraseBeforePaint = true
}
```

#### Task 1.2：Alt Screen 交接协议

**目标**：解决 Ctrl+Z/fg、sleep/wake 后的渲染异常。

**改动文件**：
- `src/ink/ink.tsx` — 新增 `handoffAltScreen()` / `probeExternalClear()`

**实现**：
```typescript
handoffAltScreen(): void {
  // 重新进入 alt-screen + raw mode
  // 设置 fullRepaintSentinel
  this.fullRepaintSentinel = true
}

probeExternalClear(): boolean {
  // 查询光标位置，如果不在预期位置则外部进程清过屏
  // 返回 true 表示需要 full repaint
}
```

在 SIGCONT 和 OSC focus-in 事件中调用 `handoffAltScreen()`。

#### Task 1.3：Windows + SSH 自动检测

**目标**：避免 ConPTY 环境下的渲染问题。

**改动文件**：
- `src/utils/fullscreen.ts` — 新增 `isWindowsOverSsh()`

**实现**：
```typescript
export function isWindowsOverSsh(): boolean {
  if (process.platform !== 'win32') return false
  return Boolean(
    process.env.SSH_CONNECTION ||
    process.env.SSH_CLIENT ||
    process.env.SSH_TTY
  )
}
```

在 `isFullscreenEnvEnabled()` 中加入检测：
```typescript
if (isWindowsOverSsh()) {
  logForDebugging('fullscreen disabled: Windows over SSH (ConPTY re-rendering) detected')
  return false
}
```

### Phase 2 — 用户体验（P1，预计 2-3 周）

#### Task 2.1：`/tui` 命令

**目标**：用户可运行时切换渲染器。

**新增文件**：
- `src/commands/tui/index.ts` — 命令处理
- `src/commands/tui/prompt.ts` — 命令描述

**实现要点**：
1. 解析参数 `default` / `fullscreen`
2. 后台任务运行时拒绝切换
3. 写入 settings.json（新增 `tui` 字段）
4. 通过 `relaunchInto()` 重启 + `--resume` 恢复
5. 设置 `ZY_CODE_TUI_JUST_SWITCHED` 环境变量
6. 新进程启动时展示切换提示 banner

**改动文件**：
- `src/utils/fullscreen.ts` — 读取 settings.tui
- `src/commands.ts` — 注册 `/tui` 命令
- `src/state/AppStateStore.ts` — 添加 tui 字段

#### Task 2.2：`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` 等价实现

**目标**：提供只退出 alt-screen 但保留虚拟滚动的选项。

**改动文件**：
- `src/utils/fullscreen.ts` — 新增检测

**实现**：
```typescript
function isAltScreenDisabled(): boolean {
  return isEnvTruthy(process.env.ZY_CODE_DISABLE_ALTERNATE_SCREEN)
}
```

在 `enterAltScreen()` / `exitAltScreen()` 中检查此标志。

#### Task 2.3：鼠标点击展开（Click-to-Expand）

**目标**：用户可点击折叠的工具结果行展开明细，无需键盘操作。

**改动文件**：
- `src/components/Messages.tsx` — 新增 `expandedSet` 状态 + `isItemClickable` / `onItemClick` 回调
- `src/components/Message.tsx` — 消息行 wrapper 添加 onClick/hover props
- `src/Tool.ts` — 确认 `isResultTruncated()` 方法签名

**实现要点**：
1. `expandedSet = new Set<string>()` 管理展开的消息 key（uuid）
2. `isItemClickable(msg)` 判定：
   - `collapsed_read_search` 类型 → true
   - tool_result + `tool.isResultTruncated()` → true
   - 其他 → false
3. 消息行 wrapper 添加 Ink Box props：
   - `onClick` — cellIsBlank 保护 + 超链接优先
   - `onMouseEnter` / `onMouseLeave` — hover 背景色
   - `hoverIgnoresBlankCells={!expanded}`
4. 展开状态注入渲染：`verbose={verbose || isItemExpanded(msg)}`
5. 粒度为单条消息独立 toggle

**依赖**：SGR 鼠标协议（已有）、`isResultTruncated()` 方法（已有）

#### Task 2.4：tmux focus-events 提示

**目标**：解决 tmux 用户焦点跟踪不生效的问题。

**改动文件**：
- `src/utils/fullscreen.ts` — 新增 `maybeGetTmuxFocusHint()`

**实现**：
```typescript
export async function maybeGetTmuxFocusHint(): Promise<string | null> {
  if (!process.env.TMUX) return null
  if (isTmuxControlMode()) return null
  // tmux show -gv focus-events
  const { stdout, code } = await execFileNoThrow(
    'tmux', ['show', '-gv', 'focus-events'], { useCwd: false, timeout: 2000 }
  )
  if (code !== 0 || stdout.trim() === 'on') return null
  return "tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf and reattach"
}
```

### Phase 3 — 推广管线（P2，预计 1-2 周）

#### Task 3.1：Upsell 对话框

**目标**：向非全屏用户推广全屏模式。

**新增文件**：
- `src/components/dialogs/FullscreenUpsellDialog.tsx`

**实现要点**：
- 首次启动时检测是否满足展示条件
- 展示 3 个好处：无闪烁、鼠标支持、选中复制
- 确认后写入 settings.tui = "fullscreen" 并 relaunch
- 遥测 `fullscreen_upsell_shown/accepted/dismissed`

#### Task 3.2：Downsell 提示条 + 自动毕业

**目标**：已进入全屏的用户了解操作方式，5 次后静默固化。

**改动文件**：
- `src/components/` — 新增 DownsellBanner 组件

**实现要点**：
- 全屏模式启动后展示使用技巧
- 每次展示计数 +1，存到 settings
- `count >= 5 && settings.tui === undefined` → 自动写入 `tui: "fullscreen"`
- 遥测 `fullscreen_downsell_shown/persisted`

#### Task 3.3：Feature Flag 灰度

**目标**：通过 feature flag 逐步推广全屏默认启用。

**改动文件**：
- `src/utils/fullscreen.ts` — 在分辨率函数末尾添加 feature flag 检查

**实现**：
```typescript
// 在 isFullscreenEnvEnabled() 末尾
// 替代当前的 return isInternalBuild()
if (isInternalBuild()) return true
return feature('ZY_FULLSCREEN_ROLLOUT')  // 服务端控制百分比
```

### Phase 4 — 高级功能（P2，预计 1-2 周）

#### Task 4.1：屏幕阅读器 / 无障碍模式

**目标**：支持终端屏幕阅读器用户。

**改动文件**：
- `src/ink/ink.tsx` — 新增 `accessibilityMode` / `onRenderScreenReader()`
- `src/ink/terminal.ts` — 屏幕阅读器检测

**实现要点**：
- 检测屏幕阅读器：OSC 辅助功能查询或环境变量
- `ZY_CODE_ACCESSIBILITY=1` 强制开启
- 每次 commit 后生成文本描述写入辅助缓冲区

#### Task 4.2：frameSink 外部帧消费

**目标**：支持远程会话帧转发和测试回放。

**改动文件**：
- `src/ink/ink.tsx` — 新增 `frameSink` 回调

#### Task 4.3：LIVE_COUNTS 调试工具

**目标**：开发模式下诊断 Pool 内存泄漏。

**改动文件**：
- `src/ink/screen.ts` — Pool 添加 `liveCount()` 方法
- `src/ink/ink.tsx` — 定期输出统计

---

## 四、背景会话强制全屏（P1）

CC 167 在后台会话中强制使用全屏渲染器（`bg_forced_on`），因为后台会话需要滚动和鼠标操作。

**改进方案**：

在 `src/utils/fullscreen.ts` 的 `isFullscreenEnvEnabled()` 最前面添加：

```typescript
// 后台会话强制使用全屏渲染器
if (process.env.ZY_CODE_SESSION_KIND === 'bg') {
  return true
}
```

需要确保后台会话入口（`--bg` / `claude --bg-pty-host`）设置了该环境变量。

---

## 五、遥测增强（P2）

### 需要新增的遥测事件

| 事件名 | 触发时机 | 参数 |
|--------|----------|------|
| `fullscreen_upsell_shown` | upsell 对话框展示 | `{seen_count}` |
| `fullscreen_upsell_accepted` | 用户确认 | `{}` |
| `fullscreen_upsell_dismissed` | 用户关闭 | `{}` |
| `fullscreen_downsell_shown` | downsell 提示展示 | `{seen_count}` |
| `fullscreen_downsell_persisted` | 自动毕业 | `{seen_count}` |
| `tui_command` | `/tui` 切换 | `{fullscreen, from, to, session_age_ms}` |
| `tui_refuse` | 后台任务拒绝 | `{active_tasks}` |
| `tui_optout_reason` | 切回反馈 | `{reason, from_entry_path}` |

### 分辨率函数改造后返回 reason 字符串

将 `isFullscreenEnvEnabled()` 改为返回 `FullscreenReason` 类型：

```typescript
type FullscreenReason =
  | 'bg_forced_on'
  | 'env_off'
  | 'env_on'
  | 'tmux_cc_auto_off'
  | 'win_ssh_auto_off'
  | 'settings_on'
  | 'settings_off'
  | 'downsell_on'
  | 'feature_flag_on'
  | 'feature_flag_off'
  | 'internal_default'

function resolveFullscreenMode(): FullscreenReason { ... }
function isFullscreenActive(): boolean {
  const mode = resolveFullscreenMode()
  return getIsInteractive() && modeToRenderer(mode) === 'fullscreen'
}
```

---

## 六、实施优先级总览

| 优先级 | Task | 预估工作量 | 依赖 | 状态 |
|:--:|------|:--:|------|:--:|
| P0 | StylePool 压缩 | 3d | 无 | ✅ 已完成 |
| P0 | Alt Screen 交接协议 | 3d | 无 | ✅ 已有等价（`reenterAltScreen` + `handleResume` + `reassertTerminalModes`） |
| P0 | Windows+SSH 自动检测 | 0.5d | 无 | ✅ 已完成 |
| P1 | `/tui` 命令 + 热切换 | 5d | settings 持久化 | ✅ Step A 已完成（配置持久化 MVP），Step B（relaunch/resume）待后续 |
| P1 | `DISABLE_ALTERNATE_SCREEN` | 1d | 无 | ✅ 已完成 |
| P1 | 鼠标点击展开（Click-to-Expand） | 3d | SGR 鼠标（已有） | ✅ 已有等价（`expandedKeys` + `VirtualItem`） |
| P1 | tmux focus-events 提示 | 1d | 无 | ✅ 已完成 |
| P1 | 背景会话强制全屏 | 1d | 无 | ✅ 已完成 |
| P1 | 分辨率函数 reason 改造 | 2d | 无 | ✅ 已完成 |
| P2 | Upsell 对话框 | 3d | `/tui` 命令 | ✅ 已完成 |
| P2 | Downsell 提示 + 自动毕业 | 2d | `/tui` 命令 | ✅ 已完成 |
| P2 | Feature Flag 灰度 | 1d | resolution 改造 | ✅ 已完成 |
| P2 | 屏幕阅读器模式 | 5d | 无 | ⏳ 延后（需用户研究，当前 `ZY_CODE_ACCESSIBILITY=1` 提供基本支持） |
| P2 | frameSink | 2d | 无 | ✅ 已有等价（`options.onFrame` 回调） |
| P2 | LIVE_COUNTS | 1d | 无 | ✅ 已完成 |
| P2 | 遥测增强 | 2d | resolution 改造 | ✅ 已完成 |

**实施进度**：除屏幕阅读器模式（需用户研究）和 `/tui` relaunch/resume（Step B）外，所有差异项均已实现或确认已有等价能力。

---

## 七、Bash 工具调用折叠渲染机制（逆向确认）

> 新版 CC 167 中 Bash 工具调用不再直接渲染输出，而是折叠到 "Ran N shell commands" 摘要行中，
> 点击后展开明细。以下为逆向提取的完整实现链路。

### 7.1 整体数据流

```
消息流 → wSK() collapseReadSearchGroups → collapsed_read_search 消息
                                              ↓
                                    CollapsedReadSearchContent 组件渲染
                                              ↓
                            点击 → expandedSet toggle → verbose=true → 展开明细
```

### 7.2 Bash 折叠的前提条件

**仅在全屏模式下生效** — `A9()` (即 `isFullscreenEnvEnabled()`) 为 true 时：

```javascript
// uIH() — 判定工具是否可折叠
// Jv = [dq, B9] = ["Bash", "PowerShell"]
const isCollapsible = result.isSearch || result.isRead || isList
return {
  isCollapsible: isCollapsible || (A9() ? Jv.includes(toolName) : false),
  isSearch: result.isSearch,
  isRead: result.isRead,
  isList,
  isBash: A9() ? !isCollapsible && Jv.includes(toolName) : undefined,
  // ...
}
```

**逻辑**：
- 非全屏模式：Bash 工具 `isCollapsible: false`，正常独立渲染（与 zy-code 经典模式一致）
- 全屏模式：非搜索/读取类 Bash 命令标记为 `isCollapsible: true, isBash: true`
- 搜索/读取类 Bash 命令（如 `grep`、`cat`）仍计入 `searchCount`/`readCount`，不计入 `bashCount`

### 7.3 消息分组逻辑（wSK / collapseReadSearchGroups）

连续的可折叠工具调用被合并为一个 `collapsed_read_search` 分组。

`GroupAccumulator` 中的 bash 相关字段：
```typescript
{
  bashCount: number        // 非搜索/读取类 Bash 命令计数
  bashCommands: Map<string, string>  // tool_use_id → command 字符串
  gitOpBashCount: number   // git 操作类 Bash 命令（commit/push/pr）
  commits: []              // 从 Bash stdout 解析的 commit SHA
  pushes: []               // 从 Bash stdout 解析的 push 信息
  branches: []             // merge/rebase 操作
  prs: []                  // PR 创建/合并等
}
```

**分组规则**：
```javascript
if (A9() && toolInfo.isBash) {
  currentGroup.bashCount = (currentGroup.bashCount ?? 0) + toolUseCount
  // 记录 command 字符串用于后续 git 操作解析
  if (input?.command) {
    currentGroup.latestDisplayHint = truncateCommand(input.command)
    for (const id of toolUseIds) {
      currentGroup.bashCommands?.set(id, input.command)
    }
  }
}
```

**Git 操作解析**（从 tool_result 的 stdout 中提取）：
```javascript
// 当 tool_result 到达时，扫描 bash 输出
function extractGitOps(toolResult, group) {
  const output = (toolResult.stdout ?? '') + (toolResult.stderr ?? '')
  const { commit, push, branch, pr } = parseGitOutput(command, output)
  if (commit) group.commits.push(commit)
  if (push) group.pushes.push(push)
  // ...
  if (commit || push || branch || pr) group.gitOpBashCount++
}
```

### 7.4 渲染逻辑（CollapsedReadSearchContent 组件）

生成摘要行时，按以下顺序拼接短语：

```
[Thought for Xs], [edited N files (+A/-R)], [committed abc123], [pushed to main],
[searched for N patterns], [read N files], [listed N directories], [REPL'd N times],
[called MCP N times], [called N tools], [ran N shell commands]
```

**Bash 部分的渲染**：
```javascript
if (A9() && bashCount > 0) {
  const isFirst = nonMemParts.length === 0
  const verb = isActiveGroup
    ? (isFirst ? "Running" : "running")
    : (isFirst ? "Ran" : "ran")
  // 输出: "Ran 3 shell commands" / "running 1 shell command"
  parts.push(<Text key="bash">
    {verb} <Text bold>{bashCount}</Text> shell {bashCount === 1 ? "command" : "commands"}
  </Text>)
}
```

**进行中的实时反馈**：
- 当 Bash 仍在执行时，显示经过时间和已输出行数：
```javascript
// 检测 bash_progress / powershell_progress 进度消息
if (elapsedTimeSeconds >= 2) {
  suffix = totalLines > 0
    ? ` (${formatDuration(elapsed)} · ${totalLines} ${totalLines === 1 ? "line" : "lines"})`
    : ` (${formatDuration(elapsed)})`
}
```

**gitOpBashCount 去重**：
```javascript
// 被归类为 git 操作的 bash 命令不重复计入 "ran N shell commands"
const bashCount = Math.max(0, maxBashCountRef.current - gitOpBashCount)
```

### 7.5 点击展开后的详情渲染

展开后（`verbose=true`）：
```javascript
if (verbose) {
  // 渲染分组内每个工具调用的完整信息
  return <Box flexDirection="column">
    {groupMessages.map((msg) => {
      const content = msg.message.content[0]
      if (content?.type === "thinking") return <ThinkingBlock .../>
      if (content?.type !== "tool_use") return null
      return <ToolUseDetailView key={content.id} content={content} tools={tools} ... />
    })}
    {/* PreToolUse hooks 信息 */}
    {message.hookInfos && ...}
    {/* Recalled memories */}
    {message.relevantMemories?.map(...)}
  </Box>
}
```

### 7.6 与 zy-code 的对比

| 方面 | CC 167 | zy-code 当前 |
|------|--------|-------------|
| Bash 折叠逻辑 | ✅ 全屏时折叠 | ✅ 已同步 |
| `bashCount` 字段 | ✅ | ✅ 已有 |
| `gitOpBashCount` 去重 | ✅ | ✅ 已有 |
| `bashCommands` Map | ✅ | ✅ 已有 |
| Git 操作解析（commit/push/pr） | ✅ | ✅ 已有 |
| "Ran N shell commands" 渲染 | ✅ | ✅ 已有（i18n key） |
| 进行中时间/行数显示 | ✅ | ✅ 已有 |
| 点击展开明细 | ✅ `expandedSet` | ✅ 已有（依赖 2.2.5 Click-to-Expand） |
| 经典模式独立渲染 | ✅ 非全屏时不折叠 | ✅ 一致 |

**结论**：zy-code 已从 v2.1.88 基线后的某次同步中完整实现了 Bash 折叠功能。核心逻辑与 CC 167 对齐，无需额外实现。唯一需确保的是 Click-to-Expand（2.2.5）功能完整实现后，用户才能通过鼠标点击展开 Bash 命令的详情。
