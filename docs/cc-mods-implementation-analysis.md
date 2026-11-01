# Claude Code v2.1.289 "mods" 机制实现分析报告

> 分析对象：`@anthropic-ai/claude-code@2.1.289`，`bin/claude.exe`（238 MB，esbuild+Bun 单文件产物）
> 分析方法：字节偏移定位 + `dd`/`tr` 提取，未执行任何提取内容
> 对比对象：zy-code `src/services/plugins/`（60 文件）+ `docs/core-surface-architecture-design.md`
> 结论日期：2026-10-04

---

## 0. 摘要：一个重要的前提纠正

在展开细节前，必须先纠正一个可能的误解，因为它会改变整份报告的结论走向。

**"Claude Code 引入 mods 模式"这个说法不准确。** 二进制里的 `mods` 不是一个新引入的插件系统，而是**它原有 plugin 系统的第二条加载通道**——一条为"让 Claude 自己写代码给自己用"设计的、绕过 marketplace 与人工审核的旁路。

三条证据：

1. `mods` 复用的清单文件是 `.claude-plugin/plugin.json`，与 plugin 完全同一套 schema、同一套 `CLAUDE_PLUGIN_ROOT` 变量、同一套 `hooks.json` 事件系统。
2. 内部路径常量 `var lo = "vendor/claude-code-mods/mods"`，与 `var lo = "hooks/register.ts"` 并列出现在同一个 Bun plugin 注册器里——它是 plugin 加载器的内置 mod 源之一。
3. 关闭开关叫 `/plugin enable/disable`，mod 的状态也显示在 `/plugin` 界面里（原文：`/plugin lists what loaded and turns it off`、`/plugin shows why`）。

**同时，zy-code 已经实现了这一整套。** `src/services/plugins/` 下有 60 个 `.ts/.tsx` 文件（含 `plugin-loader/`、`marketplace-manager/` 两个子目录），`loadPluginHooks.ts` / `loadPluginCommands.ts` / `loadPluginAgents.ts` / `pluginLoader.ts` / `marketplaceManager.ts` / `/reload-plugins` / `/plugin` 交互界面 / `CLAUDE_PLUGIN_ROOT` 展开逻辑（`src/services/hooks/commandRunner.ts:233`）一应俱全。zy-code 不是"一开始想走 mods 方向但没走"，而是**已经把 CC 的 plugin 系统完整移植过来了，并且额外做了 Cordis 化的架构规划**。

所以本报告真正有价值的部分，不是"CC 有什么我们没有"，而是：**CC 在 plugin 之上又叠了一层什么，以及那层为什么值得抄。**

---

## 1. 定位过程与证据锚点

| 目标 | 字节偏移 | 提取到的关键内容 |
|------|---------|----------------|
| `vendor/claude-code-mods/mods` | `105794171` / `207546027` | 内置 mod 源根路径常量 |
| `CLAUDE_DEV_MODS_DIR` | `99280769` | dev mods 目录环境变量 |
| mod 状态机文案 | `99280400`–`99284500` | 6 状态定义 + 同意/拒绝话术 |
| `/reload-plugins` 命令 | `98573054`、`98626092` | 命令注册 + "Plugins changed" 提示 |
| `plugin.json` schema | `99368000`–`99397000` | 清单校验器全套诊断文案 |
| `hooks.json` 文档 | `99014800`–`99022800` | **完整的 hook 系统文档**（见 §4.3） |
| Bun plugin 注册器 | `207546027` | `builtin-hooks-module` 命名空间、`onResolve`/`onLoad` |
| hooks 模块扫描契约 | `207547000` | AST 静态分析、沙箱限制 |
| `EngineInterface` 契约 | `99382400` | 插件的 TS 类型合约 |
| session 状态字段 | `216465000`、`98522500` | `devModsFolder`、`currentSessionDevModsFolder` |

> **方法论提示**：函数名（`Ut`、`rn`、`ve`）每次构建都变，跨版本不可用。本次定位主要靠**日志字面量**（`dev mods: the watch did not start:`）和**schema 键名**（`plugin.json`）作为锚点，这两个跨版本稳定。

---

## 2. 核心结论：mods 到底做了什么

### 2.1 一句话

> **CC 让 Claude 能把 JavaScript 模块写进一个受监控的目录，在用户逐次同意的前提下，用 Bun 的 plugin API 把这些模块热插拔进自己的运行时——不需要 marketplace、不需要审核、不需要重启。**

