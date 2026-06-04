# Claude Code `/cost` → `/usage` 命令整合分析

> 抽取日期：2026-06-02
> 数据源：`@anthropic-ai/claude-code` 二进制 `claude.exe`（约 205 MB，2026-06 版）
> 抽取方法：`grep -aob` + `dd` 字节偏移精确提取（参考 `extract-claude-internal` 技能）

## 1. 结论

Claude Code 已经**移除独立的 `/cost` 命令注册**，将其整合进 `/usage`。
- `/cost` 现在作为 `/usage` 的 **alias** 保留向后兼容，用户输入 `/cost` 仍可触发；
- `/usage` 在原有"显示当前 session 花费与时长"的基础上扩展为完整的"用量面板"（session cost + plan usage + activity stats）；
- 采用**同名双注册范式**（`local-jsx` 交互 + `local` 非交互），按 `isInteractive` 自动分流。

## 2. 二进制原文证据

### 2.1 关键字搜索结果

```text
# /usage 命令注册点（同名双注册，2 个偏移）
205292782:name:"usage"
205293022:name:"usage"

# /cost 已无独立 name 注册，仅在以下位置出现：
60979551 / 60979620 / 60980271      # 全部为 Node 运行时错误信息中的字段名
199696965                           # rc5(H) 类型守卫中的 "cost" in H 字段判断
208235041                           # UI 模态状态枚举中的 "cost" 标识
205292804 / 205293044               # 即 usage 命令 aliases:["cost","stats"] 中的字面量
```

结论：整个 binary 中已**不存在** `name:"cost"` 形式的独立命令注册，所有提到 `"cost"` 的非别名出处都与命令路由系统无关。

### 2.2 提取出的真实定义（偏移 205292782）

```js
// 交互式 Ink 版本（默认匹配）
x_q = {
  type: "local-jsx",
  name: "usage",
  aliases: ["cost", "stats"],
  description: "Show session cost, plan usage, and activity stats",
  thinClientDispatch: "control-request",
  immediate: !0,
  requires: { ink: !0 },
  load: () => Promise.resolve().then(() => (udK(), xdK))
}

// 非交互式纯文本版本（headless / -p 模式匹配）
u_q = {
  type: "local",
  name: "usage",
  aliases: ["cost", "stats"],
  supportsNonInteractive: !0,
  description: "Show the total cost and duration of the current session",
  isEnabled: () => S8(),
  get isHidden() { return !S8() },
  load: () => Promise.resolve().then(() => (pdK(), mdK))
}
```

### 2.3 模式分流开关（偏移 193250752）

```js
function S8(){ return !l_.isInteractive }
function fR(){ return l_.isInteractive }
```

- `S8()` → "当前是非交互模式"
- `local` 注册项 `isEnabled: () => S8()`、`isHidden: !S8()` ⇒ 仅在非交互模式（`claude -p` 等）下启用且可见；交互模式下被隐藏，命令路由命中 `local-jsx` 版本。

### 2.4 交互版本的 plan 升级提示（偏移 205292500 附近）

```js
// 用户当前是付费 plan 时，追加 Lark 升级链接（受 feature flag 控制）
if (Z_("tengu_amber_lark", !1)) {
  let _ = aX7();
  if (_) H += `\n\n${D_.dim(_)}`
}
return { type: "text", value: H }
```

- `tengu_amber_lark` 是 Anthropic 内部的 Lark（Lark = ?）feature flag，控制是否在 `/usage` 输出末尾追加订阅升级 CTA；
- 仅当用户处于交互式且 flag 开启、并能拿到升级链接时才显示。

## 3. 行为对照表

