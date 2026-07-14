# Claude Code 2.1.208 / 2.1.209 分析与 zy-code 对齐计划

> **分析日期**：2026-07-14  
> **CC 版本**：2.1.209（本机已安装；同日含 2.1.208 大包）  
> **CC 二进制**：`D:\nvm\nvm4w\nodejs\node_global\node_modules\@anthropic-ai\claude-code\bin\claude.exe`  
> **大小**：251,303,072 bytes（约 239.7 MB）  
> **提取方法**：`.zy/skills/extract-claude-internal` + Node 字节扫描 + 官方 changelog + X 交叉验证  
> **本地证据目录**：`C:\Users\soleil\AppData\Local\Temp\cc-209-extract\`  
> **208 对照包**（可选）：`C:\Users\soleil\AppData\Local\Temp\cc-compare\package\claude.exe`（251,177,632 bytes）

---

## 总体结论

| 版本 | 性质 | 要点 |
|------|------|------|
| **2.1.208** | 大版本（同日） | a11y、vim 双键 remap、企业 process wrapper、性能/内存/安全/可靠性大量修复 |
| **2.1.209** | 当日 hotfix（约 +7h） | 仅修 bg 会话中 `/model` 等 dialog 被过宽 guard 误挡；bundle 约 +125KB |

**对 zy-code 的含义：**

1. 可抄能力以 **208 为主**；209 的教训是 **background 命令/dialog 门禁必须用窄名单，禁止 `local-jsx` 一刀切**。
2. X 上部分账号把「新增 bash tool / agent tool」写成 209 特性，属 **prompt 包统计噪声**；官方 CHANGELOG 与二进制均不支持为 209 新工具。
3. 相对本机曾装的 2.1.207：`vimInsertModeRemaps`、`CLAUDE_CODE_PROCESS_WRAPPER`、`CCR_ON_BRANCH_DEFAULT_GUARD` 为 208 真新增；`SRT_WIN_PATH` 在 208 起移除；screen reader 相关字符串在 207 bundle 中已存在，208 对外 GA。

---

## 1. 官方 Changelog

### 1.1 2.1.209（2026-07-14）

- Fixed `/model` and other dialogs being blocked in `claude agents` background sessions（**reverts an overly broad guard**）

### 1.2 2.1.208（2026-07-14）— 摘要

**新功能**

- Screen reader：`--ax-screen-reader` / `CLAUDE_AX_SCREEN_READER=1` / settings `"axScreenReader": true`
- `vimInsertModeRemaps`：INSERT 双键序列（如 `jj` → Escape）
- `CLAUDE_CODE_PROCESS_WRAPPER`：agent view / background service 的 self-spawn 走企业 launcher
- Fullscreen multi-select 与 "Other" 输入行支持鼠标点击

**性能 / 内存**

- 多 MCP 工具池装配缓存（高工具数最高约 7×）
- file edit read cache 上限 16MB（不再 pin 最多 1000 全文）
- transcript 体积下降（编辑重会话最高约 79×）；剪枝 superseded file-history backups
- permission deny/ask 规则 matcher 编译一次并缓存
- agent 任务列表更新不再整页重渲染
- MCP stdio stderr 界、LSP document LRU（50）、async hook / tool-result 泄漏修复

**安全**

- 含 `$(…)` / 反引号 / `<(…)` 的灾难性删除（如 `rm -rf ~`）在 `--dangerously-skip-permissions` 与 auto mode 下也要确认

**可靠性（节选）**

- fast mode 切回支持模型后自动恢复
- bg agent 回复投递失败落盘、重启后送达
- 更新替换二进制后 bg attach 不再永久失败
- auto-update 后 context window 误回 200k / 假 "100% context used"
- HTTP/2 GOAWAY 不崩溃会话
- `claude -p` 大 JSON/stream-json 不截断
- env 数值科学计数法（`1e6` 曾被当成 `1`）
- Edit：读后文件 mtime 变了但目标串仍唯一时允许编辑
- Read/Grep/Glob 边界；apiKeyHelper 错误可见；Bedrock gateway 文案；`/release-notes` 不注入模型上下文等

**其它**

- 完成的 bg agent 保留在 `/tasks` 直至 cleanup
- attach 停止中的 agent 立即显示 transcript
- 旧 daemon 不把新版本 worker 静默降到旧 binary
- `/install-github-app` 与 `/mcp` settings 菜单不在 background sessions 打开
- CLI surface：`--label`、`CCR_ON_BRANCH_DEFAULT_GUARD`；移除 `SRT_WIN_PATH`

完整列表见官方：[Claude Code changelog](https://code.claude.com/docs/en/changelog) / GitHub `CHANGELOG.md`。

---

## 2. X 社区信息（交叉验证）

| 来源 | 内容 |
|------|------|
| @ClaudeCodeLog | 208：45 CLI changes；209：1 CLI change；bundle +14.9 kB；prompt tokens 略降 |
| @oikon48 / @masayan_ai_hack | 208 日文完整摘录；208/209 合表 |
| @shima0hide 等 | 209 为 pin-point 热修：bg 中 `/model` 等 dialog |
| 部分二次传播 | 误将「bash tool / launch agent」标为 209 新功能 — **忽略** |

---

## 3. 二进制版本与字符串面

### 3.1 体积

| 版本 | 大小 |
|------|------|
| 2.1.207（分析初期） | 249,485,472 |
| 2.1.208（temp pack） | 251,177,632 |
| 2.1.209（当前安装） | 251,303,072 |
| 209 − 208 | **+125,440** bytes |

### 3.2 关键标识：207 → 208/209

| 标识 | 2.1.207 | 2.1.208/209 | 含义 |
|------|---------|-------------|------|
| `axScreenReader` / `--ax-screen-reader` / `CLAUDE_AX_SCREEN_READER` | 有 | 有 | screen reader surface（207 已埋点） |
| `isScreenReaderEnabled` / `onRenderScreenReader` | 有 | 有 | Ink 渲染分支 |
| `vimInsertModeRemaps` | **无** | **有** | 208 真新增 |
| `CLAUDE_CODE_PROCESS_WRAPPER` | **无** | **有** | 208 真新增 |
| `CCR_ON_BRANCH_DEFAULT_GUARD` | **无** | **有** | 208 surface |
| `SRT_WIN_PATH` | 有 | **无** | 208 移除 |
| `hasCommandSubstitution` / `catastrophic removal` | 部分 | 完整可还原 | 嵌套 rm 安全 |
| `isBgSession` | — | 有 | bg 会话判定（209 dialog 相关） |
| `mergeAndFilterTools` / `fastMode` / `GOAWAY` | 有 | 有 | 既有系统上的 fix/perf |

### 3.3 209 相关环境变量（节选）

```
CLAUDE_AX_SCREEN_READER
CLAUDE_CODE_PROCESS_WRAPPER
CLAUDE_CODE_SESSION_KIND
CLAUDE_CODE_DISABLE_MOUSE
CLAUDE_CODE_DISABLE_MOUSE_CLICKS
CLAUDE_CODE_MAX_OUTPUT_TOKENS
CLAUDE_CODE_DISABLE_FAST_MODE
…
# SRT_WIN_PATH — 不存在
```

---

## 4. 二进制还原：人可读逻辑

### 4.1 `vimInsertModeRemaps`（settings schema）

```ts
// settings 字段（约 offset 227406717 @ 2.1.209）
vimInsertModeRemaps: z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    'Vim INSERT-mode key-sequence remaps, e.g. {"jj": "<Esc>"}. ' +
      'Each key is exactly two printable characters typed in sequence; ' +
      '"<Esc>" (return to NORMAL mode) is the only supported target. ' +
      'Applies when editorMode is "vim".',
  )
