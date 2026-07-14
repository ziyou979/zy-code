# 项目架构待改进点

> 最后更新：2026-06-10
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
- ~~扩展点诊断视图~~ → `src/services/diagnostics/extensionInventory.ts`，`/status` Status tab 展示 commands/tools/plugins/skills/mcp 扩展数量
- ~~compact/context-collapse 合并~~ → `contextCollapse/` 移入 `compact/context-collapse/`，原位 barrel re-export
- ~~attachmentApi.ts 拆分~~ → `ensureToolResultPairing`（300 行）提取至 `attachmentApi/toolResultPairing.ts`，下游直接引用新位置，原文件 1223→889 行

---

## 仍可改进的方向

（无。所有已识别的改进项均已完成或归入"不再建议"。）

---

## 不再建议继续的方向

### root.ts 继续瘦身

root.ts 已从 3409 降到 2443 行（-28%）。剩余代码是严格顺序的启动管线，每一步依赖前一步的 `let` 累加变量。继续拆分只增加参数传递开销和阅读时的文件跳转，不增加扩展性。

### Feature flag 矩阵文档

query.ts 中的常开 flag 已清理（18→9），剩余 9 个中 4 个是条件 require（必须保留），5 个是常关 flag（构建时 DCE 消除）。root.ts 中的 feature flag 是 KAIROS/COORDINATOR 等内部功能门控，随功能生命周期自然消亡，不需要独立文档。

### 统一错误边界

各扩展面的错误处理已在各自域内标准化（toolExecution.ts、pluginLoader 异常隔离、MCP error protocol）。额外包装 `withExtensionBoundary` 会增加间接层但不改善行为。
