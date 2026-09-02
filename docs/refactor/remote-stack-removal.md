# 远端会话栈删除计划

> 状态：**待执行**（等当前分支 WIP 提交后开工）
> 背景决策：zy-code 尚未建设服务端、不具备远程能力。远端会话栈系从上游继承，
> 所有相关 feature flag 默认 `false`，本地主链路的触发点均为条件分支——删除行为中性。
> 范围决策（2026-09-02）：**只删远端会话栈，保留 zy.ai OAuth 登录与依赖登录的轻功能**。

## 甄别结论（先读）

以下模块**看似远端实则必须保留/拆分**：

| 模块 | 结论 | 依据 |
|---|---|---|
| `src/services/file-persistence/` | **拆分保留** | `fileHistory`（undo/rewind）、`fileStateCache`、`fileRead`、`readEditContext`、`readFileInRange`、`jsonRead`（`utils/json.ts` 依赖其 `stripBOM`）、`tempfile` 被本地 REPL/queryEngine/tools/组件广泛使用；仅 `filePersistence.ts`（经 filesApi 上传）是远端路径 |
| `src/remote/messageAdapter.ts`、`remotePermissionBridge.ts` | **保留** | 被 `useSSHSession`、`useDirectConnect` 使用；SSH/直连是连用户自己的服务器，与 zy.ai 后端无关（`SSH_REMOTE` 是独立特性） |
| `src/remote/remoteSessionManager.ts` | **删除** | 基于 zy.ai Sessions API（import `services/teleport/api`），仅 `zy_remote_backend`（false）路径使用 |
| `src/bridge/trustedDevice.ts` | **保留** | `login.tsx` / `logout.tsx` 的可信设备流程，属账号体系 |
| `src/services/auth/sessionIngressAuth.ts` | **删除** | 仅远程传输层使用；`MCPSettings.tsx` / `mcp/client/transport.ts` / `prepareRootAction.ts` 的引用点随分支条件一并拆除 |
| `src/services/api/filesApi.ts` | **删除** | 容器附件下载（`ZY_CODE_SESSION_ACCESS_TOKEN` 门）+ teleport seed bundle 上传 + filePersistence 上传，全部远端路径 |
| `src/services/bridge/bridgeEventQueue.ts` | **批次内确认** | `emitTaskTerminatedBridge` 被 `stopTask`/`localMainSessionTask`/`useCancelRequest` 调用；确认无 bridge 时为 no-op 后删除调用点与实现 |
| `src/services/api/adminRequests.ts`、`zyai.ts`、`settings-sync`、`remote-managed-settings` | **保留** | 登录后轻功能（范围决策） |

## 批次划分（自叶向根，每批后跑 `bun run format` + `bun tsc --noEmit` + `bun test`）

### B1 — 独立叶子（无外部反向依赖，直接删）
- `src/tools/RemoteTriggerTool/`（gate `zy_remote_trigger`=false）
- `src/commands/remote-setup/`
- `src/services/background/remote/`
- `src/assistant/sessionHistory.ts` + `src/hooks/useAssistantHistory.ts` 的 sessionHistory 分支
- `src/services/api/sessionIngress.ts` + 调用点 `commands/clear/caches.ts:20`
- `src/skills/bundled/scheduleRemoteAgents.ts` + 其注册点

### B2 — teleport 集群
- `src/services/teleport/`（api/environments/teleport.tsx/gitBundle/prerequisites/environmentSelection）
- 调用点：`commands/index.ts:50`（/teleport 注册）、`ultraplan.tsx:32`（剥离远程分支，保留本地 plan）、`review/reviewRemote.ts`、`hooks/useTeleportResume.tsx`、`ResumeTask.tsx`、`RemoteSessionDetailDialog.tsx`、`Teleport*` 三组件、`RemoteEnvironmentDialog.tsx`、`resumeDispatch.ts` / `assistantChatMode.ts` 的 `prepareApiRequest` 分支
- `src/cli/assembly/resumeDispatch.ts:209` `zy_remote_backend` 分支删除

