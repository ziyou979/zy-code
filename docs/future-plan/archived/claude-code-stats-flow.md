# Claude Code `/stats` 命令完整执行与渲染流程

> 抽取日期：2026-06-02
> 数据源：`@anthropic-ai/claude-code` 二进制 `claude.exe`（约 205 MB，2026-06 版）
> 抽取方法：`grep -aob` + `dd` 字节偏移精确提取
>
> 用途：作为 zy-code 对齐 /stats 实现的基准参考。重点关注**数据加载时序、组件层次结构、子 Tab 切换、键盘交互、剪贴板导出**这五条主线。

---

## 0. TL;DR 一图流

```
用户输入 /stats
   │
   ▼
slash 命令解析 → cmdName = "stats"
   │
   ▼ (alias 命中 usage 注册项 L8q)
load() 拉起 MiK 模块
   │
   ▼
MiK.call(onClose, context, args, "stats")  ← 第 4 参数原样保留 invokedAs
   │
   ▼
wW3 返回 <A8_ defaultTab="Stats" .../>   （A8_ 是统一 Settings 面板）
   │
   ▼
A8_ 渲染 4 个 Tab，初始选中 "Stats"
   │  ├─ Status → uEK
   │  ├─ Config → FSK (Suspense)
   │  ├─ Usage  → $CK
   │  └─ Stats  → xCK   ◀ 当前 tab
   │
   ▼
xCK 启动两个 useState lazy init：
   ├─ allTimePromise = L33()           （加载全期 stats）
   └─ activeTimePromise = N33()        （加载活跃时段 stats）
   │
   ▼  (Suspense fallback = "Loading your Claude Code stats…")
V33 用 Wq.use() 解开 promise
   │
   ▼
内部子 Tab 切换：
   ├─ Overview → v33（默认）
   └─ Models   → E33

  快捷键：r 循环日期范围 · ctrl+s 复制 · ↑/↓ 滚动 · esc 关闭
```

---

## 1. 命令注册（共享 usage）

二进制偏移 `207188100` 一带：

```js
L8q = {
  type: "local-jsx",
  name: "usage",
  aliases: ["cost", "stats"],
  description: "Show session cost, plan usage, and activity stats",
  thinClientDispatch: "control-request",
  immediate: !0,
  requires: { ink: !0 },
  load: () => Promise.resolve().then(() => (XiK(), MiK))
}
```

**关键点**：`/stats` 没有独立注册，是 `/usage` 的 alias。

---

## 2. Dispatcher 调用 call

`MiK` 模块导出的 `call`（即 `wW3`）：

```js
var wW3 = async (H, _, q, K) => {
  return R8q.createElement(A8_, {
    onClose: H,
    context: _,
    defaultTab: K === "stats" ? "Stats" : "Usage"
  });
};
```

四参数协议：`call(onClose, context, args, invokedAs)`。
- 输入 `/stats` → `K = "stats"` → `defaultTab = "Stats"`
- 注意 `args`（`q`）在这个 call 里没用到，stats 命令不接受参数。

---

## 3. 父组件 `A8_`（统一 Settings 面板，多命令共享）

二进制偏移 `206268260`。被 4 个命令共用：

| 命令 | defaultTab |
|---|---|
| `/status` | `"Status"` |
| `/config` `/settings` | `"Config"` |
| `/usage` `/cost` | `"Usage"` |
| `/stats` | `"Stats"` |

### 3.1 函数签名与状态

```js
function A8_(H) {
  const { onClose: q, context: K, defaultTab: O } = H;
  const [T, $] = useState(O);          // T = 当前选中 tab
  const [z, A] = useState(false);      // z = 是否隐藏整个面板（Config 进入 dialog 时）
  const [Y, w] = useState(false);      // Y = Config dialog 是否打开
  const [j, J] = useState(false);      // j = Gates 状态
  const f = VJ();                      // 是否处于焦点态
  const { rows: D } = xj(Y8());
  const M = f
    ? D + 1
    : Math.max(15, Math.min(Math.floor(D * 0.8), 30));   // 内容高度
  const [X] = useState(F33);           // ★ 诊断数据预加载（见 3.3）
  ...
}
```