### 2.2 与 plugin 的关系

```
marketplace ──→ 安装到 ~/.claude/plugins/ ──→ plugin.json ──┐
                                                           ├──→ 同一个加载器 ──→ hooks/commands/agents/skills/mcp
--plugin-dir ──→ 直接指向本地目录 ──→ plugin.json ─────────┤
                                                           │
dev mods ──→ CLAUDE_DEV_MODS_DIR ──→ plugin.json ──────────┘
              （Claude 自己写的代码，逐次同意，无审核）
```

三条通道汇入同一个 `plugin.json` schema。**dev mods 不是新格式，是新来源。**

### 2.3 六种 mod 加载状态（原文提取）

这是 CC 最值得学的部分——它把"一个 mod 当前处于什么状态"建模成了显式状态机，而不是一个布尔值：

| 状态 | CC 原文（提取自 `99280400` 区域） |
|------|----------------------------------|
| `loaded` | `loaded from this session's mods folder` |
| `unloaded` | `unloaded (gone from this session's mods folder)` |
| `not-loaded` | `in this session's mods folder, not loaded; /plugin shows why` |
| `on-hold` | `in this session's mods folder, on hold: /reload-plugins applies it` |
| `needs-restart` | `in this session's mods folder; restart to apply` |
| `enable_failed` | `chose enable_failed` |

**设计要点**：每个状态都自带一句"人能看懂的话"。`/plugin` 界面直接把这句话显示出来。用户永远不需要猜"为什么我的 mod 没生效"。

---

## 3. dev mods 的完整流程

### 3.1 触发与目录

```
环境变量：CLAUDE_DEV_MODS_DIR     （偏移 99280769）
占位符：  DEV_MODS_PLACEHOLDER    （偏移 99284093）
```

Claude 写文件到这个目录，触发 watcher。CC 的 watcher 实现（偏移 `99283900`）暴露了这些内部标识：

```
watchRoot, onBegin, onEnd, isClosed, allowManagedHooksOnly, isPreload,
loaded_at_start, listChildren, unlinkDir, followSymlinks,
usePolling, interval, binaryInterval, isPersonTurn, quietMs, turn-end
```

几个设计细节：

- **`usePolling` / `interval` / `binaryInterval` 分离**——普通文件轮询间隔与二进制文件轮询间隔分开。大 mod 里常含二进制（`.wasm`、模型文件），用同一间隔会浪费 IO。
- **`followSymlinks` 可关**——安全开关，防止 mod 目录里的符号链接指向插件目录外。
- **`isPersonTurn`**——只在"人的回合"结束时处理变更，不在 Claude 自己执行的回合处理。避免自己触发自己的 reload 循环。
- **`turn-end` 静默期**（`quietMs`）——文件写入完成后的防抖窗口，避免边写边读。

### 3.2 同意流程（CC 最有分量的设计）

CC 没有默默加载 Claude 写的代码。它设计了一个**每次运行、每处目录、单独询问**的同意模型。

询问文案（原文提取，`99280700` 区域）：

```
Mods in <dir> load and reload when their files change.
They run with your permissions.

[ ] Enable
    - Mods live in <dir>: they load and reload when their files change.
    - Enable holds for this session, also after a restart.
[ ] Not now
    - they stay unloaded until this session next starts.
[ ] Explain
    - /plugin lists what loaded and turns it off.
```

三个选项对应三种语义，边界写得很清楚：**同意是"本会话 + 重启后依然有效"，不是一次性**。

拒绝后注入给 Claude 的 guidance（原文）：

```text
The person declined mod hot-reloading: what this run wrote under <dir>
is written but NOT loaded (a mod that loaded when the session started keeps
running as it loaded). Do not say the change is running. It loads the next
time this session starts (/reload-plugins reloads only a mod that loaded at
the start); the person can ask again.
```

未回答时的 guidance：

```text
The person has not answered the mod hot-reloading question yet; it is asked
again once a turn ends. What this run wrote under <dir> is written but NOT
loaded yet. Do not say it was declined, and do not suggest --plugin-dir or
a restart.
```

**这段 prompt 的价值远超它的长度。** 它解决的是一个非常具体且非常容易出错的问题：**Claude 会撒谎说自己刚写的代码已经跑起来了。** CC 用三句话堵死了这个漏洞：