### B3 — 传输层 + remoteIO
- `src/cli/transports/`（sseTransport/ccrClient/hybridTransport/replBridgeTransport/transportUtils/serialBatchEventUploader/workerStateUploader；`transport.ts` 接口如仅远程使用则一并删）
- `src/cli/remoteIO.ts`；`print.ts:2227-2231` 恢复为无条件 `StructuredIO`
- `src/cli/headless/turnLoop.ts` 的 `RemoteIO`/`executeFilePersistence` 分支；`controlLoop.ts:36-44` bridge 分支
- `src/services/file-persistence/filePersistence.ts` + `prepareRootAction.ts:413-438` 附件下载分支 + `filesApi.ts`
- `src/services/auth/sessionIngressAuth.ts`；`mcp/client/transport.ts:101-103` ingress 分支直连；`MCPSettings.tsx:14`

### B4 — bridge 主体
- `src/bridge/` 除 `trustedDevice.ts` 外全部（含 bridge-main/、workSecret、codeSessionApi、envLessBridgeConfig、bridgeEnabled、bridgeStatusUtil、bridgeConfig、bridgeDebug、inboundMessages、inboundAttachments、pollConfig、jwtUtils、bridgePermissionCallbacks 等——后者被 `AppStateStore.ts:3` / `interactiveHandler.ts:5` 以 type 引用，需先解耦）
- `src/remote/remoteSessionManager.ts` 及 `directConnectManager.ts` / `screens/REPL.tsx:139` 等类型引用
- 调用点：`automation.ts:73`（zy remote-control 子命令）、`loadRootResources.ts:419`、`main.tsx` remote 入口、`commands/bridge/`、`bridgeKick.ts`、`useReplBridge` hook、`PromptInputFooter`/`Spinner`/`BridgeDialog`/`Config.tsx`/`RemoteCallout` 的 bridge 状态条
- `services/bridge/bridgeEventQueue.ts`（先确认 no-op 语义）

### B5 — 常量、flag、文档收尾
- `constants/betas.ts`：`CCR_BYOC_BETA_HEADER`（如无剩余引用）；`services/http/authHeaders.ts`：`buildSessionApiHeaders`（同理；`buildOAuthApiHeaders` 视保留方需求）
- `FEATURE_FLAGS.md`：删 `zy_remote_git_diff`、`zy_remote_trigger`、`zy_remote_backend`、`zy_bridge_system_init`、`zy_ccr_bundle_seed`、`zy_ccr_bridge_multi_session` 及代码内 gate
- `docs/architecture.md`、`docs/architecture-map.md`：移除 bridge/teleport/remote 条目
- i18n：清理仅被删除文件引用的翻译键
- growthbook/telemetry：`zy_remote_*` 事件埋点清理

## 前置条件（硬性）

1. **当前分支 WIP 必须先提交**：`fix/login-and-token-stats` 有 163 个文件未提交改动，其中
   `src/bridge/*`、`print.ts`、`SSETransport`、`ccrClient`、`codeSessionApi`、`workSecret` 等
   与待删文件重叠——不提交就删会丢弃未提交的工作。
2. 删除在新分支执行（建议 `chore/remove-remote-session-stack`），每批一个 commit，便于回滚。

## 风险点

- `AppStateStore` / 权限交互处理器对 bridge 类型的引用是共享状态核心，B4 需要先做类型解耦
- `utils/json.ts → file-persistence/jsonRead` 证明「目录名含 remote/file 」不等于可删，每批删前重新核对反向引用
- `bun:bundle feature()` 宏引用（`betas.ts` 等）删除时注意 build 侧 define 宏不受影响（不手改 `build.ts`）
- ultraplan / review 与远程的耦合是产品行为：剥离远程分支会改变这两个命令在开启 gate 时的表现——默认 false，行为中性，但需在 commit message 里注明

## 进度

- [ ] B1
- [ ] B2
- [ ] B3
- [ ] B4
- [ ] B5