```

**实现约束：**

- 仅 `editorMode === "vim"` 且处于 **INSERT**
- remap **键长固定 2 个可打印字符**
- 目标目前 **只支持 `"<Esc>"` → NORMAL**
- 例：`{ "jj": "<Esc>" }`

### 4.2 `CLAUDE_CODE_PROCESS_WRAPPER`

```js
// 核心：解析 env → argv / 错误；self-spawn 必须经 launcher
function resolveProcessWrapper() {
  const raw = process.env.CLAUDE_CODE_PROCESS_WRAPPER
  if (!raw) return emptyWrapper

  // Windows：无法对 claude 做 Unix-style exec → 忽略并 warn
  if (platform === 'windows') {
    return { argv: [], error: null, platformIgnored: true, record: '' }
  }

  const argv = shellSplit(raw)
  if (argv.length === 0) {
    return fail('value is set but contains no launcher …')
  }

  const launcher = argv[0]
  // 禁止把 wrapper 指到 claude 自己
  if (launcher === process.execPath || launcher === join(localBin, 'claude')) {
    return fail("launcher is Claude Code's own launch path …")
  }
  if (!isAbsolute(launcher)) {
    return fail('launcher must be an absolute path …')
  }
  return { argv, error: null, platformIgnored: false, record: raw }
}

