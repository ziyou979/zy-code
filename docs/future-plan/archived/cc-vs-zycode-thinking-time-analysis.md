# CC "Thought for 15s" vs zy-code "思考了 25 秒" — 思考时间深度对比

> 通过逆向 Claude Code 二进制（`claude.exe`，212MB esbuild bundle）提取渲染和计时逻辑，与 zy-code 源码逐维度对比。

## 一、计时来源（核心差异）

### CC — API 消息时间戳差值

从 CC 二进制 `JCK` 折叠函数（offset `209043500`）提取：

```js
// T 追踪上一条消息的 timestamp，$ 是当前消息
if (T !== void 0) {
  let w = Date.parse($.timestamp) - Date.parse(T);
  if (Number.isFinite(w) && w > 0)
    K.thoughtForMs += Math.min(w, de8);  // de8 = 600000 (10分钟)
}
// 循环末尾更新 T
if ("timestamp" in $ && typeof $.timestamp === "string")
  T = $.timestamp;
```

CC 用消息对象自带的 `timestamp` 字段（API 侧时间）计算相邻消息间的时间差。

### zy-code — 客户端挂钟差值

来自 `src/state/ReplStore.ts` L236-243：

```ts
setStreamMode(mode) {
  const prev = store.getState().streamMode
  if (mode === 'thinking' && prev !== 'thinking') {
    mutable.thinkingStartMs = Date.now()       // 客户端打点
  } else if (mode !== 'thinking' && prev === 'thinking' && mutable.thinkingStartMs > 0) {
    mutable.lastThinkingDurationMs = Date.now() - mutable.thinkingStartMs  // 客户端差值
  }
}
```

触发时机来自 `src/utils/messages/streaming.ts`：收到 `thinking`/`redacted_thinking` chunk 时切换为 `'thinking'`，收到 `text` chunk 时切换为 `'responding'`。

```ts
case 'thinking':
case 'redacted_thinking':
  onSetStreamMode('thinking')
  return
case 'text':
  onSetStreamMode('responding')
  return
```

> **结论**：zy-code 的计时 = API 思考时间 + 网络 RTT + 流式解析延迟 + 客户端事件循环开销。这就是 **15s vs 25s** 差异的主要原因。

---

## 二、多 thinking 块处理

| | CC | zy-code |
|---|---|---|
| **策略** | **累加** `+=` | **覆盖** `=` |

### CC

```js
K.thoughtForMs += Math.min(w, de8);  // 每个 thinking 块累加
```

### zy-code

来自 `src/utils/collapseReadSearch.ts` L753-754：

```ts
if (msg.type === 'assistant' && msg.thinkingDurationMs) {
  pendingThinkingDurationMs = msg.thinkingDurationMs  // 覆盖，只保留最后一条
}
```

当一个折叠组内有多次 `thinking → tool_use → thinking → tool_use` 交替时：

- CC 会把所有 thinking 段的时长**全部累加**
- zy-code 只保留**最后一个** thinking 段的时长

折叠组 flush 时赋值（`collapseReadSearch.ts` L738-742）：

```ts
const group = createCollapsedGroup(currentGroup)
if (pendingThinkingDurationMs !== undefined) {
  group.thinkingDurationMs = pendingThinkingDurationMs
  pendingThinkingDurationMs = undefined
}
```

---

## 三、上限与下限

| | CC | zy-code |
|---|---|---|
| **单次上限** | `de8 = 600000`（10 分钟） | 无 |
| **渲染下限** | `Math.max(1000, n)` → 至少 "1s" | 无下限，`0ms` 不渲染 |

### CC 常量定义

从二进制 offset `209054475` 提取：

```js
var gS_, OCK = 300, de8 = 600000, TCK;
```

### CC 渲染时下限

从二进制 offset `208436537` 附近提取：

```js
jH = createElement(V, {bold: true}, k7(Math.max(1000, n)));  // 最低 1000ms
TH.push(createElement(V, {key: "thought"}, fH, " for ", jH));
```

### zy-code 渲染时无下限

来自 `src/components/messages/CollapsedReadSearchContent.tsx` L331：

```ts
if (message.thinkingDurationMs) { ... }  // falsy 值直接不渲染
```

---

## 四、格式化函数

### CC `k7`

从二进制 offset `198997406` 完整提取：

