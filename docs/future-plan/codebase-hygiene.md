# 代码卫生与规范治理

> 创建时间：2026-06-06
> 基于全项目系统性审计，覆盖跨文件重复、AGENTS.md 规范违规、类型安全。

---

## 已完成

无（新建文档）

---

## 1. `stopHooks.ts` 消除 15 处 `as any` 滥用

### 现状

`src/query/stopHooks.ts` 中有 15 处 `as any` 在业务逻辑中，违反 AGENTS.md §9。核心问题是 `executeStopHooks` / `executeTeammateIdleHooks` 返回的 `result.message` 类型不够精确——代码用 `(result.message as any).type === 'progress'` 做运行时判断。

重复模式（出现 3+ 次）：
```typescript
(result.message as any).type === 'progress'
(result.message as any).toolUseID
(result.message as any).type === 'attachment'
(result.message as any).attachment
```

### 方案

1. 在 `src/types/message.ts` 中确认 `ProgressMessage` 和 `AttachmentMessage` 的类型定义是否已有 `type` 鉴别字段
2. 在 `stopHooks.ts` 中引入类型守卫函数（复用或新建）：
```typescript
import { isProgressMessage, isAttachmentMessage } from '../types/message.js'
// 或定义局部守卫：
function isProgressMessage(msg: unknown): msg is ProgressMessage {
  return typeof msg === 'object' && msg !== null && (msg as Record<string, unknown>).type === 'progress'
}
```
3. 替换所有 15 处 `as any` 为类型守卫调用
4. 抽取重复的 `stopHookToolUseID` 提取逻辑为辅助函数（消除 3 处重复的 toolUseID 提取模式）

### 预估

半天。无外部 API 变更。

### 优先级

**高** — 类型安全是项目核心规约，改动集中在一个文件。

---

## 2. `query/` 旧文件英文注释翻译

### 现状

`query/{transitions,config,deps,stopHooks}.ts` 中仍有大量英文注释，违反 AGENTS.md §1。这些是本轮拆分时未触碰的旧文件。

| 文件 | 英文注释数 |
|------|-----------|
| `transitions.ts` | 3 处（全文英文 JSDoc） |
| `config.ts` | 3 处（英文块注释） |
| `deps.ts` | 4 处（大段英文注释） |
| `stopHooks.ts` | 12+ 处（英文行注释/块注释） |

### 方案

逐文件翻译。注意：
- 保留专有名词（React/Ink/MCP/SDK/GrowthBook/Statsig 等）
- 保留编译器指令（`@ts-ignore`/`biome-ignore` 等）
- JSDoc 注释中的参数名和类型标注保持英文

### 预估

1-2 小时。纯文本修改，零风险。

### 优先级

**中** — 规约合规，改动简单。

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
| `utils/config.ts` | 1678 | 超行+文件写入 | 拆为 `config/read.ts` + `config/write.ts` |
| `utils/auth.ts` | 1499 | 网络+文件+领域 | → `services/auth/` |
| `utils/teleport.tsx` | 1450 | 网络+子进程+UI | → `services/teleport/`（已有同名空目录） |
| `utils/ide.ts` | 1429 | 网络+安装 | → `services/ide/` |
| `utils/worktree.ts` | 1432 | 子进程+领域 | → `services/worktree/` |
| `utils/sessionStorage/` | ~3400+ | 文件写入+领域 | 已在 `services/` 下有 `sessionTranscript`，整合 |

### 方案

**不做批量迁移**（每个文件涉及 50+ 处 import 路径更新，风险高、ROI 低）。

改为**增量策略**：
1. **新代码一律放 `services/`**（AGENTS.md 已规定，持续执行即可）
2. **重构时顺带迁移**：当因功能需求修改某个 utils 文件时，顺带将其迁移到正确位置
3. **子目录优先迁移**：`utils/plugins/` → `services/plugins/` 可以作为一个独立 PR，因为它是自包含的子目录（内部相互引用，外部引用点可用 barrel reexport 兼容）

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
- 按读/写分离（如 `config.ts` → `config/read.ts` + `config/write.ts`）
- 按子领域分离（如 `attachments.ts` → `attachments/{memory,file,tool,context}.ts`）
- 拆分后原文件保留为 barrel reexport（避免破坏外部 import）

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
1. [高]  stopHooks.ts as any 消除 — 半天，类型安全核心规约
2. [中]  query/ 英文注释翻译 — 1-2 小时，纯文本
3. [低]  utils/ 目录边界增量治理 — 按需，跟随功能开发顺带迁移
4. [低]  utils/ 超行文件拆分 — 按需，跟随功能开发顺带拆分
5. [不做] utils/ 网络请求集中化 — 非真正问题
```