async function isLauncherRunnable() {
  if (error) return false
  // stat + X_OK on argv[0]
}
```

**行为要点：**

- 企业用 **绝对路径** launcher
- **Windows 上该 env 被忽略**（binary 明确 warn）
- 错误配置时 **拒绝 unwrapped self-spawn**，不悄悄裸跑
- doctor/status：`Self-exec: \`${cmd} …\` (CLAUDE_CODE_PROCESS_WRAPPER)`；launcher 坏则拒绝新 bg session；daemon 与当前 session launcher 不一致则提示 restart

### 4.3 Screen reader

```js
// settings
screenReader: {
  buildGate: () => true,
  shape: () => ({
    axScreenReader: z.boolean().optional().describe(
      'Render screen-reader friendly output (flat text, no decorative borders or animations). ' +
        'Overridden by the CLAUDE_AX_SCREEN_READER env var and the --ax-screen-reader CLI flag.',
    ),
  }),
}

// Ink
this.isScreenReaderEnabled =
  options.isScreenReaderEnabled ??
  (!!stdout.isTTY && isTruthy(process.env.INK_SCREEN_READER))
// methods: onRenderScreenReader, computeScreenReaderPark, resetScreenReaderDiffState
// state: prevScreenReaderLines, prevScreenReaderPark
```

**优先级（由文案反推）：**  
`CLAUDE_AX_SCREEN_READER` / `--ax-screen-reader` **覆盖** settings 的 `axScreenReader`；另有 `INK_SCREEN_READER`、`CLAUDE_CODE_ACCESSIBILITY` 旁路。

### 4.4 灾难性删除 + 命令替换（安全）

AST 遍历 `command_substitution` / `process_substitution` / 特殊 `${|…}`，抽取内层命令，对 `rm`/`rmdir` 做危险路径检测：

```js
async function checkCatastrophicInsideSubstitutions(ast, cwd, /* … */) {
  const innerCmds = []
  walk(ast, (node) => {
    if (
      node.type === 'command_substitution' ||
      node.type === 'process_substitution' ||
      isPipeExpansion(node)
    ) {
      // 剥 $( )  ` `  <( )  ${ }
      innerCmds.push(stripAndTrim(node.text))
    }
  })

  if (innerCmds.length > 64) {
    if (/\brm(?:dir)?\b/.test(ast.text)) {
      return ask('too many command substitutions to analyze for catastrophic removals')
    }
    return null
  }

  for (const fragment of [ast.text, ...innerCmds]) {
    for (const cmd of splitCommands(fragment)) {
      // unset 变量展开成 root 的 rm → ask
      // simple 命令：rm/rmdir → isDangerousRemovalPath → behavior: "ask"
      // 嵌套 __CMDSUB__ 占位后再判一次
    }
  }
}
```

文案语义：

> Dangerous rm operation detected **inside command substitution**  
> requires explicit approval and **cannot be auto-allowed** by permission rules

在 **skip-permissions / auto** 下与 plain `rm -rf ~` **对齐强制 ask**。

### 4.5 209 对话框 guard：`isBgSession`

```js
function isHeadlessLike(ctx) {
  return ctx.isNonInteractiveSession || ctx.isBgSession === true
}
// 例：isHeadlessLike({ isNonInteractiveSession, isBgSession: Fi() })
```

| 阶段 | 策略 |
|------|------|
| 208 | 收紧 bg：`/install-github-app`、`/mcp` settings **不在 bg 打开** |
| 209 | 回退 **过宽** guard：`/model` 等合理 dialog **应可用** |

**产品规则：窄名单，不是 `local-jsx` 一刀切。**

