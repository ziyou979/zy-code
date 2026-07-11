# CC v2.1.205 对齐执行进度

> 起始日期：2026-07-09
> 对应计划：`.zy/plans/` 下的计划文件

## Phase 1（安全与错误语义基线）

| # | 项 | 状态 | 开始日期 | 完成日期 | 备注 |
|---|-----|------|---------|---------|------|
| 1.1 | `classifyAllShell` 设置与全 shell 分类 | ✅ 完成 | 2026-07-09 | 2026-07-09 | settings.ts + permissions.ts 改动，类型检查通过 |
| 1.2 | LLM 错误语义分类 | ✅ 完成 | 2026-07-09 | 2026-07-09 | errors.ts + llmOrchestrator.ts + 12 个测试 |
| 1.3 | Partial output 保留与 incomplete 标记 | ✅ 完成 | 2026-07-09 | 2026-07-09 | llm.ts + llmOrchestrator.ts + query.ts，类型检查通过 |
| 1.4 | MCP auth 并发刷新与 401/403 重连 | ✅ 完成 | 2026-07-09 | 2026-07-09 | mcpToolCall.ts 动态导入 client，类型检查通过 |
| 1.5 | `Tool(param:value)` 参数级权限匹配 | ✅ 完成 | 2026-07-09 | 2026-07-09 | 解析器不处理 param:value，工具层匹配函数按需识别（bashPermissions.ts），兼容 WebFetch domain: 规则 |

## Phase 2（MCP、后台任务与诊断）

| # | 项 | 状态 | 开始日期 | 完成日期 | 备注 |
|---|-----|------|---------|---------|------|
| 2.1 | MCP result size / idle timeout 统一 | ✅ 完成 | 2026-07-09 | 2026-07-09 | mcpShared.ts 增 getMcpToolIdleTimeoutMs() |
| 2.2 | 后台任务 stop/respawn 可靠性 | ✅ 完成 | 2026-07-09 | 2026-07-09 | AgentTool 已有 stop/kill/partial 处理；envUtils.ts 新增 isBgShellPressureReapDisabled() 对应 CC 的 DISABLE_BG_SHELL_PRESSURE_REAP |
| 2.3 | Login 即将过期提示 | ✅ 不适用 | 2026-07-09 | 2026-07-09 | zy-code 使用 API key 认证，无 OAuth 会话；MCP OAuth token 已通过 ZyAuthProvider 主动刷新 |
| 2.4 | SSL 证书错误 fail-fast | ✅ 完成 | 2026-07-09 | 2026-07-09 | getAPIErrorSeverity SSL 检测 → terminal |
| 2.5 | `/doctor` 诊断增强 | ✅ 完成 | 2026-07-09 | 2026-07-09 | 现有功能已覆盖 MCP/沙箱/插件/设置等项；MCP auth 状态可在 /mcp 查看 |

## Phase 3（工作流与体验项）

| # | 项 | 状态 | 开始日期 | 完成日期 | 备注 |
|---|-----|------|---------|---------|------|
| 3.1 | `dynamicWorkflowSize` 与 OTel 属性 | ✅ 完成 | 2026-07-09 | 2026-07-09 | WorkflowTool 新增 workflowSize 输入选项；AgentOpts 新增 workflowRunId/workflowName |
| 3.2 | `/dataviz` 数据可视化技能 | ✅ 完成 | 2026-07-09 | 2026-07-09 | 新增 src/skills/bundled/dataviz.ts，注册为内置 skill |
| 3.3 | Bash 路径补全 | ✅ 已实现（核心链路已验证） | 2026-07-09 | 2026-07-10 | 基于实际 Shell provider 选择补全语法，Windows 可从 Git 安装路径发现 Git Bash；支持命令/文件/变量、操作符后 token 与带空格路径，新增 6 个定向测试并通过 |
| 3.4 | 默认 Manual / AskUserQuestion 迁移 | ✅ 已对齐 | 2026-07-09 | 2026-07-09 | zy-code 默认模式已是 'default'（与 CC 的 Manual 等效），无需迁移 |

## 验证记录（2026-07-10）

| 范围 | 结果 | 备注 |
|------|------|------|
| 类型检查 | ✅ 通过 | `bun tsc --noEmit` |
| 对齐能力定向测试 | ✅ 通过 | Shell 补全 6 项，以及错误语义、权限、Workflow、MCP hook 29 项 |
| 全量测试 | ⚠️ 1090 通过 / 1 跳过 / 4 失败 | 失败为既有 API snapshot 漂移 1 项、Anthropic `server_tool_use` 映射 3 项，均不在本次 Shell 补全改动路径 |
| TUI PTY 自动化 | ⏸️ 环境受阻 | 本机无 `expect`，且 WSL 未安装发行版；技能脚本无法建立真实 PTY，未将普通管道输入冒充端到端验证 |

## 后续补全项（2026-07-10）

以下项在首次对齐评估后仍为 stub/未实现，已在本轮补全：

| # | 项 | 状态 | 说明 |
|---|-----|------|------|
| 2.6 | `/code-review` 完整实现 | ✅ 完成 | effort 三级 + --fix + --comment + PR number；使用 sideQuery 执行审查 |
| 2.7 | `/checkup` alias | ✅ 完成 | doctor 命令新增 aliases: ['checkup'] |
| 2.8 | MCP secret redaction | ✅ 完成 | mcpResults.ts 新增 redactMCPSecrets/redactSensitiveFields/redactMcpContent；覆盖 text/text in resource/截断/持久化路径 |
| 4.1 | Daemon 子系统 | ✅ 完成 | main.ts 锁文件 + socket token + roster + Unix socket IPC；workerRegistry.ts 注册/注销/心跳/列表；build.ts 启用 DAEMON feature |
| 4.2 | 虚拟滚动/自动展开 | ✅ 已对齐 | VirtualMessageList + 分页历史加载 + UUID-anchored 切片已在现有代码中实现 |
