# Feature Flags 文档

本文档列出项目中所有通过 GrowthBook / Statsig 管理的 Feature Flag，包括功能说明、默认值和使用位置。

> **前缀约定**：所有 flag 统一使用 `zy_` 前缀。

---

## Flag 调用方式

项目中使用三种 API 读取 flag：

| API | 说明 |
|-----|------|
| `getFeatureValue_CACHED_MAY_BE_STALE(flag, default)` | 带本地缓存 + 默认值，缓存可能过时 |
| `checkGate_CACHED_OR_BLOCKING(flag)` | 门控检查，冷启动时阻塞等待服务端 |
| `checkStatsigFeatureGate_CACHED_MAY_BE_STALE(flag)` | Statsig 门控，带缓存 |

---

## Agent 相关

| Flag | 默认值 | 说明 | 文件 |
|------|--------|------|------|
| `zy_explore_plan_agent` | `true` | 控制内置探索计划 Agent 是否启用 | `src/tools/AgentTool/builtInAgents.ts` |
| `zy_verify_agent` | `false` | 验证 Agent 功能的门控开关 | `src/tools/AgentTool/builtInAgents.ts`, `src/tools/TodoWriteTool/TodoWriteTool.ts` |
| `zy_agent_list_attach` | `false` | 是否在消息中注入 Agent 列表 | `src/tools/AgentTool/prompt.ts` |
| `zy_slim_subagent_md` | `true` | 子 Agent 中省略 zyMd 上下文的 kill-switch | `src/tools/AgentTool/runAgent.ts` |
| `zy_auto_background_agents` | `false` | 自动后台化 Agent 任务（120s 后） | `src/tools/AgentTool/AgentTool.tsx` |

## 工具相关

| Flag | 默认值 | 说明 | 文件 |
|------|--------|------|------|
| `zy_bash_treesitter_shadow` | `true` | Tree-sitter Bash shadow mode 的 kill-switch | `src/tools/BashTool/bashPermissions.ts` |
| `zy_deferred_tool_reminder` | `false` | 延迟工具在 system-reminder 中显示 | `src/tools/ToolSearchTool/prompt.ts` |
| `zy_read_dedup_killswitch` | `false` | FileRead 去重功能的 kill-switch（false=去重启用） | `src/tools/FileReadTool/FileReadTool.ts` |
| `zy_websearch_compact_model` | `false` | WebSearch 使用 Compact 模型 | `src/tools/WebSearchTool/WebSearchTool.ts` |
| `zy_strict_tools` | gate | Strict tools 功能（Statsig 门控） | `src/services/feature-flags/betas.ts` |
| `zy_json_tools_beta` | `false` | Token-efficient tools beta 功能 | `src/services/feature-flags/betas.ts` |
| `zy_toolref_defer_j8m` | gate | Tool reference 延迟处理 | `src/services/messages/normalize.ts` |

## 模型与推理

| Flag | 默认值 | 说明 | 文件 |
|------|--------|------|------|
| `zy_otk_slot_v1` | `false` | OTK slot 容量升级重试（8k→64k） | `src/query.ts` |
| `zy_ant_model_override` | N/A | 模型别名映射覆盖 | `src/main.tsx` |
| `zy_startup_throttle_ms` | `0` | 启动预取节流（毫秒），0=禁用 | `src/main.tsx` |

## UI / 交互

| Flag | 默认值 | 说明 | 文件 |
|------|--------|------|------|
| `zy_terminal_panel` | `false` | 内置终端面板功能（meta+j 切换） | `src/hooks/useGlobalKeybindings.tsx` |
| `zy_away_summary` | `false` | Away Summary 功能启用 | `src/hooks/useAwaySummary.ts` |
| `zy_thinkback` | gate | Thinkback 年度回顾功能 | `src/commands/thinkback/index.ts` |
| `zy_sysreminder_smoosh` | gate | System reminder 兄弟节点合并处理 | `src/services/messages/normalize.ts` |

## 权限 / 安全

| Flag | 默认值 | 说明 | 文件 |
|------|--------|------|------|
| `zy_disable_bypass_permissions_mode` | gate | 禁用 bypass permissions 模式 | `src/services/permissions/permissionBootstrap.ts` |
| `zy_scratch_dir` | gate | 暂存目录功能启用 | `src/coordinator/coordinatorMode.ts`, `src/services/permissions/scratchpadStorage.ts` |

## Channels / 插件