### 3.2 Tab 列表构造（4 个 Tab）

```js
let L = createElement(MT, { key: "status", title: "Status" },
          createElement(uEK, { context: K, diagnosticsPromise: X }));

let k = createElement(MT, { key: "config", title: "Config" },
          createElement(Suspense, { fallback: null },
            createElement(FSK, {
              context: K, onClose: q,
              setTabsHidden: A,
              onIsSearchModeChange: w,
              contentHeight: M
            })));

let v = createElement(MT, { key: "usage", title: "Usage" },
          createElement($CK, null));      // 注意 Usage 不传 props

let E = createElement(MT, { key: "stats", title: "Stats" },
          createElement(xCK, { onClose: q }));

let S = [L, k, v, E];   // 数组顺序：Status, Config, Usage, Stats

return createElement(p1, { color: "permission" },
         createElement(XZ, {
           title: "Settings",
           color: "permission",
           selectedTab: T,
           onTabChange: $,
           hidden: z,
           initialHeaderFocused: I        // I = (defaultTab !== "Config" && defaultTab !== "Gates")
         }, S));
```

### 3.3 ⚠️ 隐藏行为：Status 诊断数据**预热**

```js
const [X] = useState(F33);
function F33() { return xEK().catch(g33); }
function g33() { return []; }
```

只要打开了 A8_（无论用户进哪个 tab），`xEK()` 都会**立即开始**加载诊断数据。这意味着：
- 用户从 `/stats` 切到 `Status` 时，诊断数据通常已经就绪；
- 这是用 React `useState` 把 Promise 当 state 存住的常见技巧（lazy initializer 只跑一次）。

zy-code 实现 `/stats` 时如果共享类似父组件，应注意这个**跨 tab 的预热副作用**。

### 3.4 Esc 键关闭语义因 Tab 而异

```js
let W = !z
     && !(T === "Config" && Y)
     && !(T === "Gates" && j)
     && T !== "Stats";
j8("confirm:no", Z, { context: "Settings", isActive: W });
```

`Stats` Tab 时**禁用**外层 confirm:no（Esc）处理 —— 因为 `xCK` 内部自己处理 Esc（见 §4.4）。

---

## 4. Stats 容器 `xCK`（偏移 `206248259`）

### 4.1 职责

仅负责**两个 Promise 的 lazy init** 和 Suspense 边界：

```js
function xCK(H) {
  const { onClose: q } = H;
  const O = useState(L33)[0];          // allTimePromise = 全期 stats
  const $ = useState(N33)[0];          // activeTimePromise = 活跃时段
  const { rows: z } = xj(Y8());
  const A = Math.max(8, Math.min(z - 4, 30));   // 最小高度
  const Y = createElement(B, { marginTop: 1 },
              createElement(c5, null),                    // spinner
              createElement(N, null, " Loading your Claude Code stats…"));
  return createElement(B, { flexDirection: "column", minHeight: A },
           createElement(Suspense, { fallback: Y },
             createElement(V33, {
               allTimePromise: O,
               activeTimePromise: $,
               onClose: q
             })));
}
```

`L33()` / `N33()` 是 stats 数据加载入口（fetch from `~/.claude/...` 落地的 jsonl 或后台聚合服务，具体路径未在 chunk 中展示）。

---

## 5. 主体组件 `V33`（真正的 Stats UI）

### 5.1 状态机

```js
function V33(H) {
  const { allTimePromise: q, activeTimePromise: K, onClose: O } = H;
  const T = use(q);                     // 解 allTime
  const $ = use(K);                     // 解 activeTime
  const [z, A] = useState("all");       // ★ 日期范围：'all' | '7d' | '30d'
  const [w, j] = useState({});          // ★ 非 'all' 范围的缓存 map：{ '7d': data, '30d': data }
  const [J, f] = useState(false);       // 是否正在加载切换后的范围
  const [D, M] = useState("Overview");  // ★ 子 Tab：'Overview' | 'Models'
  const [X, P] = useState(null);        // 复制状态文案 ('copying…' | 'copied!' | 'copy failed')
  const Z = tq();                       // setTimeout 包装

  // 当切换到非 all 的日期范围且未缓存时，懒加载
  useEffect(() => {
    if (z === "all" || w[z]) return;
    let aborted = false;
    f(true);
    Ct8(z).then((o) => {
      if (!aborted) j(prev => ({ ...prev, [z]: o })), f(false);
    }).catch(() => { if (!aborted) f(false); });
    return () => { aborted = true; };
  }, [z, w]);

  const L = z === "all"
              ? (T.type === "success" ? T.data : null)
              : (w[z] ?? (T.type === "success" ? T.data : null));   // 当前显示的 stats
  const k = T.type === "success" ? T.data : null;                   // allTime（用于 streaks 等"跨时间"指标）
  ...
}
```

