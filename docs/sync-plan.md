# ZY Code 同步方案：基线 v2.1.88 → 最新特性同步

> **文档版本**: v1.1  
> **创建时间**: 2026-05-16  
> **维护者**: 远空 (朱鹏宇)  
> **基线版本**: v2.1.88（fork 版本）  
> **目标版本**: 对齐 v2.1.143+ 特性  
> **数据来源**: `docs/Claude_Code_Changelog_2.1.88_to_Latest.md` + 代码库调研

---

## ⚠️ 品牌中立原则（全文约束）

**zy-code 是中立的多模型 AI 编程工具，非任何单一厂商的定制版本。** 所有同步改动必须遵守：

1. **环境变量前缀统一使用 `ZY_CODE_`**，禁止出现 `CLAUDE_CODE_`、`CLAUDE_`、`ANTHROPIC_` 等厂商定制字眼
2. **模型能力通过配置驱动**，不硬编码任何特定模型名称（如 "Claude Opus 4.6"），而是通过 `model-capabilities.json` 或 settings 中的模型能力描述来定义上下文窗口、功能开关等
3. **API 适配层保持中立**，Provider 特定逻辑仅限 `src/services/api/conversions/*` 和适配器文件内
4. **Feature Flag 前缀统一使用 `zy_`**（已执行，见 `FEATURE_FLAGS.md`）
5. **用户可见文本走 i18n**，禁止硬编码品牌名

### 环境变量映射表

以下是原始环境变量到 zy-code 中立命名的映射：

| 原始名称（禁止使用） | ZY Code 中立名称 | 用途 |
|---------------------|-----------------|------|
| `CLAUDE_CODE_NO_FLICKER` | `ZY_CODE_NO_FLICKER` | 无闪烁替代屏幕渲染 |
| `CLAUDE_CODE_PERFORCE_MODE` | `ZY_CODE_PERFORCE_MODE` | Perforce 集成模式 |
| `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` | `ZY_CODE_SUBPROCESS_ENV_SCRUB` | 子进程环境清洗 |
| `CLAUDE_CODE_SCRIPT_CAPS` | `ZY_CODE_SCRIPT_CAPS` | 每会话脚本调用限制 |
| `CLAUDE_CODE_POWERSHELL_RESPECT_EXECUTION_POLICY` | `ZY_CODE_POWERSHELL_RESPECT_EXEC_POLICY` | PowerShell 执行策略 |
| `CLAUDE_CODE_OPUS_4_6_FAST_MODE_OVERRIDE` | `ZY_CODE_FAST_MODE_MODEL_OVERRIDE` | Fast 模式模型覆盖（中立化，不绑定具体模型版本号） |
| `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` | `ZY_CODE_STOP_HOOK_BLOCK_CAP` | Stop hook 阻止上限 |
| `CLAUDE_CODE_PLUGIN_PREFER_HTTPS` | `ZY_CODE_PLUGIN_PREFER_HTTPS` | 插件强制 HTTPS 克隆 |
| `CLAUDE_CODE_EXTRA_BODY` | `ZY_CODE_EXTRA_BODY` | API 请求额外参数 |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | `ZY_CODE_MAX_CONTEXT_TOKENS` | 上下文 token 上限覆盖 |
| `CLAUDE_CODE_RESUME_PROMPT` | `ZY_CODE_RESUME_PROMPT` | 恢复提示 |
| `CLAUDE_CODE_GIT_BASH_PATH` | `ZY_CODE_GIT_BASH_PATH` | Windows Git Bash 路径 |
| `ANTHROPIC_SMALL_FAST_MODEL` | `ZY_CODE_SMALL_FAST_MODEL` | 小型快速模型指定 |
| `ANTHROPIC_WORKSPACE_ID` | `ZY_CODE_WORKSPACE_ID` | 工作区 ID 范围锁定 |
| `MCP_TOOL_TIMEOUT` | `MCP_TOOL_TIMEOUT` | MCP 工具超时（保留，非品牌相关） |
| `DISABLE_AUTOUPDATER` | `ZY_CODE_DISABLE_AUTOUPDATER` | 禁用自动更新 |
| `DISABLE_COMPACT` | `ZY_CODE_DISABLE_COMPACT` | 禁用自动压缩 |

> **兼容性说明**：对于社区已知的环境变量（如 `MCP_TOOL_TIMEOUT`），保持原名。仅对含厂商前缀的变量进行重命名。

---

## 一、调研结论概览

对 zy-code 代码库进行全面调研后，与 Changelog 逐项比对，得出以下结论：

| 类别 | 总计 | ✅ 已实现 | ⚠️ 部分实现 | ❌ 完全缺失 |
|------|------|----------|------------|------------|
| 安全加固 (P0) | 6 | 5 | 1 | 0 |
| 核心功能 (P1) | 11 | 4 | 4 | 3 |
| 体验优化 (P2) | 8 | 0 | 3 | 5 |
| 环境变量 (P3) | 10 | 0 | 0 | 10 |
| **合计** | **35** | **9** | **8** | **18** |

另有 **21 项已完整实现**，无需同步（**符号链接安全检查**、**Bash 权限绕过防护**（deny rule / env-var strip / compound cmd / find -exec / 反斜杠转义 / macOS /private/）、**域名黑名单**（deniedDomains + allowedDomains + ssrfGuard + networkRestriction）、**dangerouslyDisableSandbox 修复**（策略控制 + 权限独立检查）、**disableSkillShellExecution**（本次实现）、**DISABLE_COMPACT 禁用自动压缩**（`autoCompact.ts` 已有 `DISABLE_COMPACT` + `DISABLE_AUTO_COMPACT`）、**/loop 定时循环命令**（`skills/bundled/loop.ts` + `proactive/` 模块）、**插件依赖管理**（`dependencyResolver.ts` + `pluginOperations.ts` 完整实现）、PermissionDenied hook、CRLF 处理、深层链接、Vim j/k、WSL2 语音、/doctor、OSC 8 超链接、Shift+↑/↓ 滚动、settings schema、showThinkingSummaries、permissions.defaultMode、EnterWorktree、**429 重试指数退避**）。