```js
function k7(H, _) {
  if (H < 60000) {
    if (H === 0) return "0s"
    if (H < 1) return `${(H/1000).toFixed(1)}s`
    return `${Math.floor(H/1000).toString()}s`
  }
  let q = Math.floor(H / 86400000)           // 天
  let K = Math.floor((H % 86400000) / 3600000)  // 时
  let O = Math.floor((H % 3600000) / 60000)     // 分
  let T = Math.round((H % 60000) / 1000)        // 秒
  // 处理四舍五入进位
  if (T === 60) T = 0, O++
  if (O === 60) O = 0, K++
  if (K === 24) K = 0, q++
  let z = _?.hideTrailingZeros
  if (_?.mostSignificantOnly) {
    if (q > 0) return `${q}d`
    if (K > 0) return `${K}h`
    if (O > 0) return `${O}m`
    return `${T}s`
  }
  if (q > 0) {
    if (z && K === 0 && O === 0) return `${q}d`
    if (z && O === 0) return `${q}d ${K}h`
    return `${q}d ${K}h ${O}m`
  }
  if (K > 0) {
    if (z && O === 0 && T === 0) return `${K}h`
    if (z && T === 0) return `${K}h ${O}m`
    return `${K}h ${O}m ${T}s`
  }
  if (O > 0) {
    if (z && T === 0) return `${O}m`
    return `${O}m ${T}s`
  }
  return `${T}s`
}
```

### zy-code `formatDuration`

来自 `src/utils/format.ts` L39-116：

```ts
export function formatDuration(
  ms: number,
  options?: { hideTrailingZeros?: boolean; mostSignificantOnly?: boolean },
): string {
  if (ms < 60000) {
    if (ms === 0) return '0s'
    if (ms < 1) {
      const s = (ms / 1000).toFixed(1)
      return `${s}s`
    }
    const s = Math.floor(ms / 1000).toString()
    return `${s}s`
  }
  let days = Math.floor(ms / 86400000)
  let hours = Math.floor((ms % 86400000) / 3600000)
  let minutes = Math.floor((ms % 3600000) / 60000)
  let seconds = Math.round((ms % 60000) / 1000)
  if (seconds === 60) { seconds = 0; minutes++ }
  if (minutes === 60) { minutes = 0; hours++ }
  if (hours === 24) { hours = 0; days++ }
  const hide = options?.hideTrailingZeros
  if (options?.mostSignificantOnly) {
    if (days > 0) return `${days}d`
    if (hours > 0) return `${hours}h`
    if (minutes > 0) return `${minutes}m`
    return `${seconds}s`
  }
  if (days > 0) {
    if (hide && hours === 0 && minutes === 0) return `${days}d`
    if (hide && minutes === 0) return `${days}d ${hours}h`
    return `${days}d ${hours}h ${minutes}m`
  }
  if (hours > 0) {
    if (hide && minutes === 0 && seconds === 0) return `${hours}h`
    if (hide && seconds === 0) return `${hours}h ${minutes}m`
    return `${hours}h ${minutes}m ${seconds}s`
  }
  if (minutes > 0) {
    if (hide && seconds === 0) return `${minutes}m`
    return `${minutes}m ${seconds}s`
  }
  return `${seconds}s`
}
```

> **注意**：`formatDuration` 与 CC 的 `k7` 逻辑完全一致（zy-code 就是从这里对齐的）。

### zy-code `formatDurationZh`

来自 `src/utils/format.ts` L122-196：

```ts
export function formatDurationZh(
  ms: number,
  options?: { hideTrailingZeros?: boolean; mostSignificantOnly?: boolean },
): string {
  if (ms < 60000) {
    if (ms === 0) return '0 秒'
    if (ms < 1) {
      const s = (ms / 1000).toFixed(1)
      return `${s} 秒`
    }
    const s = Math.floor(ms / 1000).toString()
    return `${s} 秒`    // 例如 "25 秒"
  }
  // ≥60s: 天→"天", 时→"小时", 分→"分/分钟", 秒→"秒"
  // 例如 "1 分 25 秒"、"1 小时 23 分 45 秒"
  // ...结构与 formatDuration 一致，只替换单位
}
```

通过 `getLocalizedDurationFormatter()` 根据 UI 语言自动选择：

```ts
export function getLocalizedDurationFormatter(): typeof formatDuration {
  switch (getUiLanguage()) {
    case 'zh-CN': return formatDurationZh
    default: return formatDuration
  }
}
```

CC 没有中文格式化。

---

## 五、国际化

| | CC | zy-code |
|---|---|---|
| **文本生成** | 硬编码拼接 `"Thought"/"Thinking" + " for " + k7(ms)` | i18n key `summary.thinking.done.{position}` |
| **英文** | `"Thought for 15s"` | `"Thought for 15s"` |
| **中文** | 不支持 | `"思考了 25 秒"` |
| **首词大写** | 运行时判断 `z ? "Thinking" : "Thought"` | i18n key 区分 `first`/`sub` |

### CC 硬编码拼接