| 维度 | 旧 `/cost` | 新 `/usage` |
|---|---|---|
| 命令名 | `cost` | `usage` |
| 是否独立注册 | 是 | 否（仅作为 `usage` 的 alias） |
| 别名 | — | `cost`、`stats` |
| 交互式行为 | 仅打印 session 花费/时长 | Ink TUI：session cost + plan 用量 + activity stats + 订阅升级链接 |
| 非交互式行为 | 同上 | `local` 分支，输出"当前 session 总花费与持续时间" |
| 模式分流 | 无 | `S8()` 决定 `isHidden`/`isEnabled`，交互→`local-jsx`，非交互→`local` |
| `thinClientDispatch` | 无 | `control-request`（远端瘦客户端通过控制通道调度） |
| `supportsNonInteractive` | 默认 | `local` 显式声明 `!0` |

## 4. 关键变化点

1. **命令名变更**：可见名从 `cost` → `usage`，旧名作为 alias 保留兼容；
2. **能力扩展**：除 session cost/duration 外，新增 plan usage（订阅额度）与 activity stats；UI 由纯文本升级为 Ink 交互组件；
3. **同名双注册范式**：`local-jsx` + `local` 共享 name，按 `isInteractive` 自动分流——与 zy-code 已落地的 `/model`、`/effort` 完全同构；
4. **远端友好**：声明 `thinClientDispatch: "control-request"` 与 `supportsNonInteractive: !0`，便于在远端瘦客户端 / `-p` 模式被调度；
5. **运营钩子**：通过 `tengu_amber_lark` feature flag 在用量页注入订阅升级 CTA，把"用量查看"打通成"升级转化漏斗"的一环。

## 5. 对 zy-code 的可借鉴点

| 条目 | 借鉴价值 | 优先级 |
|---|---|---|
| `/cost` 独立命令 → 合并到 `/usage` | zy-code 当前 `/cost` 仍独立。可考虑同步演进：建一个统一的"用量面板"命令，旧 `/cost` 保留 alias | P2 |
| 用量页 = session cost + plan + activity | zy-code `/cost` 仅显示 session；可拓展 plan 用量（若接入了订阅）与 activity stats | P2 |
| `thinClientDispatch: "control-request"` | 若 zy-code 远端瘦客户端通道继续演进，应把控制类命令（usage / status / context 等）打上该标记 | P3 |
| 同名双注册分流（local-jsx + local） | zy-code 已在 `/model`、`/effort` 落地，可继续推广到 `/cost`、`/context`、`/status` 等可双模式的命令 | P2 |
| feature flag 注入 CTA | 适合作为运营/订阅引导通用范式（zy-code 当前不需要订阅引导，但可借鉴 flag 注入文案的做法） | P3 |

## 6. 抽取脚本归档（可复现）

```bash
CLAUDE_BIN=/Users/zy979/.nvm/versions/node/v24.14.1/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe

# 1. 定位 usage 命令注册偏移
grep -aob 'name:"usage"' "$CLAUDE_BIN" | head -5
# → 205292782 / 205293022

# 2. 提取双注册块
dd if="$CLAUDE_BIN" of=/tmp/usage_chunk.txt bs=1 skip=205292500 count=2500 2>/dev/null

# 3. 验证 cost 已无独立注册
grep -aob '"cost"' "$CLAUDE_BIN" | head -20
# 各偏移逐一抽样验证均为非命令注册场景

# 4. 抽取 S8() 模式分流函数
grep -aob 'function S8(' "$CLAUDE_BIN" | head -3
dd if="$CLAUDE_BIN" of=/tmp/s8.txt bs=1 skip=193250752 count=400 2>/dev/null
```

## 7. Alias 差异化 Tab 跳转机制

`/usage`、`/cost`、`/stats` 共享同一份命令注册，却能落到不同初始 Tab —— 这是通过 dispatcher 把"用户实际输入的命令名"作为参数下传给 `call()` 实现的。

### 7.1 二进制原文（偏移 207188100 一带）

```js
// 命令注册（一份，三个入口共享）
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

// MiK 模块导出的 call 实现
var MiK = {};
f_(MiK, { call: () => wW3 });
var wW3 = async (H, _, q, K) => {
  return R8q.createElement(A8_, {
    onClose: H,
    context: _,
    defaultTab: K === "stats" ? "Stats" : "Usage"
  });
};
```

