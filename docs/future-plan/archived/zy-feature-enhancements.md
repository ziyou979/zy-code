# ZY Code Feature 启用与功能增强

> 更新时间：2026-05-02
> 基线版本：Claude Code v2.1.83~88

本文记录 ZY Code 在分叉基础上启用的 4 个 Claude Code 功能 + 2 项自研增强。

---

## 1. 总览

| # | 功能 | 类型 | 改动文件数 | 说明 |
|---|------|------|-----------|------|
| 1 | FORK_SUBAGENT | Feature 启用 | 3 | Agent 默认 fork 父上下文、异步后台运行 |
| 2 | REACTIVE_COMPACT | Feature 启用 | 1 | 压缩策略从"主动预防"变为"被动恢复" |
| 3 | TOKEN_BUDGET | Feature 启用 | 1 | 用户可设定 token 预算，追踪输出消耗 |
| 4 | CONTEXT_COLLAPSE | 完整实现（原为 stub） | 5 | 细粒度上下文折叠，按 API round 逐步压缩 |
| 5 | 语言感知 Token 估算 | 自研增强 | 2 | 中文等 CJK 语言的 token 估算自动校正 |
| 6 | 终端文件路径超链接 | 自研增强 | 1 | 自动检测 file:line 模式并转为可点击超链接 |

**编译时门控**：全部 feature 通过 `build.ts` 的 `features` 数组控制：

```typescript
// build.ts line 29-37
features: [
  'TRANSCRIPT_CLASSIFIER',
  'FORK_SUBAGENT',
  'REACTIVE_COMPACT',
  'TOKEN_BUDGET',
  'CONTEXT_COLLAPSE',
],
```

`feature()` 是 Bun 的原生编译时 DCE 机制，`bun build` 时将 feature flag 静态解析为 `true`/`false`，死代码路径被 Tree-shaking 移除。

---

## 2. FORK_SUBAGENT（Fork 子代理）

### 2.1 功能说明

所有 Agent spawn 默认以 **fork 模式**运行：
- 子 agent **继承父进程的完整上下文**（消息历史、工具集、模型配置）
- 默认**异步后台执行**，通过 `<task-notification>` 通知主进程结果
- `/fork <directive>` 命令可用（手动触发 fork）
- Agent 工具的 `subagent_type` 参数变为可选，省略时自动 fork

### 2.2 改动文件

| 文件 | 改动 | 说明 |
|------|------|------|
| `build.ts` | line 33 | 添加 `'FORK_SUBAGENT'` |
| `src/components/messages/UserForkBoilerplateMessage.tsx` | 新建 | 渲染 fork boilerplate 消息标记 |
| `src/tools/AgentTool/AgentTool.ts` | 行为变更 | `subagent_type` 变为可选 |

### 2.3 关键实现细节

**UserForkBoilerplateMessage.tsx** 的注意事项：
- **不能导入 `ink` 包** — 因为调用方 `UserTextMessage.tsx` 通过同步 `require()` 加载此模块，而 ink 的 reconciler 包含 top-level await，Bun bundler 不允许 sync require 传递到含 TLA 的模块
- 因此使用 `React.createElement(React.Fragment, null, param.text)` 纯 React API 渲染
- 布局和样式由父容器组件处理

### 2.4 安全性

所有 import 和 call site 均已被源码中的 `feature('FORK_SUBAGENT')` 守卫。若未来从 `features` 数组中移除此项，相关代码会被完全 DCE 移除，不产生运行时开销。

---

## 3. REACTIVE_COMPACT（被动压缩）

### 3.1 功能说明

压缩策略从"主动预防"变为"被动恢复"：
- **旧行为**：token 使用率达到阈值时主动触发压缩
- **新行为**：等待 API 返回 413 (prompt too long) 后才触发压缩
- 消息按 API round 分组，逐组剥离并生成摘要
- 需要 GrowthBook 运行时 flag `zy_cobalt_raccoon` 设为 `true` 才实际生效

### 3.2 改动文件