> **zy-code 分化说明**：zy-code 已独立实现 model-capabilities 系统（`contextWindow` 配置驱动）、完整的重试与退避机制（`withRetry.ts`）、SSE 45s 无活动超时、工具级 `maxResultSizeChars` 控制、sandbox 适配器、20+ 个 `ZY_CODE_` 环境变量等能力。以下同步计划仅覆盖**真正缺失**的部分。

---

## 二、分阶段同步计划

### 阶段一：安全加固（P0）— 预计 3-5 天

> **目标**：补齐所有安全相关缺失项，确保代码安全性不低于 v2.1.98 水平。

#### ~~S1-1: 符号链接安全检查~~ ✅ 已实现，无需同步

- **来源版本**: v2.1.89
- **当前状态**: ✅ 已完整实现
- **zy-code 已有实现**:
  - `src/utils/fsOperations.ts` — `getPathsForPermissionCheck()` 函数（第 269-364 行）
    - 完整的符号链接链遍历：`readlinkSync` 跟踪所有中间目标，最大深度 40
    - `realpathSync` 兜底：处理目录组件中的残余 symlink
    - 悬空 symlink 处理：`resolveDeepestExistingAncestorSync` 解析最深存在的祖先
    - UNC 路径防护：在文件系统访问前阻止 `//` 和 `\\` 路径
  - `src/utils/permissions/filesystem.ts` — 权限检查层（13 处调用）
    - `checkReadPermissionForTool()` 第 960 行：对所有路径形式（原始 + symlink 解析）检查权限
    - `checkWritePermissionForTool()` 第 1106 行：deny 规则匹配原始路径和解析路径
    - `pathInAllowedWorkingPath()` 第 632 行：工作目录检查包含 symlink 解析
    - `checkPathSafetyForAutoEdit()` 第 576 行：自动编辑安全检查包含 symlink 路径
- **结论**: 无需任何改动

#### S1-2: 子进程沙箱隔离增强

- **来源版本**: v2.1.98
- **当前状态**: ⚠️ env scrub 已实现，仅 PID namespace / SCRIPT_CAPS 缺失
- **zy-code 已有实现**:
  - `src/utils/subprocessEnv.ts` L57/L81 — `ZY_CODE_SUBPROCESS_ENV_SCRUB` 已实现，启用后遍历 `GHA_SUBPROCESS_SCRUB` 数组删除敏感环境变量
  - `src/utils/sandbox/sandbox-adapter.ts` — 完整的沙箱适配层（941 行），封装 `@anthropic-ai/sandbox-runtime`
  - `src/tools/BashTool/shouldUseSandbox.ts` — sandbox 启用/禁用判断逻辑
  - `src/components/sandbox/SandboxSettings.tsx` — 终端 UI 管理 sandbox 设置
- **仍需补齐**:
  - ❌ PID namespace 隔离：未发现任何进程命名空间隔离实现（0 结果）
  - ❌ `ZY_CODE_SCRIPT_CAPS` 脚本调用次数限制：未发现相关实现（0 结果）
- **改动范围**（缩减后）:
  - `src/utils/sandbox/sandbox-adapter.ts` — 增加 PID namespace 隔离逻辑（仅 Linux）
  - `src/utils/envUtils.ts` — 注册 `ZY_CODE_SCRIPT_CAPS`
  - `src/services/tools/toolExecution.ts` — 集成脚本调用次数计数器
- **验证检查点**:
  - [x] 设置 `SUBPROCESS_ENV_SCRUB=1` 后，子进程环境中不包含 API key（✅ 已实现）
  - [ ] 脚本调用次数超限后拒绝执行
  - [ ] 不设置环境变量时行为与当前一致（向后兼容）
  - [ ] `bun tsc --noEmit` 通过

#### ~~S1-3: Bash 权限绕过防护~~ ✅ 已实现，无需同步

- **来源版本**: v2.1.98 / v2.1.113
- **当前状态**: ✅ 7 项中 5 项已完整实现，2 项低风险残余
- **zy-code 已有实现**:
  - `src/tools/BashTool/bashPermissions.ts`（2470 行，95.46 KB）— 权限控制核心
    - **deny rule + env-var strip**: L683-703 `stripAllLeadingEnvVars()` 对 deny/ask 规则剥离所有 env-var 前缀再匹配
    - **复合命令分解**: L822 预计算 compound-command 状态，deny/ask 规则匹配复合命令
    - **env-var prefix 安全检查**: L85 `ENV_VAR_ASSIGN_RE` 识别环境变量前缀，安全变量白名单判断
    - **子命令数量限制**: L89 `MAX_SUBCOMMANDS_FOR_SECURITY_CHECK = 50` 防 ReDoS
  - `src/tools/BashTool/bashSecurity.ts`（98.35 KB）— 安全检查逻辑
    - **反斜杠转义检测**: L1557 `hasBackslashEscapedOperator()` 检测 `\;`/`\&`/`\|` 双重解析风险
  - `src/tools/BashTool/readOnlyValidation.ts`（66.44 KB）— 只读命令验证
    - **find -exec 限制**: L1537 明确阻止 `-exec`/`-execdir`/`-delete`/`-ok`/`-fprint` 等危险标志
  - `src/utils/bash/treeSitterAnalysis.ts` — Tree-sitter AST 解析
    - **消除误报**: L394 `hasActualOperatorNodes()` 区分 `find -exec \;` 和真正的 `;` 运算符
  - `src/tools/BashTool/pathValidation.ts`（42.43 KB）— 路径验证
  - `src/utils/permissions/dangerousPatterns.ts` — `sudo` 列入危险命令列表
  - `src/utils/permissions/filesystem.ts` — macOS `/private/{tmp,var}` ↔ `/tmp`/`/var` 路径规范化（L654-655）
- **低风险残余**（可降级为 P2）:
  - ⚠️ `/dev/tcp`/`/dev/udp` 重定向检测：bash 网络重定向特性未被显式阻止（0 结果）
  - ⚠️ `setsid`/`ionice`/`watch -n` exec wrapper：未被特殊处理（0 结果）
- **结论**: 核心防护已完整，残余项影响较小，可在后续 P2 阶段补齐

#### ~~S1-4: 域名黑名单~~ ✅ 已实现，无需同步

