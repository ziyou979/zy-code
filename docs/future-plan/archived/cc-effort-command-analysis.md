# Claude Code `/effort` 命令完全分析

> 基于 CC 2.1.204 (build 2026-07-07, commit 51bd0ba) win32-x64 二进制提取

---

## 1. 命令注册

### 注册入口（`S_p` 模块）

`/effort` 同时注册了两个命令变体：

| 变体 | type | requires | 用途 |
|------|------|----------|------|
| `Ww_` | `local-jsx` | `{ ink: !0 }` | **交互式 TUI 选择器**（带可视滑块） |
| `b_p` | `local` | `supportsNonInteractive: !0` | **非交互式**（纯文本参数） |

```js
// 交互版
{ type: "local-jsx", name: "effort", description: "Set effort level for model usage",
  requires: { ink: !0 }, thinClientDispatch: "control-request",
  get immediate() { return our() },  // TTY 下立即执行
  load: () => Promise.resolve().then(() => (ira(), h_p)) }

// 非交互版（等参数版）
{ type: "local", name: "effort", supportsNonInteractive: !0, description: "Set effort level for model usage",
  get argumentHint() { return __p("<", ">") },
  load: () => Promise.resolve().then(() => (y_p(), g_p)) }
```

### argumentHint 动态生成

```js
function __p(e, t) {
  let r = Bi(), n = DQ(r) ? "|ultracode" : "";
  return `${e}${Uke(r).join("|")}${n}|auto${t}`
}
// 输出示例: [low|medium|high|xhigh|max|ultracode|auto]
```

### 非交互调用入口（`jw_`）

```js
async function jw_(e, t) {
  let r = e.trim(), n = t.getAppState(),
      o = ii(n.mainLoopModelForSession ?? n.mainLoopModel ?? dD());
  if (jJ.includes(r)) return { type: "text", value: OIo() };  // "auto" / "unset"
  if (r === "current" || r === "status") {
    let { message: s } = Krn(i_(t), o, n.ultracode);
    return { type: "text", value: s }
  }
  if (!r) return { type: "text", value: `Usage: /effort <${Uke(o).join("|")}${DQ(o)?"|ultracode":""}|auto>` };
  return { type: "text", value: (await NIo(r, t.setAppState)).message }
}
```

---

## 2. 档位定义

### 核心档位（`Jta`）

```js
Jta = [
  { value: "low",    label: "low",    color: "warning" },
  { value: "medium", label: "medium", color: "success" },
  { value: "high",   label: "high",   color: "permission" },
  { value: "xhigh",  label: "xhigh",  color: "autoAccept-shimmer" },
  { value: "max",    label: "max",    color: "rainbow-animated" },
]
```

### 额外虚拟档位：`ultracode`

ultracode **不是独立档位值**，它映射为 `xhigh + dynamic workflow orchestration`：

```js
// 在 f_p 中动态添加（当模型支持时）
if (DQ(e)) {
  levels.push({ value: "ultracode", label: "ultracode", color: "violet-ripple" })
  sublabel = { text: "xhigh + workflows", start: a }
}
```

### 档位间距与三角标位置

```js
// 各档位之间的间隔 (spacers)
Aw_ = [5, 5, 5, 6]   // low→medium, medium→high, high→xhigh, xhigh→max（max→ultra 额外 +4）
// 三角形 ▼ 所在的列位置
vw_ = [1, 10, 20, 30, 40]   // 对应 low, medium, high, xhigh, max
```

### 档位描述（`gw_`）

```js
gw_ = {
  low:    "Quick, straightforward implementation",
  medium: "Balanced approach with standard testing",
  high:   "Comprehensive implementation with extensive testing",
  xhigh:  `Extended reasoning with thorough analysis (${ZPn})`,
  max:    `Maximum capability with deepest reasoning (${x8l})`,
}
```

其中 `${ZPn}` 是支持的模型列表文案，`${x8l}` 是能力说明。

---

## 3. 交互式 UI 选择器（核心组件 `Ow_`）

### 整体布局

```
┌──────────────────────────────────────────────┐
│                    Effort                     │  ← 标题行
│                                               │
│               Faster    Smarter               │  ← 两端标签
│  ────────────────▲─────────────────┆────────  │  ← 轨道条 + ▲ 指示器
│  low    medium   high   xhigh   max  ultracode│  ← 档位标签
│           xhigh + workflows                   │  ← 副标签（ultracode 时显示）
│                                               │
│  ←/→ to adjust · Enter to confirm · Esc cancel│  ← 键盘提示
└──────────────────────────────────────────────┘
```

