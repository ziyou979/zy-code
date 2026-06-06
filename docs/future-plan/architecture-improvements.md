# 项目架构待改进点

> 最后更新：2026-06-06
> 基于当前仓库代码结构实测分析。

## 已完成的改进（归档记录）

### 2026-05 完成

- ~~顶层启动 root.ts 拆分~~ → `cli/assembly/` 抽出 6 个模式模块
- ~~REPL.tsx 过重~~ → 6200 行拆到 1338 行 + `screens/repl/` 26 个子模块
- ~~全局状态 state.ts 单体~~ → 按域拆为 `bootstrap/state/` 8 个子模块
- ~~缺少架构导航图~~ → `docs/architecture-map.md` 已建立

### 2026-06 完成

- ~~query.ts 拆分~~ → 1745→1332 行（-24%），新增 `query/{preprocess,compaction,toolExecution,attachments,recovery}.ts` 5 个子模块
- ~~常开 feature flag 清理~~ → 移除 REACTIVE_COMPACT/TOKEN_BUDGET/CONTEXT_COLLAPSE 的冗余 if 门控，feature() 调用从 18→9
- ~~utils/messages/api.ts 拆分~~ → 2718→20 行 barrel，拆为 `apiNormalize.ts`(981) + `attachmentApi.ts`(1223) + `systemReminder.ts`(29)
- ~~Plan/Auto Mode 迁移~~ → 从 `utils/` 迁到 `services/modeInstructions/{planMode,autoMode}.ts`（修复 AGENTS.md §12 违规）
- ~~root.ts 瘦身~~ → 3409→2443 行（-28%），`options: any` 类型化为 `RootActionOptions`（70 字段），20 处 `as {}` 断言清除，新增 `assembly/{resumeDispatch,assistantChatMode,headlessMode}.ts` 3 个模块
- ~~AGENTS.md 规约修复~~ → 20 处英文注释、`as any`、`Array.isArray` 守卫、`feature()` 宏

---

## 仍可改进的方向

### 1. 扩展点诊断视图

**现状**：同时存在 Commands/Tools/Plugins/Skills/MCP 5 套扩展机制，用户无法一览当前加载了哪些扩展。

**方案**：新建 `src/services/diagnostics/extensionInventory.ts`，导出 `getExtensionInventory()` 收集所有激活扩展的名称/来源/状态，给 `/status` 命令的 Status tab 使用。

**优先级**：低 — 各扩展面独立运作良好。

### 2. compact/contextCollapse 合并

**现状**：`services/contextCollapse/`（595 行）和 `services/compact/`（4000+ 行）在 `query.ts` 中总是联动出现。collapse 是 compact 的零 LLM 层级。

**方案**：将 `contextCollapse/` 移入 `compact/` 作为子目录。

**优先级**：低 — 目录结构不影响开发效率。

### 3. attachmentApi.ts 进一步拆分

**现状**：`utils/messages/attachmentApi.ts` 仍有 1223 行（Plan/Auto Mode 已迁出），超出 800 行限制。剩余内容是 `normalizeAttachmentForAPI`（~830 行的 40+ case switch）和 `ensureToolResultPairing`（~300 行）。

**方案**：按 attachment type 分组拆分 switch：
- `attachmentApi/toolResult.ts` — tool_result/tool_use 相关 case
- `attachmentApi/fileChange.ts` — edited_text_file/file_reference 相关 case
- `attachmentApi/hook.ts` — hook_result/hook_error 相关 case
- `attachmentApi/index.ts` — switch 入口 + ensureToolResultPairing

**优先级**：低 — switch 内各 case 独立，不常同时修改多个 case。

---

## 不再建议继续的方向

### root.ts 继续瘦身

root.ts 已从 3409 降到 2443 行（-28%）。剩余代码是严格顺序的启动管线，每一步依赖前一步的 `let` 累加变量。继续拆分只增加参数传递开销和阅读时的文件跳转，不增加扩展性。

### Feature flag 矩阵文档

query.ts 中的常开 flag 已清理（18→9），剩余 9 个中 4 个是条件 require（必须保留），5 个是常关 flag（构建时 DCE 消除）。root.ts 中的 feature flag 是 KAIROS/COORDINATOR 等内部功能门控，随功能生命周期自然消亡，不需要独立文档。

### 统一错误边界

各扩展面的错误处理已在各自域内标准化（toolExecution.ts、pluginLoader 异常隔离、MCP error protocol）。额外包装 `withExtensionBoundary` 会增加间接层但不改善行为。
