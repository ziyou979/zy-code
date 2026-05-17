# zy-super 本地构建依赖分析

> 分析时间：2026-05-01
> 分析范围：186 个文件中 `isInternalBuild()` 的所有使用场景

## 1. 核心认知

`isInternalBuild()` 定义在 `src/utils/envUtils.ts`，通过 `process.env.USER_TYPE === 'zy-super'` 判断。`USER_TYPE` 是构建时 `--define` 宏（`bun build` 传入），外部构建中被替换为 `'external'`。

**这本质上是一个编译时死代码消除（DCE）门控**：外部构建中 `isInternalBuild()` 永远是 `false`，Bun 打包器会将所有内部代码路径 Tree-shaking 移除。因此**构建本身不会因为缺少内部基础设施而失败**，运行时最多功能不可用，不会崩溃。

此外，还有 `feature()`（`bun:bundle`）作为平行的编译时门控，在 `bun build` 时被静态解析为 `true`/`false`。

---

## 2. `isInternalBuild()` 使用场景分类

### 2.1 GrowthBook / Feature Flags（~25 处）

**涉及文件**：`services/analytics/growthbook.ts`, `services/analytics/zyEventLogger.ts`, `services/analytics/index.ts`, `utils/user.ts`

| 行为差异 | 内部（zy-super） | 外部（external） |
|----------|-----------------|-----------------|
| GB 刷新间隔 | 20 分钟 | 6 小时 |
| GB API host 基础 URL | `process.env.ZY_CODE_GB_BASE_URL` | 空字符串（走默认 CDN） |
| 功能覆盖（env/config overrides） | `CLAUDE_INTERNAL_FC_OVERRIDES` + `growthBookOverrides` 持久化 | 不解析/不持久 |
| 调试日志 | 记录所有 GB 调用返回值、初始化源 | 静默 |
| 邮箱来源回退 | `oauthAccount.emailAddress` | 无此回退 |
| `userType` 字段 | `'internal'` | `'external'` |
| 事件日志启动 | 始终启动（无 GB 门控） | 需 GB gate `zy_1p_event_batch_config` |
| `analytics_sink_attached` 事件 | 发送 | 不发送 |

### 2.2 API Client / 网络请求（~10 处）

**涉及文件**：`services/api/client.ts`, `services/api/errors.ts`, `services/api/withRetry.ts`, `services/api/zy.ts`, `services/api/dumpPrompts.ts`

| 行为差异 | 内部 | 外部 |
|----------|------|------|
| Staging OAuth 时 Anthropic client baseURL | 从 `getOauthConfig().BASE_API_URL` 取 | 不覆盖 |
| 重试策略：x-should-retry:false 对 5xx | 允许重试 | 严格遵循响应头 |
| Mock 限速检查 | 介入 `withRetry.ts` | 不介入 |
| 内部 beta header（`CLI_INTERNAL_BETA_HEADER`） | 在 agentic 查询时附加 | 不附加 |
| 400 错误消息 | 增加 `/share` + Feedback Channel 指引 | 标准提示 |
| REST API 端点（CC R2 SDK） | 内部 SDK URL | 外部 SDK URL |

### 2.3 Telemetry / 遥测（~30 处）

**涉及文件**：`utils/telemetry/instrumentation.ts`, `utils/telemetry/bigqueryExporter.ts`, `utils/telemetry/sessionTracing.ts`, `services/analytics/datadog.ts`

| 行为差异 | 内部 | 外部 |
|----------|------|------|
| OTLP 指标导出端点 | `ANT_ZY_CODE_METRICS_ENDPOINT + /api/claude_code/metrics` | 本地控制台导出器 |
| BigQuery 导出 | 启用 `BigQueryMetricsExporter` | 不启用 |
| Datadog `env` 标签 | `'internal'` | `'external'` |
| Datadog 模型名归一化 | 不归一化（保留原始名称） | 归一化为静态定价名 |
| 增强遥测 | 始终启用 | 需 GrowthBook gate |
| event loop stall 检测器 | 导入并启动 | 不导入 |
| SDK 内存 dump 监控 | 导入并启动 | 不导入 |
| asciicast 终端录制 | 可安装 | 不安装 |
| `zy_internal_record_permission_context` 事件 | 发送 | 不发送 |