**两层数据**：
- `L` 是"当前 dateRange 视图"数据（用于 token 总数、模型分布等）；
- `k` 是"全期"数据（用于 currentStreak/longestStreak/dailyActivity 热图等）。

### 5.2 三态分支

按顺序优先级：

```js
if (T.type === "error") → "Failed to load stats: <message>"
if (T.type === "empty") → "No stats available yet. Start using Claude Code!"
if (!L || !k)          → spinner + "Loading stats…"
否则                    → 完整 UI
```

### 5.3 子 Tab 容器

```js
<XZ
  initialHeaderFocused={true}
  title={null}
  color="claude"
  selectedTab={D}             // 'Overview' | 'Models'
  onTabChange={(a) => M(a)}
  disableNavigation={S}       // S = headerFocused（焦点在外层 Header 时禁止切子 tab）
>
  <MT title="Overview"><v33 stats={L} allTimeStats={k} activeTimeStats={$} dateRange={z} isLoading={J}/></MT>
  <MT title="Models"  ><E33 stats={L} dateRange={z} isLoading={J}/></MT>
</XZ>
```

**注意**：`v33` 拿到 `allTimeStats`（`k`）用于热图与 streak；`E33` 只拿到 `L`。

### 5.4 键盘交互

```js
function onKeyDown(o) {
  if (o.key === "up")        { focusHeader(); return; }      // ↑ 移焦点到顶部 Header
  if (o.key === "r" && !o.ctrl && !o.meta) {                 // r 循环日期范围
    A(R33(z));               // R33 实现：'all' → '7d' → '30d' → 'all'
    return;
  }
  if (o.ctrl && o.key === "s" && L) m33(L, $, D, P, Z);      // ctrl+s 复制（见 §7）
}
```

### 5.5 底部状态栏

```js
const Q = S ? "↓ stats" : "↑ tabs";       // 焦点提示
const l = X ? ` · ${X}` : "";             // 复制状态
<N dimColor>{Q} · r to cycle dates · ctrl+s to copy{l}</N>
```

---

## 6. Overview / Models 子组件

### 6.1 Overview = `v33`

展示卡片字段（两列布局，每列 width=28）：

| 字段 | 数据来源 |
|---|---|
| Activity heatmap | `allTimeStats.dailyActivity`（仅当 length>0 时渲染） |
| Date range pill | `<uCK dateRange={z} isLoading={O} />` 显示当前选中 chip |
| Favorite model | `Object.entries(stats.modelUsage).sort(byTotalTokens)[0]` |
| Total tokens | 累计 `inputTokens + outputTokens` |
| Sessions | `stats.totalSessions` |
| Longest session | `_7(stats.longestSession.duration)` |
| Active days / total | `stats.activeDays / w`（w 由 dateRange 推算：7d→7、30d→30、all→`stats.totalDays`） |
| Longest streak | `stats.streaks.longestStreak` |
| Most active day | `G33(stats.peakActivityDay)` |
| Current streak | `allTimeStats.streaks.currentStreak`（**用 allTime 不用 L**） |
| 推荐文案 | `mCK(stats, totalTokens)` 见 §6.3 |

**Shot distribution** 部分被 `null,!1` 短路掉了 —— 即在当前版本被关闭，但代码尚保留。

### 6.2 Models = `E33`