```js
let fH = z ? "Thinking" : "Thought"   // isActiveGroup → 进行时
TH.push(createElement(V, {key: "thought"}, fH, " for ", jH))
```

### zy-code i18n

来自 `src/components/messages/CollapsedReadSearchContent.tsx` L331-342：

```ts
if (message.thinkingDurationMs) {
  const isFirst = nonMemParts.length === 0
  const position = isFirst ? 'first' : 'sub'
  const formatDuration = getLocalizedDurationFormatter()
  nonMemParts.push(
    <Text key="thinking">
      {tSync(`summary.thinking.done.${position}`, {
        duration: formatDuration(message.thinkingDurationMs),
      })}
    </Text>,
  )
}
```

i18n 配置文件：

```ts
// src/i18n/locales/en/summary.ts
'summary.thinking.done.first': 'Thought for {duration}',
'summary.thinking.done.sub':   'thought for {duration}',

// src/i18n/locales/zh-CN/summary.ts
'summary.thinking.done.first': '思考了 {duration}',
'summary.thinking.done.sub':   '思考了 {duration}',
```

---

## 六、流式实时计时

| | CC | zy-code |
|---|---|---|
| **全屏+流式** | `C13` 实时计时器组件，基于 `baseMs` + `lastThinkingAtMs` tick 更新 | 无实时更新，折叠后显示最终值 |
| **Spinner** | `thinkingBurstStart` 状态机 + `wYK()` 计算 `thinkingMs = now - burstStart` | Spinner 有 `thinking` 状态文字但无秒数 |

### CC 全屏模式实时计时

从二进制 offset `208436537` 附近提取：

```js
if (s) {
  let fH = z ? "Thinking" : "Thought";
  let jH;
  if (z && R9()) {  // isActiveGroup && isFullscreen
    // 找到最后一条 thinking 消息的 timestamp
    let ZH = 0;
    for (let XH = D.length - 1; XH >= 0; XH--) {
      let wH = D[XH];
      if (wH?.type === "assistant" && wH.message.content[0]?.type === "thinking") {
        let DH = Date.parse(wH.timestamp);
        if (Number.isFinite(DH)) ZH = DH;
        break;
      }
    }
    jH = createElement(C13, {baseMs: n, lastThinkingAtMs: ZH});  // 实时 tick 组件
  } else {
    jH = createElement(V, {bold: true}, k7(Math.max(1000, n)));  // 静态值
  }
  TH.push(createElement(V, {key: "thought"}, fH, " for ", jH));
}
```

`C13` 组件在渲染期间持续 tick，计算 `baseMs + (Date.now() - lastThinkingAtMs)` 实现实时递增效果。流式结束后切换为静态 `k7(Math.max(1000, n))`。

### CC Spinner 状态机

从二进制 offset `207333200` 提取：

```js
// 初始化
function AYK() {
  return { toolWindowStart: null, toolWindowEnd: null, thinkingBurstStart: null, wasThinking: false }
}

// 状态更新（每 tick 调用）
function YYK(H, _) {
  let { toolWindowStart: q, toolWindowEnd: K, thinkingBurstStart: O } = H;
  if (_.hasActiveTools) {
    if (q === null || K !== null) q = _.now;
    K = null;
  } else if (q !== null && K === null) {
    K = _.now;
  }
  if (!_.hasActiveTools && _.thinkingStatus !== null) q = null, K = null;
  if (_.isThinking) {
    if (!H.wasThinking) O = _.now;  // 开始新的 thinking burst
  } else {
    O = null;  // 结束 burst
  }
  return { toolWindowStart: q, toolWindowEnd: K, thinkingBurstStart: O, wasThinking: _.isThinking };
}

// 计算显示类型
function wYK(H, _) {
  if (_.showToolCallTimer && _.hasActiveTools && H.toolWindowStart !== null) {
    let q = _.now - H.toolWindowStart;
    if (q >= 2000) return { kind: "tool-running", toolMs: q };
  }
  if (_.showToolCallTimer && !_.hasActiveTools && _.thinkingStatus === null
      && H.toolWindowStart !== null && H.toolWindowEnd !== null) {
    let q = H.toolWindowEnd - H.toolWindowStart;
    if (q >= 2000) return { kind: "tool-done", toolMs: q };
  }
  if (_.thinkingStatus === "thinking" && !_.hasActiveTools)
    return { kind: "thinking", thinkingMs: H.thinkingBurstStart !== null ? _.now - H.thinkingBurstStart : 0 };
  if (typeof _.thinkingStatus === "number")
    return { kind: "thought-for", thoughtMs: _.thinkingStatus };
  return { kind: "none" };
}
```

---

## 七、额外字段 `latestThinkingSummary`