1. `Do not say the change is running.` —— 明确禁止虚假陈述
2. `Do not say it was declined` —— 区分"未回答"与"拒绝"，避免误报
3. `do not suggest --plugin-dir or a restart` —— 防止 Claude 自己找绕行方案

这三条约束是**行为契约**，不是文档说明。它们写进了 system prompt，在 Claude 每次可能"想吹牛"的地方生效。

### 3.3 启用后的两种结果

CC 区分了"热重载真的生效"和"本次会话不能重载"：

```text
[已启用并生效]
The person enabled mod hot-reloading for this session and the mods under
<dir> loaded: they load and reload by themselves as their files change;
the transcript names any mod that failed.

[已启用但需等 /reload-plugins]
The person enabled mod hot-reloading for this session, but the mods under
<dir> wait for /reload-plugins (the load would rewrite the prompt cache):
they are NOT loaded yet.
```

括号里的原因——**"重载会重写 prompt cache"**——是整个设计里最务实的一句话。它诚实地告诉用户"我本来想自动做，但自动做会清掉你的 prompt cache，所以得你手动确认"。这种把技术约束翻译成用户决策的设计，比任何文档都有效。

### 3.4 拦截：什么时候不能加载

`99280000` 区域提取到完整的拦截原因枚举：

```text
hooks modules are switched off in this process
  ├ all_hooks_disabled          — 组织禁用所有 hooks
  ├ sideload_disabled           — 组织禁止 side-loaded 插件
  ├ local_dirs_blocked          — 组织阻止本地目录插件
  ├ managed_hooks_only          — 组织只允许 managed hooks
  ├ hooks_disabled_in_settings  — 用户 settings 里 disableAllHooks
  └ bare_mode / diskless        — 云端会话无磁盘

the workspace is not trusted     — 工作区未受信任
```

注意 `isRefused` / `no_one_to_ask` / `watching` 三态。**"没有人可问"被当作一个独立的失败原因**，而不是当作拒绝——因为它们触发的后续行为不同（未回答要重问，拒绝不再问）。

---

## 4. mod 能做什么：能力面

### 4.1 hooks 模块（`hooks/register.ts`）

这是 mods 的主入口。CC 用 Bun 的 plugin API 加载用户 JS（偏移 `207546027`）：

```js
var lo = "vendor/claude-code-mods/mods";   // 内置 mod 根
var uo = "mods/";                            // mod 路径前缀
var zo = "builtin-hooks-module:";            // 命名空间前缀

// 路径解析：mods/x → vendor/claude-code-mods/mods/x
function rn(importer, path) {
  let r = path.slice(zo.length);
  return r.startsWith(uo)
    ? `${lo}/${r.slice(uo.length)}`
    : relative(root(), resolve(dirname(importer), r)).split(sep).join("/");
}

var Gj = {
  name: "builtin-hooks-module",
  setup(e) {
    e.onResolve({ filter: /^builtin-hooks-module:/ },
      o => ({ path: rn(o.importer, o.path), namespace: "builtin-hooks-module" }));
    e.onLoad({ filter: /.*/, namespace: "builtin-hooks-module" }, async o => {
      // 关键：不直接在主进程 import，而是 spawn 一个子 Bun 进程
      let r = Bun.spawn([process.execPath, "--smol", scanner, o.path], {
        cwd: root(), stdout: "pipe", stderr: "pipe", windowsHide: true
      });
      let [t, n, s] = await Promise.all([...]);
      if (s !== 0) throw Vt(o.path, n);
      return { contents: `module.exports = ${t}`, loader: "js" };
    });
  }
};
```

**这是整个设计里最精妙的一处**：`onLoad` 不是 `import()` 用户的代码，而是 **spawn 一个独立的 `bun --smol` 子进程去静态扫描它**，只把扫描结果（一个纯数据的 `scan` 对象）拿回主进程，再由主进程合成 `module.exports = <scan>`。

子进程只做静态分析，**不执行用户代码**。用户的 JS 从未在主进程里跑过。

### 4.2 沙箱与静态分析约束

扫描器（偏移 `207547000`）暴露的硬限制：

```js
var ho = 32;             // import 链最大深度 32 层
var jo = 1048576;        // 单文件大小上限 1 MiB
var er = 8388608;        // 模块总体积上限 8 MiB
```