### 2.4 Bridge / Daemon 进程间通信（~15 处）

**涉及文件**：`bridge/bridgeMain.ts`, `bridge/initReplBridge.ts`, `bridge/replBridge.ts`, `bridge/sessionRunner.ts`, `bridge/bridgeConfig.ts`

| 行为差异 | 内部 | 外部 |
|----------|------|------|
| session-ingress URL | 可被 `CLAUDE_BRIDGE_SESSION_INGRESS_URL` 覆盖 | 仅用 baseUrl |
| 会话 debug 日志 | 输出到 `/tmp/zy/bridge-session-*.log` | 无 debug 文件 |
| Bridge 状态门控 | `replBridgeActive` 字段存在 | 该字段不存在 |

### 2.5 Permissions / 权限（~20 处）

**涉及文件**：`utils/permissions/PermissionMode.ts`, `utils/permissions/permissions.ts`, `utils/permissions/permissionSetup.ts`, `utils/permissions/yoloClassifier.ts`

| 行为差异 | 内部 | 外部 |
|----------|------|------|
| `auto` 权限模式 | 可用（含 `TRANSCRIPT_CLASSIFIER` feature） | 不可用 |
| `bubble` 权限模式 | 可用 | 不可用 |
| YOLO 分类器模板 | 使用 `permissions_anthropic.txt` | 仅用外部模板 |
| 分类器模型覆盖 | `ZY_CODE_AUTO_MODE_MODEL` 可覆盖 | 不可覆盖 |
| 危险权限模式检查 | 额外检查（coo, fa run 等） | 不予检查 |

### 2.6 OAuth / 认证（~5 处）

**涉及文件**：`constants/oauth.ts`, `utils/auth.ts`, `utils/secureStorage/keychainPrefetch.ts`

| 行为差异 | 内部 | 外部 |
|----------|------|------|
| OAuth 环境选择 | 可通过 `USE_LOCAL_OAUTH`/`USE_STAGING_OAUTH` 切换 | 始终 prod |
| 邮箱回退 | `COO_CREATOR@anthropic.com` / `git config user.email` | keychain 取不到就 undefined |

### 2.7 Model / Provider（~10 处）

**涉及文件**：`utils/model/providers.ts`, `utils/model/modelCapabilities.ts`, `utils/betas.ts`, `utils/advisor.ts`, `utils/effort.ts`

| 行为差异 | 内部 | 外部 |
|----------|------|------|
| auto 模式模型支持 | 任何模型都可 | 仅 GB allowModels 中列出的 |
| Advisor 功能 | 默认开启 | 需 `model-capabilities.json` 配置 |
| beta headers | 实验性开启 | 不自动开启 |
| 模型能力缓存持久化 | `~/.zy/model-capabilities.json` | 不持久化 |

### 2.8 Commands / 命令（~15 处）

**涉及文件**：`commands.ts`, `main.tsx`, `commands/commit.ts`, `commands/commit-push-pr.ts`

| 行为差异 | 内部 | 外部 |
|----------|------|------|
| `INTERNAL_ONLY_COMMANDS` | 全部注册 | 不注册 |
| `zy up`/`zy rollback` | 可用 | 不可用 |
| `zy ccshare`/`zy ccx` | 可用 | 不可用 |
| `zy task` | 可用 | 不可用 |
| 调试监控阻止 | `isBeingDebugged()` 后允许运行 | 检测到调试器就 `process.exit(1)` |

### 2.9 Startup / 初始化（~8 处）

**涉及文件**：`main.tsx`, `setup.ts`, `utils/startupProfiler.ts`

| 行为差异 | 内部 | 外部 |
|----------|------|------|
| `zy_ant_model_override` 检查 | 显式指定模型时触发 GB 初始化 | 跳过 |
| event loop stall 检测器 | 启动 | 不启动 |
| SDK 堆 dump 监控 | 后台启动 | 不启动 |
| 内部仓库分类温热 | `isInternalModelRepo()` 检查 | 跳过 |
| asciicast 录制器安装 | 安装 | 不安装 |

### 2.10 Settings / 配置（~10 处）

**涉及文件**：`utils/settings/settings.ts`, `utils/settings/applySettingsChange.ts`, `utils/settings/mdm/constants.ts`