| 文件 | 改动 | 说明 |
|------|------|------|
| `build.ts` | line 34 | 添加 `'REACTIVE_COMPACT'` |

### 3.3 与 CONTEXT_COLLAPSE 的协作

两者可共存，优先级为：
1. **Context collapse** 先尝试细粒度折叠（按 span 逐个折叠）
2. 折叠失败或不足以解决问题时，**reactive compact** 作为兜底

### 3.4 注意事项

- 如果 GrowthBook 不可用，`isReactiveCompactEnabled()` 返回 `false`，行为退化为与未启用时一致
- 当 GB 可用但 flag 为 `false` 时，同样不会触发被动压缩
- 这意味着在 ZY Code 的外部构建中，需要 GB 端点正确返回 `zy_cobalt_raccoon=true` 才能体验此功能

---

## 4. TOKEN_BUDGET（Token 预算）

### 4.1 功能说明

用户可设定 token 消费预算，系统追踪消耗并在预算不足时自动续接：
- **设定预算**：用户输入 `+500k`、`spend 2M tokens` 等语法
- **消耗追踪**：每轮 API 响应的 output token 计入已消耗
- **自动续接**：低预算时自动延长会话
- **退火检测**：连续 3+ 次续接且增量 < 500 token 则停止（防止死循环）
- **系统提示**：自动追加 token budget 指导段落

### 4.2 改动文件

| 文件 | 改动 | 说明 |
|------|------|------|
| `build.ts` | line 35 | 添加 `'TOKEN_BUDGET'` |

### 4.3 关键实现

核心逻辑在 `src/query/tokenBudget.ts`（源码已有，编译时启用）：
- `createBudgetTracker()` — 初始化预算追踪
- `checkTokenBudget()` — 每轮查询后检查预算状态

---

## 5. CONTEXT_COLLAPSE（上下文折叠）

### 5.1 功能说明

当对话上下文接近 token 限制时，将旧消息 span 折叠为摘要占位符。与 auto-compact 的关键区别：

| 维度 | auto-compact | context collapse |
|------|-------------|-----------------|
| 粒度 | 单次大摘要替换全部旧消息 | 多个小 span 逐批折叠 |
| 触发时机 | 主动（token 达到阈值前） | 被动（85% 使用率时暂存，413 时排出） |
| 摘要方式 | 单次 API 调用生成 | 轻量预摘要 + fork agent 确认 |
| 边界对齐 | 任意位置 | 按 API round 边界（不破坏 tool_use/tool_result 配对） |
| 可恢复性 | 不可逆 | 支持从 transcript 恢复折叠状态 |

### 5.2 架构

```
src/services/contextCollapse/
├── index.ts       # 模块级状态 + 主入口函数（~370 行）
├── operations.ts  # 消息投影/折叠变换（~140 行）
└── persist.ts     # 从 transcript 恢复状态（~80 行）
```

### 5.3 模块级状态（index.ts）

| 状态 | 类型 | 说明 |
|------|------|------|
| `commits` | `CommittedCollapse[]` | 已提交的折叠 span 列表 |
| `staged` | `StagedSpan[]` | 暂存待折叠队列 |
| `idCounter` | `number` | collapseId 自增计数器（16 位） |
| `health` | `Health` | 运行健康指标（spawn 次数、错误数等） |
| `subscribers` | `Set<() => void>` | 状态变更订阅者 |

**阈值常量**：
- `COLLAPSE_THRESHOLD = 0.85` — 使用率达到 85% 时触发暂存
- `MIN_KEPT_ROUNDS = 4` — 折叠时至少保留最近 4 个 API round

### 5.4 核心函数

#### `applyCollapsesIfNeeded(messages, toolUseContext, querySource)`

每次 API 调用前执行：
1. 用 `tokenCountWithEstimation(messages)` 计算当前 token 数（含语言校正）
2. 获取 context window 大小，计算使用率
3. 若 >= 85%：找到最旧的可折叠 span（保留最近 4 个 round），创建 `StagedSpan`
4. 调用 `projectView(messages)` 将已提交的折叠替换为占位消息
5. 通过 `recordContextCollapseSnapshot()` 持久化快照
6. 返回投影后的消息列表