### UI 组件结构

```
<Yl>  ← 外层容器 (Box)
  <H flexDirection="column" tabIndex={0} autoFocus onKeyDown={R}>
    <gg>  ← 标题
      "Effort"
    <H height={1}>  ← 空行分隔
    <H flexDirection="column" alignItems="center" width="100%">
      <H> "Faster" <triangle> "Smarter" </H>   ← Faster/Smarter 标签行
      <H>                                          ← 轨道条行
        [track chars left of ▲]                    ← ── 左半轨道
        ▲                                          ← 三角形指示器（\u25B2）
        [track chars right of ▲]                   ← ── 右半轨道 (+ extra for ultra)
      </H>
      <H>                                          ← 标签行
        {levels.map(label)}                        ← low, medium, high, xhigh, max, ultracode
      </H>
      {sublabel && "xhigh + workflows"}            ← 副标签（仅 ultracode）
      {levels[d].value==="max" && capNote}          ← 能力上限提示
    </H>
    <H height={1}>                                  ← 空行
    <wy> keyboard hints </wy>                       ← 键盘操作提示
  </H>
</Yl>
```

### 轨道条视觉计算

```js
// 轨道字符
trackChars = "\u2500".repeat(width)   // 非 ultra: ─ 重复
trackChars = "\u2500".repeat(width+1) + "\u2506" + "\u2500".repeat(18)  // ultra: ──┆──

// ▲ 位置由 trianglePositions[d] 决定
// 分割左右轨道
k = trianglePositions[d]                         // ▲ 所在的列
P = trackChars.slice(0, k)                       // ▲ 左边的轨道字符
L = trackChars.slice(k + 1)                      // ▲ 右边的轨道字符

// accentStart 高亮分割（非 ultra 时 = trackChars.length，全部高亮）
O = accentStart ?? trackChars.length
B = P.slice(0, Math.min(P.length, O))             // 高亮部分的左轨道
F = L.slice(0, Math.max(0, O - k - 1))            // 高亮部分的右轨道
```

### 键盘事件处理

```tsx
function R(re) {
  if (re.key === "left")
    u(ae => Math.max(0, ae - 1));           // 左移选择
  else if (re.key === "right")
    u(ae => Math.min(a.levels.length - 1, ae + 1));  // 右移选择
  else if (re.key === "return") {
    // 确认选择 → 检查组织限制 → LIo(ae.value, s, t)
    let ae = a.levels[d], oe = ae.value === "ultracode" ? "xhigh" : ae.value;
    if (Sjt(oe, r, i, n, e)) { f(ae.value); return }  // 需二次确认
    LIo(ae.value, s, t)                                 // 直接应用
  }
  else if (re.key === "escape")
    t("Cancelled")                             // 取消
}
```

### 颜色方案

```js
Zta = "#d0b4ff"       // 紫色 shimmer
Yrn = "rgb(255,255,255)"  // 白色高亮文字
MIo = xdr.at(-1)          // 最深色（用于 ▲ 背景）

// 彩虹渐变（8 阶）
l_p = [62, 22, 118]       // R,G,B 起始色
Mw_ = [140, 80, 240]      // R,G,B 终止色
xdr = Array.from({length:8}, (e,t) => {
  let r = t/7;
  return `rgb(${Math.round(62+(140-62)*r)},${Math.round(22+(80-22)*r)},${Math.round(118+(240-118)*r)})`
})
// → 从深紫渐变到亮紫
```

---

## 4. 核心逻辑函数

### `f_p(e)` — 计算 effort picker 结构

根据模型 `e` 的能力裁剪可用档位：

```js
function f_p(e) {
  let t = e ? bjt(e) : null,           // 获取模型 effort 上限索引
      r = ww_(t ? AI.indexOf(t) + 1 : AI.length),  // 裁剪 levels/spacers/trianglePositions
      n = e && k8l(e) ? Hw_ : void 0;  // 组织限制提示

  if (DQ(e)) {  // 支持 ultracode
    // 添加 ultracode 档位，扩展轨道和间距
    return { levels: c, width: a+17, trianglePositions: [...r.trianglePositions, a+8.5],
             labelStarts: Qta(c,d), spacers: d,
             trackChars: "─".repeat(r.width+1) + "┆" + "─".repeat(18),
             accentStart: r.width+2, sublabel: {...}, capNote: n }
  }
  return { levels: r.levels, width: r.width, trianglePositions: r.trianglePositions,
           labelStarts: ..., spacers: r.spacers, trackChars: "─".repeat(r.width), capNote: n }
}
```