- **来源版本**: v2.1.113
- **当前状态**: ✅ 已完整实现
- **zy-code 已有实现**:
  - `src/utils/sandbox/sandbox-adapter.ts` L163/192/334 — `deniedDomains` 定义、提取和返回
  - `src/entrypoints/sandboxTypes.ts` L16/21 — `SandboxNetworkConfigSchema` 中定义 `allowedDomains` + `deniedDomains`
  - `src/tools/WebSearchTool/WebSearchTool.ts` L279/307/330/350 — 搜索结果 `blocked_domains` 过滤
  - `src/services/search/DuckDuckGoProvider.ts` L56/71/89/150 — 搜索和解析时 `blockedDomains` 过滤
  - `src/services/search/types.ts` L17/19 — `SearchOptions` 接口定义 `allowedDomains` + `blocked_domains`
  - `src/utils/hooks/ssrfGuard.ts` — SSRF 防护（阻止内网 IP 范围，允许 127.0.0.0/8 用于本地开发）
  - `src/tools/BashTool/prompt.ts` L170/196 — 调用 `getNetworkRestrictionConfig()` 构建 networkConfig
- **结论**: 无需任何改动

#### ~~S1-5: dangerouslyDisableSandbox 修复~~ ✅ 已实现，无需同步

- **来源版本**: v2.1.113
- **当前状态**: ✅ 已完整实现
- **zy-code 已有实现**:
  - `src/tools/BashTool/shouldUseSandbox.ts` L139-141 — `dangerouslyDisableSandbox` 仅在策略允许时（`areUnsandboxedCommandsAllowed()`）才跳过沙箱
  - `src/tools/BashTool/prompt.ts` L218/232/236/240 — Prompt 中指导 LLM 何时使用该参数
  - `src/types/permissions.ts` L307 — 权限决策类型中包含 `'dangerouslyDisableSandbox'` 作为 reason
  - `src/entrypoints/sandboxTypes.ts` L114-115 — Zod schema 定义
  - `src/utils/api.ts` L586-588 — API 请求构造时透传
  - `src/services/tools/toolExecution.ts` L1062-1063 — 工具执行时传递
  - `src/utils/permissions/permissions.ts` L1089 — 该参数影响 ask 规则判断，权限检查独立于沙箱启用状态
- **结论**: 权限检查不依赖沙箱是否启用，`dangerouslyDisableSandbox` 仅禁用沙箱运行时而不跳过权限提示，无需任何改动

#### S1-6: disableSkillShellExecution 设置 ✅ 已实现

- **来源版本**: v2.1.91
- **当前状态**: ✅ 已实现
- **改动文件**:
  - `src/utils/settings/types.ts` L998 — 添加 `disableSkillShellExecution: z.boolean().optional()` schema
  - `src/utils/promptShellExecution.ts` L6/10/70-80 — 导入 `tSync` + `getInitialSettings`，函数入口守卫 + `logForDebugging`
  - `src/i18n/locales/en.ts` — 添加 `skillShell.disabledBySettings` 翻译 key
  - `src/i18n/locales/zh-CN.ts` — 添加 `skillShell.disabledBySettings` 中文翻译
- **实现要点**:
  1. settings schema 中添加 `disableSkillShellExecution: z.boolean().optional()`
  2. `executeShellCommandsInPrompt()` 入口检查该 setting，为 true 时抛出 `MalformedCommandError(tSync('skillShell.disabledBySettings'))`
  3. 关键路径添加 `logForDebugging()` 调试日志
  4. 用户可见错误消息通过 i18n（`en.ts` / `zh-CN.ts`）国际化
- **验证检查点**:
  - [x] 设置为 true 后，skill 中的 shell 命令被拒绝执行
  - [x] 不设置时行为不变（`getInitialSettings()` 返回 undefined，守卫不触发）
  - [x] `bun tsc --noEmit` 通过（0 errors）

---

### 阶段二：核心能力同步（P1）— 预计 5-8 天

> **目标**：补齐关键核心功能，使 zy-code 能力与 v2.1.139+ 对齐。

#### ~~S2-1: 大上下文窗口支持验证与 DISABLE_COMPACT 补齐~~ ✅ 已实现，无需同步

- **来源版本**: v2.1.92
- **当前状态**: ✅ 已完整实现
- **zy-code 已有实现**:
  - `model-capabilities.json` 通过 `contextWindow` 字段配置（支持 `"200k"`、`"1m"` 等格式）
  - `getContextWindowForModel()` 已消费 contextWindow 用于自动压缩阈值计算
  - `ZY_CODE_AUTO_COMPACT_WINDOW` 可覆盖压缩窗口大小
  - `src/services/compact/autoCompact.ts` L155/256 — **`DISABLE_COMPACT` 已实现**：同时禁用手动 `/compact` 和自动压缩
  - `src/services/compact/autoCompact.ts` L155 — **`DISABLE_AUTO_COMPACT` 已实现**：细粒度控制，仅禁用自动压缩
  - `src/commands/compact/index.ts` L8 — `/compact` 命令检查 `isEnvTruthy(process.env.DISABLE_COMPACT)`
- **结论**: 无需任何改动。环境变量名为 `DISABLE_COMPACT`（无 `ZY_CODE_` 前缀），已是生产级实现

#### S2-2: MCP 工具结果持久化覆盖

- **来源版本**: v2.1.91
- **当前状态**: ⚠️ 部分实现
- **zy-code 已有能力**:
  - 工具级 `maxResultSizeChars` 已实现（BriefTool 100K、FileReadTool Infinity 等）
  - 截断逻辑在工具执行层已有
- **改动范围**:
  - `src/services/mcp/` — 添加 MCP `_meta` 动态声明覆盖解析
- **实现要点**:
  1. MCP 工具可通过 `_meta["maxResultSizeChars"]` 动态声明最大结果大小，最多 500K 字符
  2. `_meta` 声明的值覆盖工具默认的 `maxResultSizeChars`，但不超过 500K 上限
  3. 未声明时沿用现有截断策略
- **验证检查点**:
  - [ ] MCP 工具通过 `_meta` 声明 500K 时结果不被截断
  - [ ] 声明超过 500K 时截断到 500K
  - [ ] 未声明时行为与当前一致
  - [ ] `bun tsc --noEmit` 通过

#### S2-3: 流式 API 长时间停滞检测与回退