### 7.2 call 函数四参数协议

| 形参 | 含义 |
|---|---|
| `H` | `onClose` 回调（用户按 Esc 关闭面板时调用） |
| `_` | `context`（应用全局状态、命令上下文） |
| `q` | `args`（slash 命令后跟的参数字符串） |
| `K` | **`invokedAs`** — 用户实际输入的那个名字（`"usage"` / `"cost"` / `"stats"` 三选一） |

关键点：`K` 是 dispatcher 从用户输入解析出的**原始命令名**，不是 `name` 字段。alias 命中后 dispatcher 会原样保留输入名继续下传，这让 alias 能携带额外语义。

### 7.3 路由结果对照

| 用户输入 | `K` 收到 | `defaultTab` 结果 |
|---|---|---|
| `/usage` | `"usage"` | `"Usage"` |
| `/cost`  | `"cost"`  | `"Usage"` |
| `/stats` | `"stats"` | `"Stats"` |

> ⚠️ 注意：`/cost` 并**不**单独跳到某个 cost tab —— 它和 `/usage` 落在同一个 `Usage` tab，**只有 `/stats`** 跳到 `Stats` tab。新 UI 把"成本/用量"合并展示，没必要再分一个 cost 子 tab；保留 `/cost` 仅为向后兼容。

### 7.4 完整路由链路

```
用户输入 /cost (或 /usage / /stats)
    ↓
slash 命令解析器拆出 cmdName = "cost"
    ↓
命令路由：cmds.find(c => c.name === cmdName || c.aliases?.includes(cmdName))
    ↓ 命中 L8q（usage 注册项）
load() 拉起 MiK 模块
    ↓
dispatcher 调用 MiK.call(onClose, context, args, "cost")
                                              ^^^^^^^
                                       原样保留用户输入名
    ↓
wW3 内部：K === "stats" ? "Stats" : "Usage"  →  "Usage"
    ↓
渲染 <A8_ defaultTab="Usage" />
    ↓
A8_（Ink Tabs 组件）按 defaultTab 选中并高亮对应 tab
```

A8_ 内部就是普通的 `useState(defaultTab)` 受控初值模式，没有特殊魔法。

### 7.5 设计要点提炼（zy-code 可借鉴）

1. **alias 不是单纯"等价别名"**：dispatcher 把"原始输入名"原样下传给 call 函数，让 alias 携带额外语义（直达某 tab、预设某模式、切换变体）。
2. **避免分裂为多个命令注册**：共享 `load()` / 组件 / 文档，alias 间差异只体现在"初始化参数"层面，避免代码重复与说明文档分裂。
3. **协议在调度器层面统一**：`call(onClose, context, args, invokedAs)` 作为 local-jsx 命令的固定签名，所有共享 alias 的命令都能直接拿到 `invokedAs` 做条件分支。
4. **可推广到 zy-code**：
   - `/cost` `/stats` 可在 zy-code 中合并为 `/usage` 主命令 + alias，复用同一个用量面板组件；
   - 凡是"主面板 + 多个入口想直达不同 tab"的场景（设置面板、上下文面板、调试面板等）都可套用此模式；
   - 关键改造点是命令 dispatcher 的 call 签名要把 `invokedAs` 显式传进去（zy-code 现有 dispatcher 若未传，需补充）。

## 8. 参考记忆

- 任务总结经验 · `zy-code 同名双注册范式落地（/model 与 /effort）`
- 学习技能 · `同名 local/jsx 命令去重技能`
- 学习技能 · `命令双模式解耦与增强技能`
- 项目介绍 · `Claude Code 同名双注册命令清单`（建议本次将 `usage` 加入清单）
- 项目介绍 · `Claude Code 多 alias 差异化 Tab 跳转机制`