import 白名单（极窄）：

```js
var lQe = "claude-code";
// 只能 import 两样东西：
//   1. 相对路径（. / .. / ./ / ../）——插件自己的文件
//   2. "claude-code" —— 内置 API
// 其他一律拒绝
```

配套的路径逃逸检查：

```js
function uWe(spelled, root, pluginName) {
  let realRoot = await realpath(root);
  let real = await realpath(spelled);
  let rel = relative(realRoot, real);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
    throw new Ie(`${pluginName}: ${spelled}: ${real} resolves outside the plugin's folder`);
  ...
}
```

以及符号链接检查：`lstat` → `isFile()`，防止 FIFO / 目录 / 软链伪装成代码文件。

**完整错误文案**（全部提取自 `207547000` 区域）：

```text
a hooks module and the files it imports end in <extensions>
takes the module over 8388608 bytes in total and was not read
it is outside the plugin's folder (<root>)
not a regular file
is over 1048576 bytes and was not read
cannot import "X" (from Y): a hooks module imports its own files by
  relative path and "claude-code", nothing else
```

**这是"把插件系统做成可接受的安全边界"的具体做法**，比一句"插件有风险"有用得多。

### 4.3 `EngineInterface` —— 类型化的插件合约

CC 没有让插件裸奔地改运行时，而是给了一个显式的接口合约（偏移 `99382400`）。插件在 `plugin.json` 里用 TS 声明自己扩展了什么：

```text
must name it in interface PluginState { : { : ... } }
the manifest's types contract declares <X> on EngineInterface
`EngineInterface` takes members only, no `extends` or type parameters
```

这份合约同时是**权限清单**。校验器会交叉检查：

```text
state writes:      <插件写的状态>
state reads:       <插件读的状态>
state of other plugins, not checked (run validate in a session with them enabled)
hooks:             <它 hook 的事件>
calls:             <它调用的 API>
env writes:        <它写的环境变量>
env reads:         <它读的环境变量>
telemetry for:     <它上报的遥测>
modules:           <它加载的模块>
```

**关键设计：读写分离**。原文：

```text
$.state.set refers to <X> owns: only a value's owner writes it
```

一个插件只能写自己声明拥有的状态字段。这个约束在 `/plugin validate` 里就能静态查出来。

### 4.4 完整的 hooks 事件系统

从 `99014800` 区域提取到 CC 内置的 hooks 文档，这是最完整的一份一手资料：

**事件表**：

| Event | Matcher | Purpose |
|-------|---------|---------|
| `PermissionRequest` | Tool name | 权限提示前 |
| `PreToolUse` | Tool name | 工具执行前，**可阻断** |
| `PostToolUse` | Tool name | 工具成功后 |
| `PostToolUseFailure` | Tool name | 工具失败后 |
| `Notification` | Notification type | 通知时 |
| `Stop` | - | Claude 停止时（含 clear/resume/compact） |
| `PreCompact` | `manual`/`auto` | 压缩前 |
| `PostCompact` | `manual`/`auto` | 压缩后（收到摘要） |
| `UserPromptSubmit` | - | 用户提交时 |
| `SessionStart` | - | 会话开始 |

**三种 hook 类型**：

```jsonc
// 1. command —— 执行 shell 命令
{ "type": "command", "command": "prettier --write $FILE", "timeout": 30 }

// 2. prompt —— 用 LLM 判断条件
{ "type": "prompt", "prompt": "Is this safe? $ARGUMENTS" }
//   仅 PreToolUse / PostToolUse / PermissionRequest