- **来源版本**: v2.1.105
- **当前状态**: ⚠️ 部分实现
- **zy-code 已有能力**:
  - SSE 传输层已有 45 秒无活动超时（`src/cli/transports/SSETransport.ts`）
  - CCR 客户端有 stream accumulator 清理机制
  - `createAbortController()` / `createCombinedAbortSignal()` 统一中止信号管理
- **zy-code 已有能力**:
  - `src/services/api/llmOrchestrator.ts` L398/1105/1805 — 已有流式→非流式错误回退（`didFallBackToNonStreaming`）
  - 注意：`streamAdapter.ts` 不存在，实际流式逻辑在 `llmOrchestrator.ts` 中
- **改动范围**:
  - `src/services/api/llmOrchestrator.ts` — 在流式消费循环中添加 5 分钟级停滞检测
- **实现要点**:
  1. 在流式消费循环中增加 5 分钟无 chunk 的停滞检测（区别于 SSE 层的 45s 连接级超时）
  2. 停滞检测触发后自动中止流并回退到非流式 API 调用（复用现有 `didFallBackToNonStreaming` 路径）
  3. 在停滞检测和回退路径添加 `logForDebugging()` 日志
- **验证检查点**:
  - [ ] 模拟停滞流，5 分钟后正确中止并回退
  - [ ] SSE 45s 超时和 5 分钟停滞检测互不干扰
  - [ ] 日志中可见停滞检测和回退过程
  - [ ] `bun tsc --noEmit` 通过

> **已移除**: ~~S2-4: 429 重试指数退避~~ — `src/services/api/withRetry.ts` 已完整实现指数退避 + Retry-After 遵循 + 529/429 特殊处理 + 持久重试模式，无需同步。

#### S2-5: /goal 目标驱动模式

- **来源版本**: v2.1.139
- **当前状态**: ❌ 完全缺失
- **改动范围**:
  - `src/commands/goal/` — **新建目录**
  - `src/commands/goal/index.ts` — 命令注册
  - `src/commands/goal/goalRunner.ts` — 目标执行引擎
  - `src/commands/goal/goalEvaluator.ts` — 目标完成评估器
  - `src/commands.ts` — 注册 /goal 命令
- **实现要点**:
  1. 用户设定目标后，Claude 跨轮次自主推进
  2. 实时显示耗时、轮数、Token 消耗统计
  3. 评估器在后台 shell 或子代理运行时不应触发（v2.1.143 修复）
  4. 在 `disableAllHooks` / `allowManagedHooksOnly` 下显示清晰提示而非假死（v2.1.140 修复）
- **验证检查点**:
  - [ ] `/goal "重构 utils 模块"` 启动目标模式
  - [ ] 实时显示统计信息
  - [ ] 可中断目标执行
  - [ ] `bun tsc --noEmit` 通过

#### S2-6: /bg 后台运行

- **来源版本**: v2.1.139
- **当前状态**: ⚠️ CLI `--bg` 已有，缺斜杠命令
- **zy-code 已有实现**:
  - `src/cli/bg.ts` — bg CLI 入口
  - `src/utils/concurrentSessions.ts` L21/35 — `isBgSession()` 后台会话判断
  - `src/tools/BashTool/prompt.ts` L32 — `run_in_background` 工具参数
  - `src/keybindings/defaultBindings.ts` L180 — `ctrl+b` → `task:background` 快捷键
  - `src/utils/collapseBackgroundBashNotifications.ts` — 后台通知合并
  - i18n: `backgroundTasks.*` 翻译完整
- **仍需补齐**:
  - ❌ `/bg` 斜杠命令（将前台会话转后台）
  - ⚠️ 配置参数透传验证（`--mcp-config`、`--settings`、`--add-dir` 等）
- **改动范围**（缩减后）:
  - `src/commands/bg/` — **新建目录**，注册 `/bg` 斜杠命令
  - `src/commands.ts` — 注册 /bg 命令
- **验证检查点**:
  - [x] `zy --bg "run tests"` 启动后台任务（✅ 已实现）
  - [x] `ctrl+b` 将任务转后台（✅ 已实现）
  - [ ] `/bg` 斜杠命令将会话放到后台
  - [ ] `bun tsc --noEmit` 通过

#### ~~S2-7: /loop 命令（统一 /proactive）~~ ✅ 已实现，无需同步

- **来源版本**: v2.1.105
- **当前状态**: ✅ 已完整实现
- **zy-code 已有实现**:
  - `src/skills/bundled/loop.ts` L75 — `/loop` 作为 Skill 实现，支持 `[interval] <prompt>` 参数，默认 10 分钟
  - `src/commands/proactive.ts` — `/proactive` 本地命令（stub + 功能模块）
  - `src/proactive/index.ts`（82 行）— Proactive 模式核心：`activateProactive()`/`deactivateProactive()`/`pauseProactive()`/`resumeProactive()`
  - `src/proactive/useProactive.ts`（37 行）— React hook，每 30 秒 `<tick>` 驱动自主行为
  - `src/cli/print.ts` L308/463 — 条件加载，通过 `PROACTIVE`/`KAIROS` feature flag 控制
  - `src/hooks/useScheduledTasks.ts` — 定时任务 hook
  - i18n: `tip.loopCommandA`/`tip.loopCommandB`/`commands.loop` 已完整翻译
- **结论**: 无需任何改动

#### S2-8: PreCompact hook — 补齐阻止能力

- **来源版本**: v2.1.105
- **当前状态**: ⚠️ hook 已在但缺阻止压缩能力
- **zy-code 已有实现**:
  - `src/utils/hooks.ts` L3759-3820 — `executePreCompactHooks()` 函数已实现
  - `src/commands/compact/compact.ts` L136-145 — 压缩前调用 PreCompact hooks
  - `src/utils/hooks/hooksConfigManager.ts` L131/276 — Hook 配置定义
  - `src/utils/plugins/loadPluginHooks.ts` L40/102 — 插件 hooks 加载
- **仍需补齐**:
  - ❌ 当前 hook 返回值只有 `newCustomInstructions` 和 `userDisplayMessage`，无法阻止压缩
  - 需添加：退出码 2 或 `{"decision":"block"}` 阻止压缩的逻辑