| 命令类 | bg session |
|--------|------------|
| `/model`、轻量设置类 dialog | **应可用**（209） |
| `/install-github-app`、交互式 `/mcp` settings | **禁用**（208） |
| 仅终端/全屏专属 UI | 按能力再判 |

### 4.6 关于「209 新增 Bash/Agent 工具」

二进制中无对应新工具注册突变；@ClaudeCodeLog 的 prompt 高亮为打包/文案差异。zy-code 已有 Bash + Agent，**不必为 209 单独补工具**。

---

## 5. 与 zy-code 对照表

| 能力 | CC 2.1.209 | zy-code | 状态 |
|------|------------|---------|------|
| bg `/model` 等 dialog（209） | 窄 guard + `isBgSession` | `isBridgeSafeCommand` 对全部 `local-jsx` 挡桥；bg 路径需单独审 | **需对齐：禁止过宽** |
| `vimInsertModeRemaps` | schema + INSERT 双键 | `editorMode` / `src/vim/*` 有，无双键 remap | **缺失** |
| `PROCESS_WRAPPER` | 完整 launcher 逻辑 | 仅 installer 路径 | **缺失（P3；Win 可 noop）** |
| Screen reader | flag/env/settings + Ink | 仅注释，无 `axScreenReader` | **缺失** |
| 嵌套灾难性 `rm` | AST 内强制 ask | `isDangerousRemovalPath` + tree-sitter 有；未见对等「inside substitution」完整路径 | **需审计/补强** |
| Tool-pool 缓存 | 会话级 ~7× | `useMergedTools` 每变重算 `assembleToolPool` | **可优化** |
| Env 科学计数法 | 208 修 `1e6` | 多处 `parseInt(env, 10)` | **有同类风险** |
| Edit 唯一匹配 | 208 fix | 需对照 Edit 工具 | **审计** |
| FileHistory 界 | 16MB / 剪枝 | `MAX_SNAPSHOTS=100` | **部分** |
| Multi-select 鼠标 | 208 fullscreen | Ink mouse 有基础 | **部分** |
| MCP stderr / LSP LRU | 有 cap | 需查 | **审计** |

相关源码锚点：

- `src/commands.ts` — `isBridgeSafeCommand` / `local-jsx`
- `src/utils/toolPool.ts` / `src/hooks/useMergedTools.ts` — 工具池
- `src/services/permissions/pathValidation.ts` — `isDangerousRemovalPath`
- `src/shell-eval/bash/treeSitterAnalysis.ts` — `hasCommandSubstitution` 等
- `src/tools/BashTool/*` — bash 权限与安全
- `src/vim/*` / `src/components/PromptInput/*` — vim INSERT
- `src/utils/fileHistory.ts` — 快照上限
- `src/utils/context.ts` — `MODEL_CONTEXT_WINDOW_DEFAULT = 200_000` 等

---

## 6. 补全方案（优先级）

### P0 — 安全与正确性

#### P0-1 命令替换内灾难性删除

- 在 Bash 权限管线复用 tree-sitter / AST：
  - 收集 `command_substitution` / `process_substitution` / 反引号内层
  - 内层 `rm`/`rmdir` → `isDangerousRemovalPath`
  - **`bypassPermissions` / auto 下仍 `behavior: "ask"`**（不可 rule 自动 allow）
  - 替换数量 >64 且含 `rm` → 直接 ask
- 测试：`echo $(rm -rf ~)`、`` echo `rm -rf /` ``、`rm -rf $UNSET/*`、plain `rm -rf ~`

#### P0-2 安全 env 数值解析

```ts
/** 拒绝 parseInt("1e6", 10) === 1 一类静默截断 */
function parseEnvNumber(raw: string | undefined): number | undefined {
  if (raw == null || raw === '') return undefined
  if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(raw.trim())) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}
```

用于 `ZY_CODE_MAX_OUTPUT_TOKENS`、并发、retry 等。

#### P0-3 Edit：mtime 变了但唯一匹配仍成功

- 磁盘上 `old_string` 仍唯一 → 允许替换；非唯一再失败。

### P1 — UX / 会话模型（含 209 教训）

#### P1-1 Background 命令门禁：窄名单