#### `recoverFromOverflow(messages, querySource)`

413 错误恢复：
1. 从暂存队列取出最旧的 span
2. 在消息列表中定位 span 范围
3. 生成摘要占位消息（含 16 位 collapseId）
4. 创建 `CommittedCollapse` 加入 commits
5. 从消息列表移除归档消息，插入占位消息
6. 通过 `recordContextCollapseCommit()` 持久化
7. 返回缩短后的消息列表

#### `isWithheldPromptTooLong(message, isPromptTooLongFn, querySource)`

拦截 prompt-too-long 错误：当有暂存 span 可排出时返回 `true`。

#### `projectView(messages, collapseEntries)` (operations.ts)

只读投影：
- 遍历消息，按 UUID 范围匹配每个折叠 entry
- 跳过 firstArchivedUuid ~ lastArchivedUuid 之间的所有消息
- 插入 summaryContent 占位消息
- 不修改原数组

#### `restoreFromEntries(entries, snapshot)` (persist.ts)

Session 恢复：
- 回放 commit entries 重建 `commits` 数组
- 从 snapshot 重建 `staged` 队列
- 恢复 `idCounter`（确保新 ID 不与历史冲突）

### 5.5 循环依赖处理

存在以下潜在循环：
```
index.ts → autoCompact.ts (需要 getEffectiveContextWindowSize) → index.ts (需要 isContextCollapseEnabled)
```

解决方案：
- `isContextCollapseEnabled` 通过 `require()` 动态导入
- index.ts 中 token 估算和其他模块依赖使用函数体内的 `await import()`，而非顶层静态 import
- persist.ts 使用 `await import('./index.js')` 访问内部函数（`_addCommit`、`_addStaged`、`_reseedIdCounter`）

### 5.6 配套工具

**CtxInspectTool** (`src/tools/CtxInspectTool/CtxInspectTool.ts`)：
- 允许模型查询折叠状态
- 输入：`collapse_id`（16 位 ID）
- 输出：折叠状态统计（collapsed/staged span 数量）

### 5.7 注意事项

- **持久化依赖 sessionStorage API**：`recordContextCollapseCommit` 和 `recordContextCollapseSnapshot`
- **fork agent 未实际使用**：当前 `recoverFromOverflow` 使用轻量预摘要，后续可改为用 fork agent 生成完整摘要
- **线程安全**：模块级状态为单线程访问（Node.js 事件循环），无需锁

---

## 6. 语言感知 Token 估算

### 6.1 问题背景

`roughTokenCountEstimation` 使用固定 `bytesPerToken = 4` 估算所有语言的 token 数。这对英语（拉丁语系）是合理的，但中文等 CJK 语言的字符/token 比率差异显著：

| 语言 | 实际 bytes/token | 默认估算 | 误差 |
|------|-----------------|---------|------|
| 英语/拉丁语系 | ~4 | 4 | 接近准确 |
| 中文 | ~1.5 | 4 | **低估 2.7 倍** |
| 日语 | ~2 | 4 | **低估 2 倍** |
| 韩语 | ~2.5 | 4 | **低估 1.6 倍** |

中文场景下，如果 token 估算被低估 2.7 倍，系统可能：
- 过晚触发上下文压缩（以为还有空间，实际已接近上限）
- 发送超出 context window 的请求导致 413 错误

### 6.2 实现方案

#### `getBytesPerTokenForLanguage(language?)` — `src/services/tokenEstimation.ts:170`

```typescript
function getBytesPerTokenForLanguage(language?: string): number {
  if (!language) return 4                        // 默认英语
  const lang = language.toLowerCase().trim()
  if (lang.includes('chinese') || lang.includes('中文') ||
      lang === 'zh' || lang.startsWith('zh-')) return 1.5
  if (lang.includes('japanese') || lang.includes('日本語') ||
      lang.startsWith('ja-')) return 2
  if (lang.includes('korean') || lang.includes('한국어') ||
      lang.startsWith('ko-')) return 2.5
  return 4                                       // 拉丁语系
}
```