- **改动范围**（缩减后）:
  - `src/utils/hooks.ts` — `executePreCompactHooks()` 中增加 block 判断逻辑
  - `src/commands/compact/compact.ts` — 根据 hook 返回的 block 决策中止压缩
- **验证检查点**:
  - [ ] PreCompact hook 返回 block 时压缩被阻止
  - [ ] hook 不阻止时正常压缩
  - [ ] `bun tsc --noEmit` 通过

#### S2-9: 插件 monitors

- **来源版本**: v2.1.105
- **当前状态**: ❌ 缺失
- **改动范围**:
  - `src/utils/plugins/pluginLoader.ts` — 解析 manifest monitors 字段
  - `src/utils/plugins/pluginMonitor.ts` — **新建**，monitor 运行时
- **实现要点**:
  1. manifest 顶层新增 `monitors` 字段
  2. session 启动或 skill 调用时自动启动 monitor
  3. monitor 可持续监听事件和状态变化
- **验证检查点**:
  - [ ] manifest 中定义 monitor 后自动启动
  - [ ] monitor 可接收事件
  - [ ] `bun tsc --noEmit` 通过

#### S2-10: /powerup 交互式学习

- **来源版本**: v2.1.92
- **当前状态**: ❌ 缺失
- **改动范围**:
  - `src/commands/powerup/` — **新建目录**
  - `src/commands.ts` — 注册命令
- **实现要点**:
  1. 提供交互式功能引导菜单：搜索替换、代码重构、测试生成、Bug 修复、文档生成
  2. 选择后展示具体用法和示例
- **验证检查点**:
  - [ ] `/powerup` 显示菜单
  - [ ] 选择选项后展示对应指南
  - [ ] `bun tsc --noEmit` 通过

#### ~~S2-11: 插件依赖管理~~ ✅ 已实现，无需同步

- **来源版本**: v2.1.143
- **当前状态**: ✅ 已完整实现
- **zy-code 已有实现**:
  - `src/utils/plugins/dependencyResolver.ts` L224-260 — `findReverseDependents()` 查找反向依赖
  - `src/utils/plugins/schemas.ts` L1202-1252 — 插件依赖 schema 定义（`dependencies` 字段）
  - `src/utils/plugins/pluginInstallationHelpers.ts` L284-438 — 依赖解析和安装
  - `src/services/plugins/pluginOperations.ts` L515-518 — 禁用/卸载时检查依赖
  - `src/cli/handlers/plugins.ts` L746-809 — CLI `zy plugins enable/disable` 命令
  - 支持跨市场依赖控制：`allowCrossMarketplaceDependenciesOn` 配置
- **结论**: 无需任何改动

#### S2-12: Agent View 多会话管理增强

- **来源版本**: v2.1.139
- **当前状态**: ⚠️ 基础框架在
- **改动范围**:
  - `src/commands/agents/` — 大幅增强
  - `src/screens/AgentView.tsx` — **新建**，多会话 UI
  - `src/components/agents/` — **新建目录**，Agent 列表/详情组件
- **实现要点**:
  1. `claude agents` 或左方向键进入 Agent View
  2. 显示运行中/等待回复/已完成的会话状态
  3. 内联回复功能
  4. Peek 机制查看最近对话
  5. 支持 `--model`、`--effort`、`--permission-mode` 等标志（v2.1.142）
  6. `--cwd` 目录筛选（v2.1.141）
- **验证检查点**:
  - [ ] `claude agents` 打开 Agent View
  - [ ] 会话状态正确显示
  - [ ] 内联回复功能可用
  - [ ] `bun tsc --noEmit` 通过

---

### 阶段三：体验优化（P2）— 预计 3-5 天

> **目标**：补齐体验层改进，提升日常使用的稳定性和流畅度。

#### S3-1: terminalSequence hook 字段

- **来源版本**: v2.1.141
- **当前状态**: ❌ 缺失
- **改动范围**: `src/utils/hooks.ts`
- **实现要点**: 允许 Hook 在无控制终端时发送系统通知、窗口标题修改和响铃
- **验证检查点**:
  - [ ] hook 输出中 terminalSequence 字段被正确处理
  - [ ] `bun tsc --noEmit` 通过

#### S3-2: stop hook block cap

- **来源版本**: v2.1.143
- **当前状态**: ❌ 缺失
- **改动范围**: `src/query/stopHooks.ts`
- **实现要点**:
  1. 连续 8 次阻止后结束轮次并显示警告
  2. 可通过 `ZY_CODE_STOP_HOOK_BLOCK_CAP` 覆盖
- **验证检查点**:
  - [ ] 连续 8 次 block 后自动终止
  - [ ] 环境变量覆盖生效
  - [ ] `bun tsc --noEmit` 通过

#### S3-3: 智能 Spinner（10s 变琥珀色）

- **来源版本**: v2.1.141
- **当前状态**: ⚠️ 50% — 有 spinner，缺颜色变化
- **改动范围**: spinner 相关组件（`src/ink/` 或 `src/components/`）
- **实现要点**: 深度思考超过 10 秒时，Loading 图标从蓝色变为琥珀色
- **验证检查点**:
  - [ ] 10 秒后颜色正确变化
  - [ ] `bun tsc --noEmit` 通过

#### S3-4: 回溯菜单局部摘要

- **来源版本**: v2.1.141
- **当前状态**: ⚠️ rewind 基础在，缺 summarize
- **改动范围**: `src/commands/rewind/rewind.ts`
- **实现要点**:
  1. 在 Rewind 菜单中新增 "Summarize up to here" 选项
  2. 将较早对话压缩摘要，保持最近几轮完整
- **验证检查点**:
  - [ ] rewind 菜单显示摘要选项
  - [ ] 摘要后 token 减少、核心上下文保留
  - [ ] `bun tsc --noEmit` 通过

#### S3-5: Perforce 模式

- **来源版本**: v2.1.98
- **当前状态**: ❌ 缺失
- **改动范围**: Edit/Write 工具 + 环境变量注册
- **实现要点**: 设置 `ZY_CODE_PERFORCE_MODE` 后，只读文件操作失败时显示 "p4 edit" 提示
- **验证检查点**:
  - [ ] 环境变量设置后提示可用
  - [ ] `bun tsc --noEmit` 通过

