# 代码卫生与规范治理

> 创建时间：2026-06-06
> 基于全项目系统性审计，覆盖跨文件重复、AGENTS.md 规范违规、类型安全。

---

## 已完成

### ~~1. `stopHooks.ts` 消除 as any~~ ✅

2026-06 完成。消除全部 13 行（18 处）`as any`。根因修复：`AggregatedHookResult.message` 从 `HookResultMessage` 拓宽为 `Message`，8 个文件级联修复。新增 `isHookAttachment()` 类型守卫。`StopHookInfo` 构造补全必填字段，移除死数据 `promptText`。

### ~~2. `query/` 英文注释翻译~~ ✅

2026-06 完成。4 个文件共 36 处英文注释翻译为中文。用户可见通知文案 `Stop hook error occurred` 迁移到 i18n（`notification.stopHookError`）。`prevented continuation` 默认值因同时用于结构化数据和模型上下文，暂保持英文。

---

## 1. `stopHooks.ts` 消除 15 处 `as any` 滥用

### 现状

`src/query/stopHooks.ts` 中有 15 处 `as any` 在业务逻辑中，违反 AGENTS.md §9。需要注意：这些 `as any` 不是单一类型问题，不能简单用一个 `result.message` 类型守卫全部替换。

主要分为三类：

| 类别 | 典型模式 | 建议处理 |
|------|----------|----------|
| `result.message` 鉴别 | `(result.message as any).type === 'progress'` / `.toolUseID` | 使用 `ProgressMessage` / `AttachmentMessage` 类型守卫 |
| hook info 与 attachment 字段匹配 | `(i as any).command` / `(attachment as any).durationMs` | 定义明确的局部结构类型和运行时守卫 |
| `querySource` 字符串兼容 | `(querySource as any) === 'repl_main_thread'` | `QuerySource` 已包含该值，直接移除 `as any` |

已核实：`src/types/message.ts` 中已有 `ProgressMessage` / `AttachmentMessage`，且已有可复用的 `isProgressMessage` / `isAttachmentMessage` 导出函数；`src/constants/querySource.ts` 中的 `QuerySource` 也已包含 `'repl_main_thread'` 和 `` `repl_main_thread:${string}` ``，因此 `querySource as any` 没有必要保留。

### 方案

1. 在 `stopHooks.ts` 中直接引入 `isProgressMessage` / `isAttachmentMessage`，用现有类型守卫替换 `result.message` 相关的 `as any`。
2. 为 hook 输出中的 `command` / `durationMs` 等字段定义局部结构类型和守卫，避免继续使用 `as any` 访问扩展字段。
3. 抽取重复的 `toolUseID` 提取逻辑，例如 `extractProgressToolUseID(message)`，统一处理 Stop / TaskCompleted / TeammateIdle 三类 hook。
4. 删除 `querySource as any`，直接使用 `querySource === 'repl_main_thread' || querySource === 'sdk'`；如要同时匹配 `repl_main_thread:*`，使用 `querySource.startsWith('repl_main_thread')`，不再做宽泛断言。

### 注意事项

- 不要把所有 `as any` 都归因为 `result.message` 类型不精确；否则会遗漏 hook attachment 和 `querySource` 两类问题。
- 类型守卫中的断言应使用具体结构类型，避免从 `as any` 变成另一个宽泛断言。
- 仅做类型收窄和小型辅助函数抽取，不顺带改 hook 执行流程。

### 预估

半天到 1 天。无外部 API 变更，但需要跑 `bun tsc --noEmit` 验证类型收窄是否完整。

### 优先级

**高** — 类型安全是项目核心规约，改动集中在一个文件，但需按类别处理，不能机械替换。

---

## 2. `query/` 旧文件英文注释与用户可见英文文案治理

### 现状

`query/{transitions,config,deps,stopHooks}.ts` 中仍有大量英文注释，违反 AGENTS.md §1。这些是本轮拆分时未触碰的旧文件。

| 文件 | 英文注释数 |
|------|-----------|
| `transitions.ts` | 3 处（全文英文 JSDoc） |
| `config.ts` | 3 处（英文块注释） |
| `deps.ts` | 4 处（大段英文注释） |
| `stopHooks.ts` | 12+ 处（英文行注释/块注释） |