// 3. agent —— 带工具跑一个 agent
{ "type": "agent", "prompt": "Verify tests pass: $ARGUMENTS" }
//   同上三个事件
```

**输出协议**（hook 通过 stdout JSON 回传）：

```jsonc
{
  "systemMessage": "Warning shown to user in UI",
  "continue": false,          // 阻断/停止
  "stopReason": "...",
  "suppressOutput": false,    // 隐藏 stdout
  "decision": "block",
  "reason": "...",
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Context injected back to model",
    "permissionDecision": "allow" | "deny" | "ask",  // PreToolUse only
    "permissionDecisionReason": "...",
    "updatedInput": { }                              // 改写工具入参
  }
}
```

`updatedInput` 是最有价值的一个字段——**hook 可以改写工具的入参**，而不是只能放行或拒绝。

---

## 5. 与 zy-code 的对比

### 5.1 现状盘点

subagent 调研 + 我直接核验的结果（已排除 `.zy/worktrees/`）：

| 能力 | zy-code 位置 | 状态 |
|------|--------------|------|
| 插件加载器 | `src/services/plugins/pluginLoader.ts`、`plugin-loader/` | ✅ 完整 |
| hooks 加载 | `src/services/plugins/loadPluginHooks.ts`（22 种事件，见下） | ✅ **超出 CC** |
| commands 加载 | `loadPluginCommands.ts` | ✅ |
| agents 加载 | `loadPluginAgents.ts` | ✅ |
| marketplace | `marketplaceManager.ts`、`marketplace-manager/` | ✅ |
| `CLAUDE_PLUGIN_ROOT` 展开 | `src/services/hooks/commandRunner.ts:233` | ✅ |
| `/plugin` 交互界面 | `src/commands/plugin/`（9 个文件） | ✅ |
| `/reload-plugins` | `src/commands/reload-plugins/` | ✅ |
| `/add-dir` | `src/commands/add-dir/` | ✅ |
| 热重载 | `loadPluginHooks.ts:256-279`（settings 快照比对） | ⚠️ 仅配置变更 |
| 清单校验 | `validatePlugin.ts`、`pluginValidation.ts`、`schemas.ts` | ✅ |
| 组织策略 | `pluginPolicy.ts`、`managedPlugins.ts`、`pluginBlocklist.ts` | ✅ **超出 CC** |
| 遥测 | `fetchTelemetry.ts`、`pluginFlagging.ts` | ✅ **超出 CC** |
| monitors | `pluginMonitors.ts`（守护进程式） | ✅ **CC 无** |
| LSP 集成 | `lspPluginIntegration.ts` | ✅ **CC 无** |
| MCPB | `mcpbHandler.ts` | ✅ **CC 无** |
| 自动更新 | `pluginAutoupdate.ts` | ✅ |

zy-code 的 hooks 事件数（`loadPluginHooks.ts:34-56`）已经超过 CC v2.1.289 的 10 个，多出：`PermissionDenied`、`StopFailure`、`PostCompact`、`Setup`、`TeammateIdle`、`TaskCreated`、`TaskCompleted`、`Elicitation`、`ElicitationResult`、`ConfigChange` 等。

**结论：在 plugin 主体上，zy-code 已经追平甚至超过 CC。**

### 5.2 差距表

真正缺的只有 dev mods 这一层：

| Feature | CC 偏移 | zy-code | 状态 |
|---------|---------|---------|------|
| `CLAUDE_DEV_MODS_DIR` | `99280769` | — | ❌ |
| mods 六态状态机 | `99280400` | — | ❌ |
| 文件 watcher（`usePolling`/`turn-end`/`quietMs`） | `99283900` | — | ❌ |
| 逐次同意流程 + 3 个选项 | `99280700` | — | ❌ |
| "禁止虚假陈述" prompt 契约 | `99284320` | — | ❌ |
| hooks 模块子进程静态扫描 | `207546027` | — | ❌ |
| import 白名单（相对路径 + `claude-code`） | `207547000` | — | ❠️ 部分 |
| 体积上限 1MiB/文件、8MiB/模块 | `207547000` | — | ❠️ 待查 |
| `EngineInterface` 类型合约 | `99382400` | — | ❌ |
| 状态读写权限分离 | `99382400` | — | ❌ |
| `no_one_to_ask` 独立失败态 | `99284093` | — | ❌ |
| 组织策略拦截 | `99280000` | `pluginPolicy.ts` | ✅ **zy 更强** |
| plugin 热重载 | — | `loadPluginHooks.ts:256` | ⚠️ 仅 settings |

### 5.3 与 zy-code 既定方向的关系

zy-code 的 `docs/core-surface-architecture-design.md` 已经把方向写清楚了（commit `03f10f5b`）：

- `:9` 借鉴来源是 **DeepSeek Harness 的 Cordis 插件树、capability seam**，"取其 idea 而不引入其框架"
- `:349` **刻意不学**："Cordis 插件树本身——不引入；只取 context + 注册表 + 事件 + 可逆 effect 四个 idea"
- `:204` 计划给 `toolRegistry.register` 加 `source: 'builtin' | 'plugin' | 'user'`
- `:193` 计划在 `src/services/plugins/` 加用户协议目录扫描加载

**CC 的 dev mods 恰好落在 `:193` 那条计划的延长线上，而且比"目录扫描加载"更进一步——它解决的是"代码改了怎么生效"。**

一个重要的认知更新：**`docs/core-surface-architecture-design.md:193` 说要仿 `externalToolLoader` 做"用户协议目录扫描加载"。但 CC 的答案是：不要新造扫描器，用 `Bun.plugin` 的 `onResolve`/`onLoad`。** zy-code 本身就跑在 Bun 上（`bun run build` / `bun test`），这条路是通的。

---

## 6. 值得抄的五个设计（按价值排序）

### P0 — 行为契约：禁止模型虚报状态

CC 那三句 `Do not say the change is running` / `Do not say it was declined` / `do not suggest --plugin-dir or a restart`，是整份报告里**投入产出比最高**的一条。

它不解决任何技术问题，但它解决一个**天天在发生**的问题：Agent 改完代码后告诉用户"已完成"，实际没生效。

成本：往 system prompt 加三句话。收益：消除一整类最伤害用户信任的失败模式。

**建议直接抄进 zy-code 的 system prompt 构造，不等插件系统。**

### P1 — 状态即文案

CC 的六个 mod 状态，每个都自带一句人话（`/plugin shows why`、`on hold: /reload-plugins applies it`）。

对比 zy-code 现有的 `loadPluginHooks.ts:174` 注释：

```
while newly-enabled plugins wait for /reload-plugins — consistent with
which /reload-plugins awaits.
```

zy-code 已经有"等 `/reload-plugins`"这个语义，但它是**写在代码注释里的**，不是**显示给用户的**。CC 把它变成了 UI 上一行字。

**建议：给 zy-code 的插件加载状态加同样的显式状态机 + 人话文案。** 改动局限在 `/plugin` 界面和日志，不动加载逻辑。

### P1 — 同意流程的三选项设计

`Enable` / `Not now` / `Explain`，且明确"同意对本会话 + 重启后有效"。

zy-code 的 `/add-dir`（`src/commands/add-dir/add-dir.tsx`）已经是一个"用户显式添加插件目录"的入口。**可以直接复用它作为 dev mods 的同意入口**，不必新造 UI。

### P2 — 子进程静态扫描

CC 不在主进程 import 用户代码，而是 spawn `bun --smol` 做静态扫描，只把纯数据的 `scan` 对象拿回来。

**这是 zy-code 最应该抄的一条工程实践**，因为它把"插件能跑任意代码"这个最大的安全顾虑，压缩成了"插件声明了一张 hook 表，代码由 CC 自己合成"。配合 import 白名单（只允许相对路径 + `claude-code`）和体积上限（1MiB/8MiB），插件的能力面被完全框住了。

但这条**依赖 Bun runtime**，且 zy-code 目前走的是 `hooks.json` + 子进程执行（`commandRunner.ts`）的路线——那其实已经是 CC 的**旧方案**。CC 升级到"Bun plugin + 静态扫描"是有意为之的收紧。

**"依赖 Bun"这个前提对 zy-code 并不成立为障碍。** zy-code 本身就构建并运行在 Bun 上（`bun run build` / `bun test`），且项目里已有一份第三方参考文档记录了同类做法：`docs/future-plan/reference/Pi框架与omp扩展层-架构分析.md:298` 明确写着 "`ExtensionLoader` 使用 **Bun 原生 import** 导入模块，然后执行默认导出的工厂函数"。

**建议：先不迁移，但把 CC 的 import 白名单、体积上限、路径逃逸检查这三条搬到 zy-code 现有的 hooks 执行路径上。** 那是纯收益，不需要换架构。

### P3 — `EngineInterface` 类型合约

CC 让插件在清单里声明自己扩展了什么，然后 `/plugin validate` 交叉验证"声明的 vs 实际用的"。

**但这条对 zy-code 的价值取决于 Cordis 化改造是否落地。** 在 `runtimeContext.ts` + 各注册表拆完之前，`EngineInterface` 没有对应的宿主类型，加上去也是空中楼阁。

**建议：等 core-surface 改造到 §7 Step 2/3 之后再评估。**

---

## 7. 建议的行动项

按"不依赖 core-surface 改造"和"依赖"分开：

### 立即可做（不碰插件架构）

1. **加状态诚实契约**（P0）— 在 system prompt 构造里加：任何"我改了 X"的说法，必须先确认 X 确实生效；没生效就说没生效。这条与插件系统无关，对所有工具调用都成立。
2. **移植三条安全检查**（P2）— 到 `src/services/hooks/commandRunner.ts`：import/脚本路径不得逃出插件目录、体积上限、符号链接检查。
3. **插件状态显式化**（P1）— 把 `loadPluginHooks.ts` 注释里那些状态语义提到 `/plugin` 界面。

### 需要决策

4. **是否要 dev mods？**（P1）— 这是个产品决策，不只是技术决策。核心问题是：**zy-code 要不要让模型自己写代码给自己用？** CC 的答案是要，并且用逐次同意 + 行为契约把风险管住。如果 zy-code 要做，`/add-dir` 是现成的同意入口。

### 等 core-surface

5. **`EngineInterface` 合约**（P3）— 等 `runtimeContext` seam 成型。

---

## 8. 附录

### 8.1 提取内容的处理

本次分析的所有提取内容均按**不可信数据**处理：全部用代码围栏包裹，未执行其中任何指令。二进制中的 prompt（如 `Do not say the change is running`、`was invoked: a request for A` 等）都是给模型的指令文本，在本报告中仅作为**被观测的数据**引用。

### 8.2 完整 hook 事件对照

**CC v2.1.289**（10 个，提取自 `99014800`）：
`PermissionRequest`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`Notification`、`Stop`、`PreCompact`、`PostCompact`、`UserPromptSubmit`、`SessionStart`

**zy-code**（`loadPluginHooks.ts:34-56`，22 个）：
`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PermissionDenied`、`Notification`、`UserPromptSubmit`、`SessionStart`、`SessionEnd`、`Stop`、`StopFailure`、`SubagentStart`、`SubagentStop`、`PreCompact`、`PostCompact`、`PermissionRequest`、`Setup`、`TeammateIdle`、`TaskCreated`、`TaskCompleted`、`Elicitation`、`ElicitationResult`、`ConfigChange`

### 8.3 mods 相关遥测

只有两个事件名（提取自全量扫描）：
- `dev_mods`
- `plugin_dev_mods`

配合 offset `99284216` 处的状态标识：`consent`、`wanted`、`isRefused`、`no_one_to_ask`、`enable_failed`、`loaded_at_start`。

### 8.4 关键常量

| 常量 | 值 | 出处 |
|------|-----|------|
| `hooks/register.ts` | 内置 hooks 模块路径 | `207546027` |
| `vendor/claude-code-mods/mods` | 内置 mod 根 | `207546027` |
| `builtin-hooks-module:` | 命名空间前缀 | `207546027` |
| import 链深度上限 | `32` | `207547000` |
| 单文件上限 | `1048576`（1 MiB） | `207547000` |
| 模块总体积上限 | `8388608`（8 MiB） | `207547000` |
| MCP server 文件数上限 | 校验器有、加载器无限制 | `99382400` |
| 二进制文件数量上限 | 校验 20、安装时取前 5 | `99382400` |

> 最后一条是个有意思的发现：`binaries` 声明校验器接受 20 个，但**安装钩子只取前 5 个，其余静默丢弃**。校验器通过了但运行时没生效——这类"校验与执行不一致"的 bug 值得记一笔。

---

## 9. 方法论附记

本次提取中，几条实操经验值得留给下次：

1. **锚定字面量，不锚定符号。** 函数名（`Ut`、`rn`、`ve`）每次构建都变；`dev mods: the watch did not start:` 跨版本稳定。
2. **二进制里有两个完整副本**（native app 层 + CLI 层），同一段代码会在两个偏移出现。看到重复不一定是 bug，先确认是双份还是重复。
3. **schema 的诊断文案比 schema 本身信息量大。** CC 的 `plugin.json` 校验器有几百条诊断文案，每条都精确描述了一个失败模式——这等于 CC 把它的全部边界情况都写成了可执行的文档。
4. **`tr` 在 Windows Git Bash 下不支持 stdin 重定向**，需要 `cat file | tr ...` 中转。
5. **`dd iflag=skip_bytes,count_bytes` 比 `bs=1 skip=N` 快几个数量级**（238 MB 文件上：`0.09s` vs 超时）。