#### S3-6: Monitor 工具

- **来源版本**: v2.1.98
- **当前状态**: ❌ 缺失
- **改动范围**: `src/tools/MonitorTool/` — **新建**
- **实现要点**: 后台脚本可通过 Monitor 工具流式传输事件
- **验证检查点**:
  - [ ] Monitor 工具注册成功
  - [ ] `bun tsc --noEmit` 通过

#### S3-7: worktree.bgIsolation 配置

- **来源版本**: v2.1.143
- **当前状态**: ❌ 缺失
- **改动范围**: `src/utils/settings/types.ts`
- **实现要点**: `worktree.bgIsolation: "none"` 允许后台会话直接编辑工作副本
- **验证检查点**:
  - [ ] 配置项可用
  - [ ] `bun tsc --noEmit` 通过

#### S3-8: CJK 4KB 边界截断修复

- **来源版本**: v2.1.89
- **当前状态**: ⚠️ 80% — 有宽字符处理，缺边界修复
- **改动范围**: `src/utils/history.ts` 或 prompt history 相关模块
- **实现要点**: CJK/emoji 提示历史条目落在 4KB 边界时不应被静默删除
- **验证检查点**:
  - [ ] 包含 CJK 的历史条目在 4KB 边界处不丢失
  - [ ] `bun tsc --noEmit` 通过

---

### 阶段四：环境变量与配置补全（P3）— 预计 1-2 天

> **目标**：为各阶段新增功能配套环境变量。每个环境变量必须与一个缺失功能匹配，不做无脑添加。

#### 原则

1. **功能先行**：环境变量随对应功能一起实现，不单独注册空壳变量
2. **品牌中立**：统一使用 `ZY_CODE_` 前缀
3. **向后兼容**：所有变量不设置时使用合理默认值，不改变现有行为

#### 缺失环境变量清单（与功能一一对应）

**随功能实现的变量（4 个）**：

| # | 环境变量 | 用途 | 关联功能 | 何时添加 |
|---|---------|------|---------|---------|
| 1 | `ZY_CODE_SUBPROCESS_ENV_SCRUB` | 子进程环境清洗 | S1-2 子进程沙箱 | 随 S1-2 实现 |
| 2 | `ZY_CODE_SCRIPT_CAPS` | 每会话脚本调用限制 | S1-2 子进程沙箱 | 随 S1-2 实现 |
| 3 | `ZY_CODE_STOP_HOOK_BLOCK_CAP` | Stop hook 阻止上限 | S3-2 stop hook cap | 随 S3-2 实现 |
| 4 | `ZY_CODE_DISABLE_COMPACT` | 禁用自动压缩 | S2-1 大上下文支持 | 随 S2-1 实现 |

**独立功能配套变量（6 个）**：

| # | 环境变量 | 用途 | 功能描述 | 改动范围 |
|---|---------|------|---------|---------|
| 5 | `ZY_CODE_NO_FLICKER` | 无闪烁替代屏幕渲染 | 选择虚拟回滚功能的无闪烁渲染 | `src/ink/` 渲染层 |
| 6 | `ZY_CODE_PERFORCE_MODE` | Perforce 集成模式 | 只读文件操作失败时显示 "p4 edit" 提示 | S3-5 随功能实现 |
| 7 | `ZY_CODE_FAST_MODE_MODEL_OVERRIDE` | Fast 模式模型覆盖 | 锁定 Fast 模式使用的模型（中立命名，不绑定具体模型版本） | `src/utils/model/` |
| 8 | `ZY_CODE_PLUGIN_PREFER_HTTPS` | 插件强制 HTTPS 克隆 | 无 SSH Key 环境下强制 HTTPS 克隆插件源码 | `src/utils/plugins/` |
| 9 | `MCP_TOOL_TIMEOUT` | MCP 工具超时控制 | 覆盖远程 MCP 服务器调用超时时间 | `src/services/mcp/` |
| 10 | `ZY_CODE_EXTRA_BODY` | API 请求额外参数 | 向 LLM API 请求体注入额外字段 | `src/services/api/` |

#### 实现方案

- **改动范围**:
  - `src/utils/envUtils.ts` — 统一注册独立功能变量的读取函数
  - 各功能模块 — 在对应位置引用环境变量
  - 每个变量的读取位置必须添加 `logForDebugging()` 日志（见 3.4 节）
- **验证检查点**:
  - [ ] 每个环境变量设置后对应功能生效
  - [ ] 不设置时使用合理默认值，不改变现有行为
  - [ ] `bun tsc --noEmit` 通过

---

## 三、日志追踪流程

### 3.1 变更日志规范

每项改动必须在 `docs/sync-changelog/` 目录下创建对应的日志文件：

```
docs/sync-changelog/
├── S1-1-symlink-security.md
├── S1-2-subprocess-sandbox.md
├── S1-3-bash-permissions.md
├── ...
└── S4-env-variables.md
```

#### 日志模板

```markdown
# [任务编号] 任务标题

## 基本信息
- **关联 Claude Code 版本**: v2.1.xx
- **执行日期**: YYYY-MM-DD
- **执行者**: xxx

## 改动文件清单
| 文件路径 | 操作 | 说明 |
|---------|------|------|
| src/xxx.ts | 修改 | 添加 xxx 逻辑 |
| src/yyy.ts | 新建 | xxx 模块 |

## 改动详情
### 改动 1: [描述]
- **修改前**: [关键代码片段或行为描述]
- **修改后**: [关键代码片段或行为描述]
- **原因**: [为什么需要这个改动]

## 验证结果
- [ ] `bun tsc --noEmit` 通过
- [ ] 功能验证 1: [描述] — ✅/❌
- [ ] 功能验证 2: [描述] — ✅/❌
- [ ] 回归检查: [描述] — ✅/❌

## 遗留问题
- (无 / 列出待解决问题)
```

### 3.2 Git 提交规范

```
feat(sync/S1-1): 添加符号链接安全检查

- 在 FileEditTool/FileReadTool/FileWriteTool 中添加 symlink 目标路径解析
- 新增 resolveSymlinkTarget() 工具函数
- 关联版本: Claude Code v2.1.89

Refs: docs/sync-changelog/S1-1-symlink-security.md
```