CC 有 `latestThinkingSummary` 字段——保存 thinking 块的文本摘要：

```js
K.latestThinkingSummary = Y.text.trim().replace(/\s+/g, " ");
```

渲染条件为：

```js
let s = n > 0 || H.latestThinkingSummary !== void 0;
```

即**即使 thoughtForMs=0，只要有摘要也会渲染思考行**。zy-code 没有这个字段。

### CC 折叠组创建时传递此字段

从二进制 offset `209043500`（`EY3` 函数）提取：

```js
if (H.thoughtForMs > 0) w.thoughtForMs = H.thoughtForMs;
if (H.latestThinkingSummary !== void 0) w.latestThinkingSummary = H.latestThinkingSummary;
```

---

## 八、CC 折叠渲染组件完整结构

从二进制 offset `208432400` 提取的 `tRK` 函数（对应 zy-code 的 `CollapsedReadSearchContent`）：

```js
function tRK({message: H, inProgressToolUseIDs: _, shouldAnimate: q,
              verbose: K, tools: O, lookups: T, isActiveGroup: z}) {
  // 解构计数
  let { searchCount: $, readCount: A, listCount: Y, replCount: w,
        memorySearchCount: j, memoryReadCount: f, memoryWriteCount: J, messages: D } = H;

  // ... 各计数最大值追踪（useRef + Math.max）...

  // 思考时长
  let n = H.thoughtForMs ?? 0;
  let s = n > 0 || H.latestThinkingSummary !== void 0;

  // 是否有任何可显示内容
  let o = F > 0 || x > 0 || U > 0 || w > 0 || Q > 0 || d > 0 || l > 0
          || C > 0 || S > 0 || I > 0 || s;

  // 渲染 "Thought for Xs" / "Thinking for Xs"
  if (s) {
    let fH = z ? "Thinking" : "Thought";
    let jH;
    if (z && R9()) {
      // 全屏 + 流式 → 实时 tick 组件
      let ZH = 0;
      for (let XH = D.length - 1; XH >= 0; XH--) {
        let wH = D[XH];
        if (wH?.type === "assistant" && wH.message.content[0]?.type === "thinking") {
          let DH = Date.parse(wH.timestamp);
          if (Number.isFinite(DH)) ZH = DH;
          break;
        }
      }
      jH = createElement(C13, { baseMs: n, lastThinkingAtMs: ZH });
    } else {
      jH = createElement(V, { bold: true }, k7(Math.max(1000, n)));
    }
    TH.push(createElement(V, { key: "thought" }, fH, " for ", jH));
  }

  // ... 后续: edit files, search, read, repl, mcp, bash, memory, hooks 等部分
}
```

---

## 总结表

| 维度 | Claude Code | zy-code |
|---|---|---|
| **字段名** | `thoughtForMs` + `latestThinkingSummary` | `thinkingDurationMs` |
| **计时来源** | API 消息 `timestamp` 差值 | 客户端 `Date.now()` 挂钟差值 |
| **单次上限** | `de8 = 600000` (10min) | 无 |
| **渲染下限** | `Math.max(1000, n)` → 至少 "1s" | 无（0ms 不渲染） |
| **多 thinking 块** | **累加** `+=` | **覆盖**（只取最后） |
| **流式实时计时** | 全屏模式有 `C13` tick 组件 | 无 |
| **国际化** | 硬编码英文拼接 | i18n key（中/英） |
| **thinking 摘要** | `latestThinkingSummary` | 无 |
| **格式化函数** | `k7(ms)` — 显示所有非零单位 | `formatDuration` / `formatDurationZh` — 相同逻辑 |

---

## 15s vs 25s 差异的根因分析

用户观察到 CC 显示 "Thought for 15s" 而 zy-code 显示 "思考了 25 秒"，差异主要来自：

1. **计时来源不同**（最主要原因）：CC 用 API 侧消息 `timestamp` 计算纯思考时长，zy-code 用客户端 `Date.now()` 挂钟计时，额外包含了网络 RTT、流式 chunk 解析开销和客户端事件循环排队时间。
2. **多 thinking 块处理不同**：如果一次回复中有多段 thinking（被 tool_use 打断），CC 会累加所有段，zy-code 只取最后一段。
3. **下限保护**：CC 有 `Math.max(1000, n)` 确保至少显示 "1s"，zy-code 没有下限。

### 改进建议

如果希望 zy-code 的数值更接近 CC：

1. 在 `src/state/ReplStore.ts` 的 `setStreamMode` 中改用消息 `timestamp` 差值而非 `Date.now()`
2. 在 `src/utils/collapseReadSearch.ts` 中将 `pendingThinkingDurationMs = msg.thinkingDurationMs` 改为累加 `+=`