#### `tokenCountWithEstimation(messages)` — `src/utils/tokens.ts:229`

```typescript
const settings = getInitialSettings()
const languageBpt = getBytesPerTokenForLanguage(settings.language)
const correctionFactor = 4.0 / languageBpt  // 默认比率 / 语言实际比率

return baseTokens + Math.round(
  roughTokenCountEstimationForMessages(...) * correctionFactor
)
```

**校正逻辑**：
- 从 `settings.json` 的 `language` 字段读取用户配置的语言
- 计算 `correctionFactor = 4.0 / languageBpt`（中文场景为 4.0/1.5 ≈ 2.67）
- 仅对粗估算部分应用校正因子（API 返回的 usage token 数是精确的，不予调整）

### 6.3 影响范围

`tokenCountWithEstimation` 是以下模块的 token 计算入口：
- `applyCollapsesIfNeeded` — context collapse 触发判断
- `autoCompact.ts` — 主动压缩阈值判断
- `microCompact.ts` — 微压缩判断
- `sessionMemoryCompact.ts` — session memory 触发判断
- 所有压缩/折叠决策点自动获得语言感知能力

### 6.4 注意事项

- **API 返回的 usage token 不调整**：API 返回的 `inputTokens`/`outputTokens` 是后端实际计数，始终精确
- **仅影响粗估算部分**：`roughTokenCountEstimation` 和 `roughTokenCountEstimationForMessages` 的返回值被校正
- **无配置时默认英语**：`language` 为空或未识别时 `bytesPerToken = 4`，与原有行为一致
- **语言匹配使用子串匹配**：`includes('chinese')` 可匹配 `"Chinese"`、`"Simplified Chinese"` 等多种写法
- **code 块不单独处理**：代码块（英文为主）在消息中与中文混合，当前统一按语言设置估算。后续可细化到 block 粒度

---

## 7. 终端文件路径超链接

### 7.1 功能说明

当助手输出的文本中包含形如 `src/foo.ts:123` 或 `/abs/path/file.ts:10-20` 的文件引用时，CLI 会自动将其转换为可点击的 OSC 8 超链接（`file://` 协议）。

在支持 OSC 8 的终端（iTerm2、kitty、Ghostty、WezTerm、Warp、Windows Terminal 等）中，用户按住 Cmd/Ctrl 点击文件路径即可跳转到 IDE 对应文件的指定行号。

### 7.2 实现原理

**基础设施（已存在，无需改动）**：

| 文件 | 职责 |
|------|------|
| `src/utils/hyperlink.ts` | `createHyperlink(url, content?)` — 生成 OSC 8 转义序列 `\x1b]8;;URL\x07TEXT\x1b]8;;\x07` |
| `src/ink/supports-hyperlinks.ts` | `supportsHyperlinks()` — 检测当前终端是否支持 OSC 8 |
| `src/ink/output.ts` | 底层 Grapheme 聚类渲染，已处理 OSC 8 前缀 |
| `src/ink/optimizer.ts` | 相邻同 URL 超链接自动合并，减少 OSC 8 序列冗余 |
| `src/components/FilePathLink.tsx` | React 组件，将绝对文件路径转为 `file://` URL（用于工具 UI 组件） |

**新增改动**（`src/utils/markdown.ts`）：

在 markdown 文本渲染管线中新增 `linkifyFilePaths()` 函数，与已有的 `linkifyIssueReferences()` 并列调用：

```
原始文本 → marked.lexer() → formatToken() →
  'text' case → linkifyFilePaths(linkifyIssueReferences(text))
```

**正则模式**：

```regexp
/(^|[^\w.\/-])((?:(?:\.\.\/|\.\/|\/)?(?:[\w.-]+\/)*)[\w.-]+\.\w{1,10}):(\d+)(?:-(\d+))?/g
```