**提交前缀**:
- `feat(sync/Sx-x)`: 新增功能
- `fix(sync/Sx-x)`: 修复问题
- `refactor(sync/Sx-x)`: 重构
- `docs(sync)`: 文档更新

### 3.3 阶段性检查点

每个阶段完成后，执行以下检查：

1. **编译检查**: `bun tsc --noEmit`
2. **Lint 检查**: `bun run lint:biome`
3. **构建检查**: `bun run build:cli`
4. **启动检查**: `bun run dev` 确认正常启动
5. **回归测试**: 验证已有功能不受影响
6. **文档更新**: 更新 FEATURE_FLAGS.md 和 README.md

### 3.4 logForDebugging 调试日志规范

所有新增功能必须在**关键执行路径**添加 `logForDebugging()` 日志，便于问题排查。

#### 日志方法

```typescript
import { logForDebugging } from './utils/debug.js'

// 普通信息（默认 level）
logForDebugging(`[模块名] 操作描述: ${关键变量}`)

// 警告级别
logForDebugging(`[模块名] 异常描述: ${错误信息}`, { level: 'warn' })

// 错误级别
logForDebugging(`[模块名] 失败描述: ${错误信息}`, { level: 'error' })
```

#### 命名规范

- 日志前缀统一使用 `[模块名]` 格式，与项目现有风格一致（如 `[query]`、`[structuredIO]`、`[remote-io]`）
- 关键变量值直接内嵌到日志字符串中，方便 grep 定位
- 禁止在日志中输出敏感信息（API key、用户凭证等）

#### 各任务必须埋点的关键位置

**阶段一：安全加固**

| 任务 | 埋点位置 | 日志内容示例 |
|------|---------|-------------|
| S1-1 符号链接检查 | symlink 目标解析时 | `[symlink-guard] Resolved path: ${requested} → ${resolved}, allowed: ${isAllowed}` |
| S1-1 符号链接检查 | 拒绝访问时 | `[symlink-guard] Blocked: symlink target ${resolved} outside allowed scope` |
| S1-3 Bash 权限防护 | deny rule 匹配时 | `[bash-perm] Deny rule matched: "${command}" via wrapper "${wrapper}"` |
| S1-3 Bash 权限防护 | env-var prefix 检查时 | `[bash-perm] Env-var prefix "${varName}" is ${isSafe ? 'safe' : 'unsafe'}, prompting: ${!isSafe}` |
| S1-4 域名黑名单 | 域名检查时 | `[network] Domain check: ${domain}, allowed: ${isAllowed}, denied: ${isDenied}` |
| S1-6 disableSkillShellExecution | shell 执行被拦截时 | `[skill] Shell execution blocked by disableSkillShellExecution setting` |

**阶段二：核心功能**

| 任务 | 埋点位置 | 日志内容示例 |
|------|---------|-------------|
| S2-1 DISABLE_COMPACT | 压缩被禁用时 | `[compact] Auto-compact disabled by ZY_CODE_DISABLE_COMPACT` |
| S2-2 MCP 结果覆盖 | `_meta` 覆盖生效时 | `[mcp] Result size override: tool=${toolName}, declared=${declaredSize}, effective=${effectiveSize}` |
| S2-3 流式超时 | 停滞检测触发时 | `[stream] Stale stream detected after ${elapsedMs}ms, aborting and falling back to non-streaming` |
| S2-3 流式超时 | 回退成功时 | `[stream] Non-streaming fallback succeeded for model=${model}` |
| S2-5 /goal | 目标启动/完成/中断时 | `[goal] Started goal: "${goalText}", round=${round}, tokens=${tokens}` |
| S2-6 /bg | 会话后台化时 | `[bg] Session ${sessionId} moved to background, preserving: model=${model}, effort=${effort}` |
| S2-8 PreCompact hook | hook 阻止压缩时 | `[compact] PreCompact hook blocked compaction: exitCode=${exitCode}` |

**阶段三：体验优化**

| 任务 | 埋点位置 | 日志内容示例 |
|------|---------|-------------|
| S3-2 stop hook cap | 阻止计数递增时 | `[stop-hook] Block count: ${count}/${cap}, action: ${count >= cap ? 'terminating' : 'continuing'}` |
| S3-5 Perforce 模式 | p4 edit 提示时 | `[perforce] Read-only file detected: ${filePath}, suggesting p4 edit` |

**阶段四：环境变量**

| 任务 | 埋点位置 | 日志内容示例 |
|------|---------|-------------|
| 所有环境变量 | 变量读取时（仅首次） | `[env] ${varName}=${value ?? '(unset)'}` |

#### 验证检查点

每个任务完成后，必须确认：
- [ ] 所有上表列出的埋点位置均已添加 `logForDebugging()` 调用
- [ ] 设置 `ZY_CODE_DEBUG=1` 后可在终端看到对应日志输出
- [ ] 日志中不包含敏感信息（API key、token、密码等）
- [ ] 日志前缀与现有项目风格一致

---

## 四、验证流程

### 4.1 单项验证清单

每个同步任务完成后，必须逐一通过以下验证：

```bash
# 1. 类型检查
bun tsc --noEmit

# 2. Lint 检查
bun run lint:biome

# 3. 构建验证
bun run build:cli

# 4. 启动验证
bun run dev
# 确认无启动错误，能进入 REPL

# 5. 功能点验证
# 按各任务的验证检查点逐一测试
```

### 4.2 阶段验证矩阵

#### 阶段一完成后

| 验证项 | 预期结果 | 实际结果 |
|--------|---------|---------|
| symlink 指向项目外 → Read 拒绝 | ✅ 拒绝并提示 | ✅ 已实现（`getPathsForPermissionCheck` + 权限系统 13 处调用） |
| `env bash -c "危险命令"` → 权限提示 | ✅ 弹出提示 | ✅ 已实现（`bashPermissions.ts` deny rule + env-var strip + compound cmd） |
| `deniedDomains` 配置 → 域名被拒 | ✅ 请求被拒 | ✅ 已实现（`sandbox-adapter.ts` + `WebSearchTool` + `ssrfGuard.ts`） |
| `dangerouslyDisableSandbox` 后仍检查权限 | ✅ 权限独立 | ✅ 已实现（`shouldUseSandbox.ts` L139-141 策略控制） |
| `disableSkillShellExecution=true` → skill shell 被禁 | ✅ 执行被拒 | ✅ 已实现（`promptShellExecution.ts` 入口守卫 + i18n） |
| 已有功能不受影响 | ✅ 正常工作 | |
| `bun tsc --noEmit` | ✅ 0 errors | |
| `bun run build:cli` | ✅ 构建成功 | |