同时要注意，`stopHooks.ts` 中还存在部分英文硬编码文案，例如 stop hook 相关错误、阻断原因和通知文本。若这些文本会展示给用户或进入 transcript，应按 AGENTS.md §1 / §2 迁移到 i18n，而不是只翻译注释。

### 方案

逐文件处理，分两类：

1. **注释翻译**
   - 保留专有名词（React/Ink/MCP/SDK/GrowthBook/Statsig 等）
   - 保留编译器指令（`@ts-ignore`/`biome-ignore` 等）
   - JSDoc 注释中的参数名和类型标注保持英文
2. **用户可见英文文案治理**
   - 先确认文案是否用户可见、是否进入 transcript 或通知
   - 确认用户可见后，通过 `tSync()` / `t()` 读取翻译
   - 翻译 key 同时写入 `src/i18n/locales/en/` 与 `src/i18n/locales/zh-CN/` 对应模块文件
   - stop hook 通知文案优先放入现有 `misc.ts` 或新建更聚焦的 `hooks.ts` 翻译模块；如果新建模块，需要同步更新 i18n 聚合导出
   - 已确认 `stopHooks.ts` 至少有 4 处英文硬编码：`Stop hook prevented continuation`、`TaskCompleted hook prevented continuation`、`TeammateIdle hook prevented continuation`、`Stop hook error occurred · {shortcut} to see`
   - `Stop hook error occurred · {shortcut} to see` 通过 `toolUseContext.addNotification` 展示给用户，必须迁移到 i18n
   - 三个 `prevented continuation` 默认原因会写入 `hook_stopped_continuation` attachment 的 `message` 字段，应在实现时追踪该 attachment 的渲染/转录路径：若用户可见则迁移到 i18n；若仅作为结构化内部原因，则保持稳定英文值并另行增加用户可见翻译

### 预估

1-2 小时处理注释；若包含 i18n 文案迁移，需要额外预留验证时间。

### 优先级

**中** — 注释翻译风险低；i18n 迁移需确认渲染路径，避免误改模型上下文或结构化数据。

---

## 3. `utils/` 目录边界 — 业务领域整理

### 现状

`src/utils/` 中有大量文件违反 AGENTS.md §12（"仅放无业务语义的纯函数 helper"），包含网络 IO、文件系统写入、子进程、特定领域知识。这是历史包袱——项目早期所有代码都在 `utils/` 下。

**最严重的 3 个子目录**（应整体迁移到 `services/`）：

| 子目录 | 行数 | 领域 | 建议目标 |
|--------|------|------|----------|
| `utils/plugins/` | ~12000 | 插件系统（marketplace/loader/schema/安装管理） | `services/plugins/` |
| `utils/permissions/` | ~5000+ | 权限系统（分类器/策略/文件系统规则） | `services/permissions/` |
| `utils/hooks/` | ~3000+ | Hook 执行引擎（命令运行/MCP hook/agent hook） | `services/hooks/` |

**独立大文件**（各含多种违规）：

| 文件 | 行数 | 违规类型 | 建议 |
|------|------|----------|------|
| `utils/attachments.ts` | 3638 | 超行+领域逻辑 | 按功能拆分（memory/file/tool_result/context 等） |
| `utils/config.ts` | 1678 | 超行+文件写入 | → `services/config/read.ts` + `services/config/write.ts` 或 `src/config/read.ts` + `src/config/write.ts` |
| `utils/auth.ts` | 1499 | 网络+文件+领域 | → `services/auth/` |
| `utils/teleport.tsx` | 1450 | 网络+子进程+UI | 与现有 `services/teleport/`（`api.ts`、`gitBundle.ts`、`environments.ts`、`environmentSelection.ts`）整合 |
| `utils/ide.ts` | 1429 | 网络+安装 | → `services/ide/` |
| `utils/worktree.ts` | 1432 | 子进程+领域 | → `services/worktree/` |
| `utils/sessionStorage/` | ~3400+ | 文件写入+领域 | 已在 `services/` 下有 `sessionTranscript`，整合 |

### 方案

**不做批量迁移**（每个文件涉及 50+ 处 import 路径更新，风险高、ROI 低）。