- 引入 `isBgSession`（或 `SESSION_KIND === 'bg'`）
- **禁止**（208）：`/install-github-app`、交互式 `/mcp` settings 等
- **允许**（209）：`/model`、`/effort`、主题类轻 dialog
- 桥接侧可继续挡 remote 的 `local-jsx`，但 **attach 到 bg 的本地 TUI** 不要复用「全禁」策略

#### P1-2 Screen reader

- CLI：`--ax-screen-reader`
- Env：`ZY_AX_SCREEN_READER`
- Settings：`axScreenReader`
- Ink：`isScreenReaderEnabled`、扁平渲染、去装饰、`screenReaderLabel`、i18n 中英同步

#### P1-3 `vimInsertModeRemaps`

- settings 与 CC 一致（仅 2 字符 → `"<Esc>"`）
- INSERT 输入缓冲 1–2 键；超时/其它键冲刷
- 文档 + `/config` 展示

#### P1-4 Multi-select / Other 行鼠标点击（fullscreen）

### P2 — 性能与长会话

| 项 | 做法 |
|----|------|
| Tool-pool 缓存 | `assembleToolPool` 按 `(mode, mcp fingerprint, deny-rules hash)` memo |
| Permission matcher 缓存 | deny/ask glob 编译一次 |
| Edit/read 内容缓存 | 字节上限（如 16MB）+ LRU |
| Transcript / checkpoint 剪枝 | 删除 superseded file-history backup |
| MCP stderr ring + LSP doc LRU(50) | 防长会话泄漏 |
| 大 markdown table | 前 200 行 + `… N more rows` |

### P3 — 企业 / 边缘

| 项 | 做法 |
|----|------|
| `ZY_CODE_PROCESS_WRAPPER` | 非 Windows：self-spawn/daemon 走 absolute launcher；X_OK；doctor 展示；Windows ignore + warn |
| `--label` / `CCR_ON_BRANCH_*` | 有 CCR/agent 产品需求再做 |
| Bedrock/gateway 文案 | 按 provider 需要 |

---

## 7. 建议 PR 切分

| PR | 范围 | 复杂度 |
|----|------|--------|
| **PR-A** | 命令替换内灾难性 `rm` + env 安全解析 + 单测 | 中 |
| **PR-B** | Edit 唯一匹配 + Read/Grep/Glob 边界审计 | 中 |
| **PR-C** | `isBgSession` + **窄** 命令/dialog 门禁（209 教训） | 中 |
| **PR-D** | `vimInsertModeRemaps` | 中 |
| **PR-E** | Screen reader 全链路 | 高 |
| **PR-F** | tool-pool / matcher / 内存 cap | 中 |
| **PR-G**（可选） | `PROCESS_WRAPPER` | 中 |

---

## 8. 本地证据与复跑

| 路径 | 内容 |
|------|------|
| `C:\Users\soleil\AppData\Local\Temp\cc-209-extract\` | 209 字符串报告、功能 dump、island 还原 |
| `...\deep_catastrophic_js.txt` / `island_cat.txt` | 嵌套 rm 分析 JS |
| `...\deep_self_spawn.txt` / `deep_processWrapper_js.txt` | process wrapper |
| `...\js_vim_2.txt` | vimInsertModeRemaps schema |
| `C:\Users\soleil\AppData\Local\Temp\cc_scan.mjs` 等 | 可复跑扫描脚本 |
| `C:\Users\soleil\AppData\Local\Temp\cc-compare\package\claude.exe` | 2.1.208 对照二进制 |

```powershell
# 扫描当前安装的 claude.exe（需自备扫描脚本）
node C:\Users\soleil\AppData\Local\Temp\cc209_scan.mjs
```

---

## 9. 一句话结论

- **2.1.209** ≈ 当日热修：bg 会话 dialog **勿过宽拦截**。  
- **可移植能力在 2.1.208**，且 **209 二进制已全部包含**。  
- **zy-code 优先**：(1) 嵌套灾难性删除强制确认；(2) env 科学计数法；(3) bg/dialog 窄名单；(4) vim `jj→Esc` + screen reader + tool-pool 缓存。

---

## 变更记录

| 日期 | 说明 |
|------|------|
| 2026-07-14 | 初稿：X + changelog + 2.1.207 基线 + 2.1.209 二进制还原 + zy-code 对照与 PR 计划 |
| 2026-07-14 | 补充延迟完成的 208 pack 体积对比（209 路径曾被误标为 207） |