### `ww_(e)` — 裁剪档位

```js
function ww_(e) {
  let t = Math.min(Math.max(e, 1), Jta.length);  // 1~5
  let r = Jta.slice(0, t);     // 取前 t 个档位
  let n = Aw_.slice(0, t-1);   // 取对应的间距
  let o = vw_.slice(0, t);     // 取对应的三角标位置
  if (t === Jta.length) return { levels: r, width: 42, trianglePositions: o, spacers: n };
  let i = Qta(r, n);           // 计算标签起始位置
  return { levels: r, width: Math.max(i[t-1]+r[t-1].label.length, 14), ... }
}
```

### `yw_(e, t)` — 非交互设置 effort

```ts
async function yw_(e, t) {
  let r = Bi()  // 当前模型
  let n = typeof e === "string" ? XSe(e, r) : e  // 检查组织限制
  let o = n !== e  // 是否被降级
  let i = f2e(n)   // 是否持久化（非交互可保存）
  // 远程检查...
  t?.({value: n, ultracode: false})     // 乐观更新 state
  // 保存到 settings...
  // 返回消息:
  return { message: `Set effort level to ${lpe(n)}${u}: ${c}${s ?? ""}`,
           effortUpdate: {value: n, ultracode: false} }
}
```

### `bw_()` — 设置 ultracode

```ts
async function bw_(e) {
  // 前置检查：
  // 1. 需要 dynamic workflows enabled
  // 2. 模型需支持 xhigh
  // 3. 组织未限制 xhigh
  e?.({value: "xhigh", ultracode: true})  // 实际设为 xhigh + ultracode flag
  d3()  // 启用 dynamic workflow
  return { message: "Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration",
           effortUpdate: {value:"xhigh", ultracode:true} }
}
```

### `Krn(i, o, r)` — 查询当前 effort 状态

```ts
function Krn(e, t, r) {
  if (Xoe(t, e, r)) return { message: "Current effort level: ultracode (xhigh + dynamic workflow orchestration; this session only)" }
  let n = Ul() ? void 0 : kyt()   // 用户设置的 effort
  let o = z7e(t) ? void 0 : e     // 环境变量 / 设置
  let i = n === null ? void 0 : n ?? o
  if (i === void 0) {
    let a = p3(t, e)   // 计算默认值
    return { message: `Effort level: auto (currently ${lpe(a)})` }
  }
  return { message: `Current effort level: ${lpe(i)} (${Imi(i)})` }
}
```

### `u_p(e, t)` — 命令调度主入口

```ts
async function u_p(e, t) {
  let r = e.toLowerCase()
  if (r === "auto" || r === "unset") return _w_(t)        // 重置为 auto
  if (r === "ultracode") return bw_(t)                     // 设置 ultracode
  let n = xyt(e)                                            // 解析为有效档位
  if (!n) return { message: `Invalid argument: ${e}. Valid options are: ${PIo(Bi())}` }
  return yw_(n, t)                                          // 设置档位
}
```

### 遥测事件

```js
N("tengu_effort_command", { effort: level_name, is_remote: boolean })
```

---

## 5. 模型能力映射

### 模型 effort 能力属性

各模型定义中包含以下 effort 相关属性：

| 属性 | 含义 |
|------|------|
| `supportsEffort` | 是否支持 effort 调节 |
| `supportedEffortLevels` | 支持的档位列表 |
| `supportsAdaptiveThinking` | 是否支持自适应思考 |
| `supportsFastMode` | 是否支持快速模式 |
| `supportsAutoMode` | 是否支持自动模式 |

### 模型 effort 能力对比

| 模型 | effort | max_effort | xhigh_effort | adaptive_thinking | context_management | fast_mode |
|------|--------|------------|--------------|-------------------|-------------------|-----------|
| Sonnet 5 | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ |
| Opus 4.0 | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Opus 4.1 | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Opus 4.5 | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Opus 4.6 | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ |
| Opus 4.7 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Opus 4.8 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (lean_prompt) |
| Fable 5 | (同级别) | (同级别) | (同级别) | (同级别) | (同级别) | ❌ |

注：
- Opus 4.0/4.1/4.5 仅支持 `context_management`，不参与 effort 调节
- Opus 4.6 开始引入 `effort` + `adaptive_thinking`
- Opus 4.7/4.8 完整支持所有能力，包括 `fast_mode` 和 `lean_prompt`
- Sonnet 5 支持 effort 但**不支持 xhigh**