改为**增量策略**：
1. **新代码一律放 `services/`**（AGENTS.md 已规定，持续执行即可）
2. **重构时顺带迁移**：当因功能需求修改某个 utils 文件时，顺带将其迁移到正确位置
3. **插件目录不作为第一批试点迁移**：已核实 `utils/plugins/` 外部引用至少 54 处，且当前已有 `src/services/plugins/`（包含 `pluginOperations.ts`、`pluginCliCommands.ts`、`PluginInstallationManager.ts`）。因此插件系统不是完全自包含目录，不适合作为低风险首个迁移 PR。后续若迁移，应按以下方式拆分：
   - 先盘点 `utils/plugins/` 与现有 `services/plugins/` 的职责边界，避免形成两个并行插件服务层
   - 优先把新插件业务逻辑放入现有 `services/plugins/`
   - 原 `utils/plugins/` 保留兼容 re-export 或轻量转发，避免一次性改动 50+ 外部 import
   - 分模块迁移外部 import，每次只迁移一个子领域（如 marketplace、installed plugins、cache）
   - 最后确认无旧路径引用后再删除旧路径

### 优先级

**低** — 历史包袱，增量治理比批量迁移更安全。

---

## 4. `utils/` 超行文件治理

### 现状

27 个 `src/utils/` 文件超过 800 行上限。Top 10：

| 文件 | 行数 |
|------|------|
| `attachments.ts` | 3638 |
| `plugins/pluginLoader.ts` | 3053 |
| `plugins/marketplaceManager.ts` | 2501 |
| `sessionStorage/logLoading.ts` | 2489 |
| `config.ts` | 1678 |
| `permissions/filesystem.ts` | 1628 |
| `plugins/schemas.ts` | 1559 |
| `Cursor.ts` | 1512 |
| `auth.ts` | 1499 |
| `teleport.tsx` | 1450 |

### 方案

同 §3 的增量策略。当因功能需求触碰某个超行文件时，按以下原则拆分：
- 按读/写分离（如 `utils/config.ts` → `services/config/read.ts` + `services/config/write.ts`，或 `src/config/read.ts` + `src/config/write.ts`，不能继续拆到 `src/utils/` 下）
- 按子领域分离（如 `attachments.ts` → `services/attachments/{memory,file,tool,context}.ts` 或 `src/attachments/{memory,file,tool,context}.ts`）
- 拆分后原文件保留为 barrel reexport（避免破坏外部 import）

### 风险控制

- 迁移 PR 尽量只移动目录和修 import，不顺带拆分复杂逻辑。
- 拆分 PR 尽量只拆文件和补测试，不顺带移动目录。
- 只有文件很小、引用很少时，才允许迁移和拆分合并到同一个 PR。

### 优先级

**低** — 增量治理。

---

## 5. `utils/` 网络请求集中化

### 现状

15+ 个 `src/utils/` 文件直接 `import axios` 做 HTTP 请求：

`teleport.tsx` / `autoUpdater.ts` / `ide.ts` / `proxy.ts` / `preflightChecks.tsx` / `releaseNotes.ts` / `apiPreconnect.ts` / `plugins/installCounts.ts` / `plugins/officialMarketplaceGcs.ts` / `plugins/marketplaceManager.ts` / `plugins/mcpbHandler.ts` / `hooks/execHttpHook.ts` 等。

### 方案

**不做集中化改造**。`axios` 是项目标准 HTTP 库，各文件直接 import 是合理的（类似于 `import fs`）。真正的问题不是"import 了 axios"，而是"含 IO 的文件放在了 utils/ 下"——这归到 §3 的目录边界问题。

### 优先级

**不做** — 非真正问题。

---

## 落地顺序

```
1. [高]  stopHooks.ts as any 消除 — 半天到 1 天；复用现有 message 类型守卫，补 hook attachment 局部守卫，移除 querySource 宽泛断言
2. [中]  query/ 英文注释与用户可见英文文案治理 — 1-2 小时起；通知文案必须走 i18n，结构化 stop reason 按渲染/转录路径判定
3. [低]  utils/ 目录边界增量治理 — 按需；插件目录不作为第一批试点，优先处理引用少、职责清晰的模块
4. [低]  utils/ 超行文件拆分 — 按需；迁移和拆分默认拆 PR，避免范围失控
5. [不做] utils/ 网络请求集中化 — 非真正问题
```