#### 阶段二完成后

| 验证项 | 预期结果 | 实际结果 |
|--------|---------|---------|
| `contextWindow: "1m"` 解析正确 | ✅ 解析为 1000000 | ✅ 已实现（model-capabilities + TokenCountSchema） |
| `DISABLE_COMPACT=1` 禁用自动压缩 | ✅ 压缩不触发 | ✅ 已实现（`autoCompact.ts` L155/256） |
| `/loop` 命令可用 | ✅ 循环模式 | ✅ 已实现（`skills/bundled/loop.ts` Skill 实现） |
| 插件依赖管理：禁用被依赖插件时提示 | ✅ 明确提示 | ✅ 已实现（`dependencyResolver.ts` + `pluginOperations.ts`） |
| `/goal` 命令可用 | ✅ 启动目标模式 | |
| `/bg` 斜杠命令可用 | ✅ 后台运行 | |
| `/powerup` 命令可用 | ✅ 显示菜单 | |
| `zy agents` 显示 Agent View | ✅ 多会话 UI | |
| MCP `_meta` 结果大小覆盖生效 | ✅ 500K 不截断 | |
| 流式 5 分钟停滞检测与非流式回退 | ✅ 自动中止并回退 | |
| PreCompact hook block 阻止压缩 | ✅ 压缩被阻止 | |
| 已有功能不受影响 | ✅ 正常工作 | |
| `bun tsc --noEmit` | ✅ 0 errors | |
| `bun run build:cli` | ✅ 构建成功 | |

#### 阶段三完成后

| 验证项 | 预期结果 | 实际结果 |
|--------|---------|---------|
| Spinner 10s 变琥珀色 | ✅ 颜色变化 | |
| Rewind 菜单有摘要选项 | ✅ 选项可用 | |
| Stop hook 8 次后终止 | ✅ 自动终止 | |
| Perforce 模式提示 | ✅ 提示可用 | |
| 已有功能不受影响 | ✅ 正常工作 | |
| `bun tsc --noEmit` | ✅ 0 errors | |
| `bun run build:cli` | ✅ 构建成功 | |

#### 阶段四完成后

| 验证项 | 预期结果 | 实际结果 |
|--------|---------|---------|
| 12 个环境变量均有引用 | ✅ 全部注册 | |
| 环境变量设置/不设置均不报错 | ✅ 向后兼容 | |
| `bun tsc --noEmit` | ✅ 0 errors | |
| `bun run build:cli` | ✅ 构建成功 | |

### 4.3 问题排查流程

当验证失败时，按以下流程排查：

```
验证失败
  ├── 编译错误 (tsc)
  │   ├── 类型不匹配 → 检查 import 路径和类型定义
  │   ├── 缺失模块 → 检查新文件是否正确创建
  │   └── 其他 → 查看完整错误栈，定位到具体文件行号
  │
  ├── 构建错误 (build)
  │   ├── 打包失败 → 检查 build.ts external 配置
  │   ├── 宏替换失败 → 检查 MACRO.* 引用
  │   └── 循环依赖 → 使用 madge 工具分析依赖图
  │
  ├── 运行时错误 (dev)
  │   ├── 启动崩溃 → 检查入口文件初始化顺序
  │   ├── 命令未注册 → 检查 commands.ts 注册
  │   └── 功能异常 → 查看 sync-changelog 对应日志，对比改动
  │
  └── 功能验证失败
      ├── 安全检查未生效 → 检查权限检查逻辑是否在正确位置调用
      ├── 命令无响应 → 检查命令处理器是否正确实现
      └── UI 渲染异常 → 检查 Ink 组件 props 和状态
```

### 4.4 回归测试要点

每次改动后重点关注以下已有功能不受影响：

1. **基本对话流程**: 启动 → 输入 → 收到回复 → 工具调用
2. **文件操作**: Read/Edit/Write 工具正常工作
3. **Bash 工具**: 命令执行、输出捕获正常
4. **MCP 连接**: MCP 服务器连接和工具调用正常
5. **权限系统**: 权限提示、自动批准逻辑正常
6. **设置系统**: settings.json 读取、合并、验证正常
7. **国际化**: 中英文切换正常

---

## 五、风险评估与缓解

| 风险 | 级别 | 缓解措施 |
|------|------|---------|
| 安全改动引入新漏洞 | 🔴 高 | 每项安全改动需独立 review + 专项验证 |
| 大量新文件导致编译不过 | 🟠 中 | 每个任务完成后立即 tsc 检查 |
| 新命令与现有命令冲突 | 🟡 低 | 在 commands.ts 统一注册，名称去重 |
| 环境变量覆盖已有行为 | 🟠 中 | 所有环境变量默认值保持向后兼容 |
| Agent View 渲染性能 | 🟡 低 | Ink 组件采用虚拟化列表 |

---

## 六、优先级调整指南

如果时间有限，建议按以下精简顺序执行：

### 最小可行集（MVP）— 7 项核心改动

1. **S1-1** 符号链接安全检查（安全必须）
2. **S1-3** Bash 权限绕过防护（安全必须）
3. **S1-4** 域名黑名单（安全必须）
4. **S2-1** 100 万 Token 上下文（核心能力）
5. **S2-3** 流式 API 超时（稳定性）
6. **S2-4** 429 重试退避（稳定性）
7. **S1-6** disableSkillShellExecution（安全配置）

### 扩展集 — 额外 8 项

8. **S2-5** /goal 目标驱动
9. **S2-6** /bg 后台运行
10. **S2-7** /loop 命令
11. **S2-8** PreCompact hook
12. **S3-2** stop hook block cap
13. **S2-12** Agent View 增强
14. **S3-4** 回溯局部摘要
15. **阶段四** 环境变量补全

---

> **下一步**: 确认方案后，从阶段一 S1-1 开始执行，每项改动生成对应的 sync-changelog 日志。
