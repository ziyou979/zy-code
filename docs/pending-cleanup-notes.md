# 全项目历史改版残留与规范收口记录（临时文档）

> 创建日期：2026-11-08
> 背景：在排查会话恢复截断与思考块折叠渲染问题时，对全项目进行了历次重构残留与开发规范（`AGENTS.md` / `docs/development-guidelines.md`）扫描。为控制当前功能分支的改动面与风险，以下全仓范围的清理项暂缓在当前分支执行，留待后续独立 chore 分支批量收口。

---

## 一、本分支已完成的治本修复与清理

1. **`session-storage` 写入端竞态与断链根治**
   - `src/services/session-storage/transcript.ts`：引入 `enqueueTranscriptOp` 串行化 `recordTranscript` 与 `removeTranscriptMessage`，消除 `insertMessageChain` 内 `await getBranch()` 异步窗口期 `messageSet` 尚未更新导致的并发去重失效与 `parentUuid=null` 断链；当 `startingParentUuidHint` 缺失或不在 `messageSet` 中时，自动从 `allMessages` 向前回溯查找最后一条真实已落盘的链参与者。
   - `src/services/session-storage/project.ts`：`removeMessageByUuid` 物理删除 tombstone 消息时，同步从内存 `getSessionMessages` 缓存集合中删除该 UUID。
   - `src/hooks/useLogMessages.ts`：新增 `lastTailUuidRef` 校验 `messages[prevLength - 1]?.uuid` 是否保持不变，避免同批次“tombstone 删除 + fallback 新消息追加”因长度不变被误判为纯追加 `isIncremental`；并将文件内中英混杂注释统一为中文。
2. **`session-storage` 读取端大文件预过滤与半吊子冷热分离清理**
   - `src/services/session-storage/logLoading.ts`：`walkChainBeforeParse` 在遇到非空但不存在于当前文件的悬挂 `parentUuid`（如 tombstone 移除或未落盘恢复哨兵）时，与 `repairBrokenParentUuidChains` 保持同构，桥接到前一条非 sidechain 主消息继续向根回溯，避免把断链前的全部历史当成死分支裁掉。
   - `src/services/session-storage/sessionStoragePortable.ts`：清理默认保留冷历史路径下仍给 `boundaryStartOffset` 赋值的半吊子逻辑，消除 >5MB 会话加载时 `scanPreBoundaryMetadata` 对文件前段的无意义二次磁盘读取与重复解析。
3. **`src/services/session-storage/` 全目录及当前改动组件的导入规范化**
   - 消除了 `src/services/session-storage/` 内部从父级桶文件 `../sessionStorage.js` 反向导入造成的循环依赖（`conversationRecovery.ts`、`crossProjectResume.ts`、`sessionRestore.ts`）。
   - 清理了 `src/services/session-storage/` 全目录及 `Messages.tsx`、`MessageRow.tsx`、`MessageActions.tsx`、`CollapsedReadSearchContent.tsx` 中的 `from 'src/...'` 非相对导入与 `messages/./*.js` 脏路径。

---

## 二、待后续独立分支批量处理的遗留项

### 1. 拆分 `services/messages/` 时遗留的 `/./` 脏导入路径（84 个文件，106 处）

- **现象**：大量文件中存在形如 `from '../../services/messages/./constructors.js'`、`from '../services/messages/./predicates.js'` 的导入路径（路径中间夹带 `/./`），系早期拆分 `src/services/messages.ts` 时批量正则替换留下的痕迹。
- **风险评估**：纯机械替换（将 `messages/./` 替换为 `messages/`），零运行时行为变更，但涉及 84 个文件，建议单独提交一个 `chore: normalize messages import paths` PR。
- **涉及的主要目录**：
  - `src/cli/`（`directConnectMode.ts`、`interactiveMode.ts`、`sshMode.ts`、`buildRootSession.ts`）
  - `src/commands/`（`copy.tsx`、`insights/`、`login.tsx`、`permissions.tsx`、`rename/`）
  - `src/components/`（`CompactSummary.tsx`、`FeedbackSurvey/`、`Markdown.tsx`、`Message.tsx`、`MessageSelector*.tsx`、`messages/`、`permissions/`、`PromptInput/` 等）
  - `src/hooks/`（`useAwaySummary.ts`、`useInboxPoller.ts`、`useIssueFlagBanner.ts`、`useScheduledTasks.ts`、`useSkillImprovementSurvey.ts`、`tool-permission/`）
  - `src/query/`（`stopHooks.ts`、`toolExecution.ts`）
  - `src/screens/`（`REPL.tsx`、`ResumeConversation.tsx`、`repl/*`）
  - `src/services/`（`analytics/stats.ts`、`api/api.ts`、`assistant/sideQuestion.ts`、`compact/*`、`query/queryHelpers.ts`、`session-transcript/transcriptSearch.ts`、`shell/promptShellExecution.ts`、`tool-runtime/toolErrors.ts`）
  - `src/tools/`（`AgentTool/*`、`FileReadTool/`、`GrepTool/`、`LSPTool/`、`SkillTool/`、`TaskOutputTool/`）

### 2. 非相对路径导入 `from 'src/...'` 混用（全仓 250+ 个文件）

- **现象**：违反 `AGENTS.md` 与 `docs/development-guidelines.md` 中“相对导入必须带 `.js`”的约定，全仓有 250 余个文件混用了 `from 'src/...'` 路径别名与 `../../` 相对路径（甚至同一文件的前两行用 `src/...`、后几行用 `../../`）。
- **处理建议**：可编写一个小脚本按文件所在目录计算相对路径并统一转换为带 `.js` 后缀的相对导入，分模块（如 `src/services/`、`src/components/`、`src/cli/`）分批提交并配合 `bun tsc --noEmit` 验证。

### 3. 兼容桶文件 `src/services/sessionStorage.ts` 与冷热分离历史补丁的进一步收敛

- **兼容桶文件**：
  - `src/services/sessionStorage.ts` 目前作为 `src/services/session-storage/*` 7 个子模块的聚合重导出桶，仍被全仓多处外部模块引用，且受 `tests/api-snapshot/sessionStorage.snapshot.txt` 锁定。
  - 内部子模块反向引用 `../sessionStorage.js` 的问题已在本次清理完毕；外部模块后续可按域逐步改为直接引用 `src/services/session-storage/` 下的具体子模块，最后移除聚合桶。
- **`compact_boundary` 链结构与冷热分离三层兜底的演进方向**：
  - 目前 `insertMessageChain` 在写入 `compact_boundary` 时仍沿用旧版“截断冷历史”的设计，将 `parentUuid` 置为 `null`（真实父节点存于 `logicalParentUuid`）。
  - 为在 UI 上保留冷历史，读取端在 `walkChainBeforeParse`、`repairBrokenParentUuidChains`、`prependColdHistoryBeforeCompactBoundary` 三处维护了冷段拼接逻辑。
  - 在本次修复了写入端 `recordTranscript` 串行化与父节点回溯后，新生成的 transcript 已不再产生意外的 `parentUuid=null` 热段碎片；后续若统一让 `buildConversationChain` 在冷历史回溯阶段直接识别 `compact_boundary.logicalParentUuid`，可大幅简化 `prependColdHistoryBeforeCompactBoundary` 的按序扫描兜底（仅保留对旧版已落盘损坏文件的兼容）。