| 行为差异 | 内部 | 外部 |
|----------|------|------|
| autoMode 中的 deny 规则 | 降级为 soft_deny | 直接拒绝 |
| MDM 用户偏好路径 | 允许 `~/Library/Preferences/com.anthropic.zycode.plist` | 不允许 |
| 过于宽泛的 Bash allow rules | 移除并 logging | 不处理 |

### 2.11 UI / 组件（~15 处）

**涉及文件**：`components/DevBar.tsx`, `components/Stats.tsx`, `components/MemoryUsageIndicator.tsx`, `components/Feedback.tsx`, `screens/REPL.tsx`

| 行为差异 | 内部 | 外部 |
|----------|------|------|
| DevBar | 包含慢速操作追踪、agent 状态 | 简化版 |
| Stats 数据 | 内部字段（`ant_enabled_plugins` 等） | 不含内部字段 |
| 反馈通道 | `#zy-code-feedback` | 外部通道 |

### 2.12 Tools（~15 处）

**涉及文件**：`tools.ts`, `tools/AgentTool/AgentTool.tsx`, `tools/BashTool/bashPermissions.ts`

| 行为差异 | 内部 | 外部 |
|----------|------|------|
| REPLTool | 注册 | 不注册 |
| SuggestBackgroundPRTool | 注册 | 不注册 |
| TungstenTool | 注册 | 不注册 |
| ConfigTool | 注册 | 不注册 |
| VerifyPlanExecutionTool | 注册 | 不注册 |
| PowerShellTool | 默认开启 | 需 `ZY_CODE_USE_POWERSHELL_TOOL=1` |

### 2.13 Skills / Plugins（~8 处）

**涉及文件**：`skills/bundled/skillify.ts`, `skills/bundled/stuck.ts`, `skills/bundled/debug.ts`, `hooks/useManagePlugins.ts`

| 行为差异 | 内部 | 外部 |
|----------|------|------|
| Bundled skill | 内部专用技能（stuck, debug, verify, skillify） | 可能不注册或有不同路径 |
| Plugin 遥测 | 记录 `ant_enabled_names` | 不记录 |

### 2.14 Session / Memory（~10 处）

**涉及文件**：`services/SessionMemory/sessionMemory.ts`, `services/compact/sessionMemoryCompact.ts`, `services/compact/apiMicrocompact.ts`

| 行为差异 | 内部 | 外部 |
|----------|------|------|
| SM gate 失效日志 | 记录 | 不记录 |
| SM compact debug 日志 | 记录 | 不记录 |
| API 最后请求消息留存 | 留存完整消息数组 | 不留存 |

### 2.15 其他（~5 处）

**涉及文件**：`utils/autoUpdater.ts`, `utils/releaseNotes.ts`, `utils/billing.ts`, `utils/claudeInChrome/`

| 行为差异 | 内部 | 外部 |
|----------|------|------|
| Version history | 获取内部 npm registry 版本列表 | 返回空数组 `[]` |
| Release notes | 构建时 `MACRO.VERSION_CHANGELOG` | 从 GitHub API 拉取 |
| Max version 上限 | 读取 `ant`/`ant_message` 字段 | 读取 `external`/`external_message` |
| Chrome 扩展 | 支持 DEV + ANT extension ID | 仅 PROD extension ID |

---

## 3. infrastructure 依赖分层

### 🔴 第一层：必须存在，否则完全无法使用

| # | 依赖 | 说明 |
|---|------|------|
| 1 | **LLM API 端点 + API Key** | 对话引擎核心，任何构建都需要 |
| 2 | **GrowthBook CDN**（默认） | GB 初始化走默认 CDN，不需要 `ZY_CODE_GB_BASE_URL` |

### 🟠 第二层：缺失会导致功能严重降级

| # | 依赖 | 环境变量 | 缺失后果 |
|---|------|----------|----------|
| 3 | 内部 GrowthBook 端点 | `ZY_CODE_GB_BASE_URL` | `zy_ant_*` feature flags 全部关闭，auto 模式、advisor、内部 beta headers 不可用。**安全降级，不崩溃** |
| 4 | Telemetry 端点 | `ANT_ZY_CODE_METRICS_ENDPOINT` | BigQuery 导出器初始化时可能长时间阻塞等待连接 |
| 5 | 内部 Beta Header | `CLI_INTERNAL_BETA_HEADER` | 后端不识别内部实验特性，某些内部模型可能无法调用 |
| 6 | Staging OAuth 端点 | `USE_STAGING_OAUTH` | 不设就默认走 prod，无影响 |