| 捕获组 | 含义 | 示例 |
|--------|------|------|
| `$1` | 边界前缀（空格、括号等） | `(` → `(` |
| `$2` | 文件路径（相对或绝对） | `src/components/foo.tsx` |
| `$3` | 起始行号 | `123` |
| `$4` | 结束行号（可选，范围模式） | `125` |

**匹配示例**：

| 输入 | 是否匹配 | 说明 |
|------|----------|------|
| `src/foo.ts:123` | ✓ | 相对路径 + 行号 |
| `/Users/me/project/file.go:42` | ✓ | 绝对路径 + 行号 |
| `./relative/file.py:10-20` | ✓ | `./` 前缀 + 行号范围 |
| `../parent/file.rs:1` | ✓ | `../` 前缀 |
| `file.ts:123` | ✓ | 无目录前缀 |
| `src/dir/my-file_utils.test.ts:99` | ✓ | 含连字符和下划线 |
| `src/foo.ts` | ✗ | 无行号（太容易误匹配） |
| `https://example.com:8080` | ✗ | 无文件扩展名 |
| `10:30` | ✗ | 无文件扩展名 |
| `owner/repo#123` | ✗ | 走 `linkifyIssueReferences` |

**超链接生成**：

```typescript
const url = pathToFileURL(filePath).href
// "src/foo.ts" → "file:///Users/zy979/IdeaProjects/zy-code/src/foo.ts"
// "/abs/path.ts" → "file:///abs/path.ts"

const display = `${filePath}:${line}${endLine ? `-${endLine}` : ''}`
// "src/foo.ts:123"

return createHyperlink(url, display)
// 输出: \x1b]8;;file:///Users/.../src/foo.ts\x07src/foo.ts:123\x1b]8;;\x07
```

相对路径通过 Node.js 的 `pathToFileURL()` 自动基于 `process.cwd()` 解析为绝对路径。

### 7.3 适用场景

| 场景 | 是否生效 | 说明 |
|------|----------|------|
| 助手文本消息（正文） | ✓ | `AssistantTextMessage.tsx` → `Markdown` → `formatToken` |
| 助手文本消息（列表项） | ✓ | 同上，list_item 路径也调用 |
| 工具调用结果（FileRead/Edit/Write 等） | ✓ | 已有 `FilePathLink` 组件显式处理 |
| Shell/Bash 输出 | ✗ | 走 `OutputLine.tsx` 的 `linkifyUrlsInText()`，仅匹配 HTTP URL |
| Markdown 链接内部 | ✗ | 防止 OSC 8 嵌套（终端会取最内层 URL，覆盖原链接） |
| 终端不支持 OSC 8 | ✗ | `supportsHyperlinks()` 返回 `false` 时直接返回原文 |

### 7.4 终端兼容性

| 终端 | 支持状态 | 备注 |
|------|----------|------|
| iTerm2 (macOS) | ✓ 完全支持 | 需在 Preferences → General → Magic 中确认启用 |
| kitty | ✓ 完全支持 | 默认支持 |
| Ghostty | ✓ 完全支持 | 默认支持 |
| WezTerm | ✓ 完全支持 | 默认支持 |
| Warp | ✓ 完全支持 | 默认支持 |
| Windows Terminal | ✓ 完全支持 | 默认支持 |
| VSCode 内置终端 | ✓ 支持 | 需 `terminal.integrated.enableLinks` 开启 |
| JetBrains 内置终端 | ✓ 支持 | IDEA/WebStorm 等的内置终端支持 |
| macOS Terminal.app | ✗ 不支持 | 原生终端不支持 OSC 8 |
| tmux | ⚠️ 有限支持 | tmux 3.4+ 可配置 `allow-passthrough on` |
| screen | ✗ 不支持 | — |

当 `supportsHyperlinks()` 返回 `false` 时，`linkifyFilePaths()` 直接返回原始文本，文件路径以普通文本显示，不可点击。不会报错，不会出现乱码。