```js
function E33({ stats, dateRange, isLoading }) {
  const [z, A] = useState(0);          // 模型列表分页起点（一次显示 4 个）
  const M = Object.entries(stats.modelUsage).sort(byTotalTokens);

  // 每页两列、每列两行：
  const a = M.slice(z, z + 4);
  const HH = a.slice(0, Math.ceil(a.length / 2));
  const t  = a.slice(Math.ceil(a.length / 2));

  // 折线图
  const i = pCK(stats.dailyModelTokens, M.map(([name]) => name), columns);
  // pCK 内部使用 asciichart (ICK.plot) 绘制 Tokens per Day，最多 3 条线
}
```

每个 model 卡片 `bCK`：
```
<Bold>{UY(model)}</Bold>  <Subtle>(NN.N%)</Subtle>
  In: <num>  ·  Out: <num>
```

键盘：
- `↓` 翻下一页（`z + 2`，每次跳 2 行）
- `↑` 翻上一页 / 跳出焦点

### 6.3 推荐文案 `mCK`

```js
function mCK(stats, totalTokens) {
  const lines = [];
  // 1. 与"知名书籍/文章"对比
  for (let item of h33.filter(t => totalTokens >= t.tokens)) {
    const ratio = totalTokens / item.tokens;
    lines.push(ratio >= 2
      ? `You've used ~${Math.floor(ratio)}x more tokens than ${item.name}`
      : `You've used the same number of tokens as ${item.name}`);
  }
  // 2. 与"知名时长事件"对比（足球赛 90min、半马 120min、Inception 148min、Titanic 195min、跨大西洋飞行 420min、整夜睡眠 480min）
  if (stats.longestSession) {
    const minutes = stats.longestSession.duration / 60000;
    for (let t of y33) {
      const ratio = minutes / t.minutes;
      if (ratio >= 2) lines.push(`Your longest session is ~${Math.floor(ratio)}x longer than ${t.name}`);
    }
  }
  // 随机挑一条
  return lines[Math.floor(Math.random() * lines.length)] ?? "";
}
```

`y33` 数组（彩蛋数据，全文如下）：
```js
y33 = [
  { name: "a Cup soccer match",       minutes: 90  },
  { name: "a half marathon (average time)", minutes: 120 },
  { name: "the movie Inception",      minutes: 148 },
  { name: "watching Titanic",         minutes: 195 },
  { name: "a transatlantic flight",   minutes: 420 },
  { name: "a full night of sleep",    minutes: 480 }
];
```

---

## 7. 剪贴板导出（`ctrl+s`）

### 7.1 入口 `m33`

```js
async function m33(stats, activeTimeStats, currentSubTab, setCopyStatus, setTimeoutWrap) {
  setCopyStatus("copying…");
  const text = p33(stats, activeTimeStats, currentSubTab);
  const r = await NCK(text);                   // 系统剪贴板 API
  setCopyStatus(r.success ? "copied!" : "copy failed");
  setTimeoutWrap.setTimeout(() => setCopyStatus(null), 2000);
}
```

### 7.2 文本组装 `p33`

```js
function p33(stats, activeTimeStats, currentSubTab) {
  let lines = currentSubTab === "Overview"
    ? B33(stats, activeTimeStats)              // Overview 视图导出
    : U33(stats);                              // Models 视图导出
  while (lines.length && stripAnsi(lines.at(-1)).trim() === "") lines.pop();
  // 在最后一行末尾追加灰色 "/stats" 水印（右对齐）
  if (lines.length) {
    const last = lines.at(-1);
    const visualWidth = K6(last);
    const targetWidth = currentSubTab === "Overview" ? 70 : 80;
    const padding = Math.max(2, targetWidth - visualWidth - 6);
    lines[lines.length - 1] = last + " ".repeat(padding) + chalk.gray("/stats");
  }
  return lines.join("\n");
}
```

`B33` / `U33` 输出格式略（参考 chunk 207188100 之前的代码段，包含 `Favorite model`、表格化排列）。

---

## 8. 数据加载入口（外部依赖）

| 函数 | 含义 | 触发时机 |
|---|---|---|
| `xEK()` | 诊断/Status 数据 | A8_ 一挂载就预热（无论哪个 tab） |
| `L33()` | allTime stats | xCK 一挂载就 lazy init |
| `N33()` | activeTime stats | 同上 |
| `Ct8(dateRange)` | 按 7d/30d 过滤的 stats | 用户按 `r` 切换非 all 范围且首次访问时 |

> 这 4 个函数本身的实现未在本次抽取范围内展开，但从命名能推断它们最终读取本地 jsonl session 历史并聚合。zy-code 已有类似 sessionStorage 链路（`utils/session-storage.ts`），可基于此做适配。

---

## 9. zy-code 当前实现可能存在的问题（待核对）

基于这份完整流程，zy-code 实现 `/stats` 时常见偏差 checkpoints：

1. **alias 未把 invokedAs 透传到 call**：dispatcher 仅按 name 路由，导致 `/stats` `/cost` 行为完全等价、无法跳到不同 tab。
2. **数据预热缺失**：每次切 tab 才开始加载，导致首次切换有几秒空窗。
3. **dateRange 缓存策略**：把 `'7d'/'30d'` 数据混进同一个 state，切换时反复重新拉取（应该用 `{ '7d': data, '30d': data }` map 缓存）。
4. **allTime vs current 分离**：streak/dailyActivity 必须用 `allTimeStats`；`stats.streaks.longestStreak` 跟 `allTimeStats.streaks.currentStreak` 不能混用。
5. **键盘事件作用域**：A8_ 父级在 Stats Tab 时**关闭** `confirm:no`，让 `V33` 自己处理 Esc。zy-code 若没做这个分离，会出现 Esc 行为异常。
6. **Suspense fallback 缺失**：异步数据用 `use(promise)` 必须包 Suspense，否则白屏。
7. **复制水印未对齐**：`/stats` 字样应该用 visual width 计算右对齐，不能用字符串 length（因为有 ANSI 颜色码）。

---

## 10. 关键符号一览表（便于二次抽取）

| 符号 | 含义 | 偏移 |
|---|---|---|
| `L8q` | usage 命令 local-jsx 注册项 | 207188400 一带 |
| `wW3` | usage 命令 call 函数（含 defaultTab 分发） | 207188264 |
| `A8_` | 统一 Settings 面板父组件（Status/Config/Usage/Stats 共享） | 206268260 |
| `xCK` | Stats Tab 容器（lazy init promises） | 206248259 |
| `V33` | Stats 主体组件（dateRange + 子 Tab） | 206252xxx |
| `v33` | Overview 子组件 | 同上区域 |
| `E33` | Models 子组件 | 同上区域 |
| `bCK` | 单个 model 卡片 | 同上区域 |
| `pCK` | Tokens per Day 折线图（asciichart） | 同上区域 |
| `mCK` | 推荐/对比文案生成 | 同上区域 |
| `m33` / `p33` / `B33` / `U33` | 剪贴板导出链 | 同上区域 |
| `F33` / `xEK` | 诊断数据预热 | 206270xxx |
| `L33` / `N33` / `Ct8` | stats 数据加载入口 | 待二次抽取 |

---

## 11. 复现命令

```bash
CLAUDE_BIN=/Users/zy979/.nvm/versions/node/v24.14.1/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe

# 命令注册
grep -aob 'name:"usage"' "$CLAUDE_BIN" | head -5

# 父组件
grep -aob 'function A8_' "$CLAUDE_BIN" | head -5
dd if="$CLAUDE_BIN" of=/tmp/A8.txt bs=1 skip=206268180 count=20000

# Stats 容器
grep -aob 'function xCK' "$CLAUDE_BIN" | head -5
dd if="$CLAUDE_BIN" of=/tmp/xCK.txt bs=1 skip=206248259 count=18000

# 数据加载入口（待补）
grep -aob 'function L33' "$CLAUDE_BIN" | head -5
grep -aob 'function N33' "$CLAUDE_BIN" | head -5
grep -aob 'function Ct8' "$CLAUDE_BIN" | head -5
```

## 12. 参考记忆

- 项目介绍 · `Claude Code 多 alias 差异化 Tab 跳转机制`
- 任务总结经验 · `zy-code 同名双注册范式落地（/model 与 /effort）`
- 学习技能 · `闭源 AI 工具内部机制逆向分析技能`
- 学习技能 · `命令双模式解耦与增强技能`