### 🟡 第三层：特定功能缺失，不影响核心对话

| # | 依赖 | 环境变量 | 缺失后果 |
|---|------|----------|----------|
| 7 | Bridge/Session Ingress | `CLAUDE_BRIDGE_BASE_URL`, `CLAUDE_BRIDGE_SESSION_INGRESS_URL` | Bridge 远程控制模式不可用，CLI 模式正常 |
| 8 | 内部 npm Registry | — | 版本回滚功能不可用（代码已切换到 GCS） |
| 9 | Google Cloud 认证 | `gcloud` 命令行工具 | 会话数据不上传到内部仓库 |
| 10 | 内部仓库识别服务 | — | Undercover 模式默认开启，不会自动关闭 |
| 11 | YOLO 分类器内部模板 | `permissions_anthropic.txt`, `yolo-classifier-prompts/` | 外部有独立模板兜底 |

### 🟢 第四层：仅影响开发调试/内部工作流

| # | 依赖 | 缺失后果 |
|---|------|----------|
| 12 | Datadog 内部端点 | 遥测数据仅写到本地文件 |
| 13 | 内部 Chrome Extension ID | 仅支持 PROD 版 Chrome 扩展 |
| 14 | Perfetto / asciicast | 性能追踪/终端录制不可用 |
| 15 | Kubernetes namespace | 无法获取 namespace/container ID（本地本来就没有） |
| 16 | 内部命令（`INTERNAL_ONLY_COMMANDS`） | `/commit-push-pr`、`/tag`、`/backfillSessions` 等不可用 |

---

## 4. `feature()`（`bun:bundle`）编译时门控

`feature()` 在 `bun build` 时被静态解析。zy-super 构建走 `bun build` 时，以下 feature flags 会激活额外的内部代码路径：

| Feature Flag | 控制内容 |
|---|---|
| `UDS_INBOX` | Unix Domain Socket 消息服务（进程间通信） |
| `COMMIT_ATTRIBUTION` | 提交归因追踪 hooks |
| `CONTEXT_COLLAPSE` | 上下文折叠服务 |
| `TEAMMEM` | 团队内存同步监视器 |
| `TRANSCRIPT_CLASSIFIER` | 自动权限分类器（auto 模式核心） |

---

## 5. 本地运行 zy-super 构建所需的环境变量清单

如需在本地完整运行 zy-super 构建（启用所有内部功能），需要设置以下环境变量：

```bash
# 必需
export USER_TYPE=zy-super
export ANTHROPIC_API_KEY=<your-api-key>     # 或 ZY_API_KEY

# 内部功能（按需设置）
export ZY_CODE_GB_BASE_URL=<内部 GrowthBook 端点>
export ANT_ZY_CODE_METRICS_ENDPOINT=<内部 Telemetry 端点>
export CLI_INTERNAL_BETA_HEADER=<内部 beta header 值>
export CLAUDE_BRIDGE_BASE_URL=<内部 Bridge 端点>
export CLAUDE_BRIDGE_SESSION_INGRESS_URL=<内部 Session Ingress 端点>

# OAuth 测试环境（按需设置）
export USE_STAGING_OAUTH=1                  # 使用 staging OAuth
# export USE_LOCAL_OAUTH=1                  # 使用本地 OAuth

# 功能覆盖（按需设置）
export CLAUDE_INTERNAL_FC_OVERRIDES='{"feature_name": true}'  # JSON 格式
```

## 6. 结论

要让 zy-super 本地构建成功运行并基本对话，**除了 LLM API 端点 + Key 之外，实际上不需要额外的内部基础设施**。因为：

1. `isInternalBuild()` → `false` 时，所有内部路径被 DCE 移除
2. `feature()` → `false` 时，所有实验性功能被 DCE 移除
3. 缺失的内部端点会被安全降级（如 GB 走 CDN、OAuth 走 prod）

如果需要启用完整内部功能（auto 模式、内部模型覆盖、Bridge 等），才需要上述第二层到第四层的内部基础设施。