### 7.5 注意事项

**路径解析依赖 CWD**：`pathToFileURL(relativePath)` 基于进程的当前工作目录解析相对路径。CLI 进程的 CWD 通常即用户执行 `zy` 命令的目录（项目根目录），因此相对路径解析结果通常是正确的。但如果用户在对话中切换工作目录（通过 `cd` 命令），或助手引用的相对路径基于不同的基准目录，则生成的 `file://` URL 可能指向错误的绝对路径。

**后续改进方向**：可在 `linkifyFilePaths` 中利用 session 的 project root 信息（如 `getInitialSettings().projectRoot`）来解析相对路径，而非依赖 `process.cwd()`。

**文件扩展名限制**：正则要求文件名带 1-10 位字母数字扩展名，以下情况不会匹配：
- 无扩展名的文件：`Makefile:10`、`Dockerfile:5`
- 过长扩展名：罕见情况（当前限制 10 位）
- 含特殊字符的扩展名：极少见

这属于有意为之的权衡——放宽扩展名限制会增加误匹配率（如 `foo:bar` 这类非文件文本）。

**行号范围格式**：仅支持 `起始行-结束行` 格式（如 `:10-20`），不识别 `:10,20`（逗号分隔）、`:10:20`（双冒号）、`:L10-L20`（L 前缀）等格式。这些格式在 CI/CD 和编译输出中常见，但在代码助手上下文中不常用，暂不处理。

**IDE 跳转行为**：点击 `file://` 超链接后的行为取决于终端和操作系统的配置。macOS 通常由关联的文件类型默认应用打开（如 `.ts` → VS Code）。若要精确跳转到指定行号，终端需支持将 `file://` URL + 行号信息传递给 IDE（当前 URL 中行号为显示文本，不在协议中）。如需 ANSI terminal hyperlink 携带行列信息，可考虑扩展为 `file:///path#L123` 或 `txmt://open?url=file://...&line=123` 格式。

**性能影响**：正则匹配在每次文本 token 渲染时执行。对于正常大小的助手回复（几百到几千字符），性能影响可忽略。正则使用显式字符类（无 lookbehind/backreference），确保 JSC（JavaScriptCore）的 YARR JIT 编译器能高效执行。

---

## 8. 构建与验证

### 8.1 构建命令

```bash
bun run build:cli   # 产物: dist/cli.js (~23.7 MB)
```

### 8.2 验证清单

| 检查项 | 方法 |
|--------|------|
| 类型检查通过 | `bun tsc --noEmit` |
| 构建成功 | `bun run build:cli` |
| FORK_SUBAGENT 已启用 | 产物中搜索 `subagent_type` → 应为可选参数 |
| TOKEN_BUDGET 已启用 | 产物中搜索 `tokenBudget` → 应有对应逻辑 |
| CONTEXT_COLLAPSE 已启用 | 产物中搜索 `applyCollapsesIfNeeded` |
| 中文 token 估算 | 设置 `language: "zh-CN"` 后 token 估算值约为之前的 2.67 倍 |
| 文件路径超链接 | 助手输出 `src/foo.ts:123` 时在 iTerm2 中可 Cmd+点击跳转 |

---

## 9. 相关文件索引

```
build.ts                                  ← feature flags 编译时门控
src/services/contextCollapse/index.ts     ← 上下文折叠核心
src/services/contextCollapse/operations.ts← 消息投影/折叠变换
src/services/contextCollapse/persist.ts   ← 持久化恢复
src/services/tokenEstimation.ts           ← getBytesPerTokenForLanguage()
src/utils/tokens.ts                       ← tokenCountWithEstimation() 语言校正
src/utils/markdown.ts                     ← linkifyFilePaths() 文件路径超链接
src/utils/hyperlink.ts                    ← createHyperlink() OSC 8 工具
src/tools/CtxInspectTool/CtxInspectTool.ts← 折叠状态查询工具
src/components/messages/UserForkBoilerplateMessage.tsx ← Fork 消息渲染
```