| Flag | 默认值 | 说明 | 文件 |
|------|--------|------|------|
| `zy_channels_gate` | gate | 开发渠道门控检查 | `src/interactiveHelpers.tsx` |
| `zy_vscode_review_upsell` | gate | VSCode review upsell 功能 | `src/services/mcp/vscodeSdkMcp.ts` |
| `zy_vscode_onboarding` | gate | VSCode onboarding 功能 | `src/services/mcp/vscodeSdkMcp.ts` |
| `zy_browser_support` | N/A | Browser support 相关功能 | `src/services/mcp/vscodeSdkMcp.ts` |

## 全屏 / TUI

| Flag | 默认值 | 说明 | 文件 |
|------|--------|------|------|
| `zy_fullscreen_rollout` | `false` | 控制外部用户全屏模式灰度推广百分比 | `src/services/terminal/fullscreen.ts` |

---

## 分析 / 遥测

| Flag | 默认值 | 说明 | 文件 |
|------|--------|------|------|
| `zy_log_datadog_events` | N/A | 控制是否向 Datadog 发送事件 | `src/services/analytics/sink.ts` |
| `zy_event_sampling_config` | N/A | 事件采样率配置 | `src/services/analytics/sink.ts` |
| `enhanced_telemetry_beta` | `false` | 增强遥测 beta（仅内部构建）。**例外**：此 flag 为外部兼容遗留名称，不遵循 `zy_` 前缀约定 | `src/services/telemetry/sessionTracing.ts` |

---

## 遥测事件名列表（zy_ 前缀）

以下为 `logEvent()` 调用中使用的事件名（摘要）：

| 事件名 | 说明 | 文件 |
|--------|------|------|
| `zy_session_started` | 会话启动（最早的健康监控信号） | `src/setup.ts` |
| `zy_session_exit` | 会话退出（包含成本、时长统计） | `src/setup.ts` |
| `zy_startup_telemetry` | 启动遥测（git/worktree/auth 状态） | `src/main.tsx` |
| `zy_query_error` | 查询错误 | `src/query.ts` |
| `zy_model_fallback_triggered` | 模型降级触发 | `src/query.ts` |
| `zy_auto_compact_succeeded` | 自动压缩成功 | `src/query.ts` |
| `zy_orphaned_messages_tombstoned` | 孤儿消息标记清理 | `src/query.ts` |
| `zy_oauth_success` | OAuth 登录成功 | `src/cli/handlers/auth.ts` |
| `zy_oauth_flow_start` | OAuth 流程开始 | `src/cli/handlers/auth.ts` |
| `zy_update_check` | 版本更新检查 | `src/cli/update.ts` |
| `zy_ui_flicker` | UI 闪烁检测 | `src/interactiveHelpers.tsx` |
| `zy_mcp_start` | MCP 服务启动 | `src/cli/handlers/mcp.tsx` |
| `zy_worktree_created` | worktree 创建 | `src/setup.ts` |
| `zy_managed_settings_loaded` | 托管设置加载 | `src/main.tsx` |
| `zy_settings_auto_mode_untrusted_source_ignored` | project/local 中的 defaultMode:auto 或 autoMode 规则被忽略（CC 2.1.207） | `src/services/permissions/permissionSetup.ts` |
| `zy_ccr_unsupported_default_mode_ignored` | CCR 不支持的 defaultMode 被忽略 | `src/services/permissions/permissionSetup.ts` |
| `zy_managed_settings_security_deferred_non_interactive` | 非交互路径危险托管设置会话内应用、不落盘同意（CC 2.1.207） | `src/services/remoteManagedSettings/securityCheck.tsx` |
| `zy_tui_command` | `/tui` 命令执行（含 from/to） | `src/commands/tui/tui.ts` |
| `zy_fullscreen_upsell_shown` | 全屏 upsell 对话框展示 | `src/components/FullscreenUpsell/FullscreenUpsellDialog.tsx` |
| `zy_fullscreen_upsell_accepted` | 全屏 upsell 用户确认 | `src/components/FullscreenUpsell/FullscreenUpsellDialog.tsx` |
| `zy_fullscreen_upsell_dismissed` | 全屏 upsell 用户选择不再询问 | `src/components/FullscreenUpsell/FullscreenUpsellDialog.tsx` |
| `zy_fullscreen_downsell_shown` | 全屏 downsell 提示展示 | `src/hooks/notifs/useFullscreenDownsell.ts` |
| `zy_fullscreen_downsell_persisted` | 全屏 downsell 自动毕业 | `src/hooks/notifs/useFullscreenDownsell.ts` |
| `zy_editor_mode_changed` | 编辑器模式切换 | `src/commands/vim/vim.ts` |