### 组织限制

```js
Hw_ = "Higher effort levels are restricted by your organization."
```

通过 `k8l(e)` 检查组织是否对模型 `e` 设限；`ape(t)` 检查组织是否限制 xhigh。

---

## 6. 设置项

### 设置 schema 中 effort 相关键

| 设置键 | 类型 | 描述 |
|--------|------|------|
| `effortLevel` | `"low"\|"medium"\|"high"\|"xhigh"` | 持久化的 effort 级别 |
| `ultracode` | `boolean` | 启用 ultracode（xhigh + 动态工作流） |

注释原文：
- `Persisted effort level for supported models.`
- `Enable ultracode for the session: xhigh effort plus standing dynamic-workflow orchestration.`
- `Session-scoped — typically provided via --settings or the apply_flag_settings control request; interactive toggles never persist it. Requires workflows to be enabled and an xhigh-capable model.`

### 环境变量

```
CLAUDE_CODE_EFFORT_LEVEL=<level>
```

优先级高于交互设置，当设置后提示：
```
CLAUDE_CODE_EFFORT_LEVEL=<value> overrides this session — clear it and <level> takes over
```

### CLI flag

```
--effort <level>
Effort level for the current session (low, medium, high, xhigh, max)
```

---

## 7. 状态管理

effort 状态通过 AppState 的以下字段管理：

```ts
interface AppState {
  effortValue?: "low" | "medium" | "high" | "xhigh" | undefined  // 当前 effort
  ultracode?: boolean     // 是否启用 ultracode
}
```

设置流程（`NIo`）：

```
NIo(e, t)
  → u_p(e, t)           // 解析参数、检查限制
    → t({value:n, ultracode:false/true})  // 乐观更新 state
    → 保存到 settings / 发送 control request
  → 回滚（如失败）
```

---

## 8. 错误消息清单

| 条件 | 消息 |
|------|------|
| 远程传输 + 不可持久化 | `{value} is session-scoped and won't reach the remote process. Use low, medium, high, or xhigh instead.` |
| Effort 超组织限 | `Effort '{e}' exceeds your organization's limit for {model}; set to '{n}' instead...` |
| env var 覆盖 | `CLAUDE_CODE_EFFORT_LEVEL={v} overrides this session — clear it and {level} takes over` |
| 模型不支持 xhigh | `{model} doesn't support xhigh...` |
| ultracode 需 workflow | `Ultracode needs dynamic workflows enabled (see /config).` |
| 组织限制 xhigh | `Ultracode runs at xhigh effort, which is restricted by your organization for {model}.` |
| 无效参数 | `Invalid argument: {e}. Valid options are: {list}` |
| 取消 | `Cancelled` |

---

## 9. 完整交互流程

```
用户输入 /effort
  ↓
getPromptForCommand → 选择交互版 (Ow_) 或参数版 (p_p)
  ↓  [无参数]
Ow_ 渲染 TuI 选择器：
  ┌─ Effort ──────────────────────────┐
  │       Faster         Smarter      │
  │  ─────────▲──────────────────     │
  │  low medium high xhigh max        │
  │  ←/→ · Enter · Esc               │
  └───────────────────────────────────┘
  ↓  方向键选择 → ←
  ↓  Enter → LIo(level) → NIo → u_p → yw_/bw_
  ↓  Esc → "Cancelled"
  ↓  [有参数]
  p_p → 参数解析 →
    auto/unset → 重置
    ultracode → 检查 + bw_
    low/medium/high/xhigh/max → 检查限制 + yw_
  ↓
  返回消息给用户 + 更新 AppState
```

---

## 10. 关键代码偏移速查

| 内容 | 偏移 (十进制) |
|------|-------------|
| Effort 档位定义 (low~max) | 93,420,128 |
| Effort 设置项 (effortLevel, ultracode) | 93,420,176 |
| CLI --effort flag 定义 | 156,151,450 |
| Effort 标题 + Faster/Smarter + 轨道行 | 137,228,504 |
| Effort 命令处理函数 (yw_, bw_, Krn, NIo) | 236,308,000 |
| Effort picker 组件 (Ow_ 完整渲染) | 236,315,000 |
| 模型 effort 能力 (Sonnet 5) | 159,660,188 |
| 模型 effort 能力 (Opus 4.6/4.7/4.8) | 159,660,748 |
| supportedEffortLevels 引用 | 95,576,400 |
| 非交互命令处理 (jw_) | 236,322,000 |
| 遥测事件 tengu_effort_command | 137,156,912 |
