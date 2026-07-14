# zy-code vs Claude Code v2.1.205 增量补全报告

> **分析日期**：2026-07-09
> **CC 版本**：2.1.205 · 构建日期 2026-07-08T17:39:55Z · commit `4cf2699a14277d4a8edf7e74442381071fc0cfd2`
> **CC 二进制**：`D:\nvm\nvm4w\nodejs\node_global\node_modules\@anthropic-ai\claude-code\bin\claude.exe` (247MB)
> **基线文档**：已合并 `zy-code-vs-claude-code-deep-comparison.md`（基于 v2.1.187，2026-06-25）中的仍有效结论，原文件已废弃
> **增量范围**：主增量 v2.1.187 → v2.1.205；补读覆盖微信专辑可见的 v2.1.91 → v2.1.205
> **提取方法**：extract-claude-internal skill + 二进制字节扫描 + changelog 交叉验证
> **微信专辑复核**：已补读 `mp.weixin.qq.com` 专辑可见的 2.1.91 → 2.1.205 文章；用户提到的 2.1.88 未在本次可见分页中出现

---

## 总体评估

| 指标 | v2.1.187 报告时 | v2.1.205 现在 | 变化 |
|------|----------------|--------------|------|
| CC 环境变量总数 | ~85+ | **275+**（完整枚举） | +190（含大量内部/实验性） |
| CC 设置项总数 | ~45+ | ~55+ | +10 |
| zy-code 已对齐设置 | ~30+ | ~35+ | +5 |
| zy-code 缺失的 P0 项 | 4 | **4 大类** | 重排为安全/可靠性闭环 |
| 新增/重点命令能力 | — | `/doctor`（zy-code 已有基础）、`/dataviz`（缺失） | +2 |
| 新增 Skill | — | 堆叠调用 | 行为变化 |
| 新增 Agent 类型 | — | Chrome 客户端 | 新入口 |
| CC 二进制版本号 | 2.1.187 | **2.1.205** | +18 个版本 |

---

## 一、v2.1.187 → v2.1.205 Changelog 增量

### 2.1.188–192 — 内部稳定性
- 微信专辑可见的 2.1.190 仅写明内部改进和 bug 修复，2.1.188/189 未在专辑分页中直接出现

### 🆕 2.1.193 — Auto Mode Shell 分类 + 文件路径补全
- **`autoMode.classifyAllShell`** 设置：Auto Mode 下对所有 shell 命令执行分类器（不仅限 Bash 工具），覆盖 PowerShell/cd/gh 等
- **Bash 模式文件路径自动补全**：在 bash 提示符下按 Tab 可路径补全
- **自动内存压力回收**：当系统内存压力高时主动释放缓存
- **`/rewind` 穿过 `/clear` 恢复**：可从 `/clear` 前的对话状态继续
- **Auto Mode 拒绝理由可见化**：拒绝原因进入 transcript、toast 和 `/permissions` recent denials
- **MCP 登录提醒**：启动时提示需要认证的 MCP，并引导 `/mcp`
- **后台 shell 内存压力回收**：空闲后台 shell 在内存压力下被回收，可用 `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1` 禁用
- **流式渲染 100ms 合并**：降低流式输出 CPU 压力
- **MCP 401/403 自动重连**：`headersHelper` 在工具调用遇到 401/403 后重新获取认证并重连
- **MCP transient retry**：能力发现、OAuth discovery/token 请求增加短退避重试；headless 场景跳过浏览器弹窗，改用粘贴 URL

### 🆕 2.1.195 — 鼠标点击禁用
- **`CLAUDE_CODE_DISABLE_MOUSE_CLICKS`**：独立禁用鼠标点击（保留鼠标滚轮）
- 修复语音听写问题

### 🆕 2.1.196 — 组织默认模型 + 可点击附件
- **组织默认模型**：管理员通过 managed-settings 配置组织级默认模型
- **可点击文件附件**：终端中文件引用可点击打开
- 后台会话可靠性改进
- 流式空闲看门狗默认开启
- 减少终端重绘工作

### 🆕 2.1.197 — Claude Sonnet 5
- **Claude Sonnet 5**：原生支持 100 万 token 上下文，成为 CC 默认模型
- `DISABLE_PROMPT_CACHING_SONNET` 新增（已有 `_FABLE`、`_MYTHOS` 等）

### 🆕 2.1.198 — 子代理后台化 + Chrome + /dataviz
- **子代理默认后台运行**：`run_in_background` 默认 true
- **Claude in Chrome**：Chrome 客户端正式可用（`--chrome` / `--no-chrome`）
- **`/dataviz` 技能**：数据可视化内置技能
- **Gateway AWS 提供商**：新增 AWS Gateway 支持
- 代理团队改进

### 🆕 2.1.199 — 堆叠斜杠技能
- **堆叠斜杠技能调用**：支持最多 5 个技能链式调用（如 `/review --fix && /security-review`）
- SSL 证书错误处理改进
- 子代理静默失败修复
- 专注模式改进
- 子代理被 rate limit/server error 截断时，把 partial work 返回给父代理；API/usage-limit 错误不再伪装成功
- 后台 worker 记录损坏、stop/respawn race、进度指示卡住、SendMessage 误投递到重生代理等 daemon 可靠性修复
- SSL 证书错误 fail-fast 并给出修复提示，避免无意义重试
- mid-stream overloaded/server error 保留 partial output，并标记 incomplete response
- transient 429 对订阅用户走退避重试；`CLAUDE_CODE_RETRY_WATCHDOG` 把非容量类瞬时错误默认重试提高到 300

### 🆕 2.1.200 — 默认权限模式改为 Manual
- **默认权限模式改为 `Manual`**：`AskUserQuestion` 对话框不再默认自动继续
- 修复后台会话睡眠/唤醒后静默中断问题
- 改进屏幕朗读器输出
- 修复 `.claude.json` 中 `disabledMcpServers` / `enabledMcpServers` 非数组导致启动崩溃
- 修复后台会话恢复后重跑 Esc 取消 turn、stale `daemon.lock` PID 复用、旧 daemon 接管新构建等问题
- 修复 `claude agents --plugin-dir <dir>`、git worktree 下项目插件加载、tmux 3.4+ 闪烁等细节

### 🆕 2.1.201 — Sonnet 5 系统角色修复
- Sonnet 5 会话不再使用对话中系统角色进行 prompt 组装

### 🆕 2.1.202 — 动态工作流大小 + /review 恢复
- **`dynamicWorkflowSize`** 设置：控制动态工作流大小（small/medium/large）
- **Workflow OTel 属性**：工作流生成的 agent 带 `workflow.run_id` 和 `workflow.name`
- **`/review` 恢复单次快速审查**（解决多重审查延迟问题）
- 修复语音听写无限循环
- 改进 MCP 错误提示
- `Ctrl+R` 历史搜索崩溃修复
- 修复 `/rename` 在后台 session 重启后丢失、mTLS 证书轮换偶发握手失败、Remote Control interactive command `Unknown command`
- 修复移动端/网页端无 caption 图片/文件被静默丢弃、skill 重复加载导致指令重复注入
- 大量 git worktree 下 resume picker/name 的性能和内存改进

### 🆕 2.1.203 — 登录过期警告 + 二进制约 -7MB
- **登录即将过期警告**：OAuth token 快过期时主动提示
- **手动权限模式灰色 ⏸ 标记**：暂停时状态栏显示
- 修复 macOS 后台会话卡顿
- 修复 `/exit` 误报
- 二进制体积减小约 7MB（优化）

### 2.1.204 — Headless Hook 流式修复
- 修复无头会话中 SessionStart 钩子事件不流式传输的问题

### 🆕 2.1.205 — /doctor + 自动模式安全 + 内存优化
- **`/doctor` 全面诊断命令**：检查 settings 文件错误、权限、网络连接、插件状态等
- **`DISABLE_DOCTOR_COMMAND`**：可禁用 `/doctor` 命令
- **自动模式新增规则**：阻止篡改会话记录文件的行为
- **JSON schema 修复**：修复多次验证问题
- **Auto Mode 增强**：改进 `rm -rf` 等危险命令的处理
- **流式下载内存优化**：减少约 400MB 峰值内存
- Windows 工作树删除等修复

---

## 二、新增/发现的环境变量

以下是在 v2.1.205 二进制中新发现且**未在基线文档中出现**的环境变量：

### 2.1 Auto Mode 扩展
| 环境变量 | 偏移量 | 说明 | zy-code 状态 |
|----------|--------|------|-------------|
| `CLAUDE_CODE_AUTO_MODE_CLASSIFY_EDITS` | `111743880` | Auto Mode 对 Edit 工具进行分类 | ❌ 缺失 |
| `CLAUDE_CODE_AUTO_MODE_EDIT_REMOVAL` | `109038360` | Auto Mode 编辑移除控制 | ❌ 缺失 |
| `CLAUDE_CODE_AUTO_MODE_EDIT_REMOVAL_CAP` | `109040688` | Auto Mode 编辑移除上限 | ❌ 缺失 |
| `CLAUDE_CODE_AUTO_MODE_GIT_STATUS` | `111809856` | Auto Mode git status 注入 | ❌ 缺失 |
| `CLAUDE_CODE_AUTO_MODE_GIT_STATUS_LIMIT` | `111814360` | Auto Mode git status 文件数上限 | ❌ 缺失 |
| `CLAUDE_CODE_AUTO_MODE_GIT_STATUS_UPLOADS` | `111812040` | Auto Mode git status 上传控制 | ❌ 缺失 |
| `CLAUDE_CODE_AUTO_MODE_OUTCOME_CODES` | — | Auto Mode 结果码 | ❌ 缺失 |

### 2.2 子代理扩展
| 环境变量 | 偏移量 | 说明 | zy-code 状态 |
|----------|--------|------|-------------|
| `CLAUDE_CODE_SUBAGENT_CACHE_EVICT` | 多处 | 子代理缓存逐出策略 | ❌ 缺失 |
| `CLAUDE_CODE_FORK_SUBAGENT` | `86130942` | Fork 模式子代理 | ✅ 已有 `FORK_SUBAGENT` feature，命名不同 |
| `CLAUDE_CODE_DISABLE_NESTED_CHAIN_IDLE` | — | 禁用嵌套链式空闲检测 | ❌ 缺失 |

### 2.3 记忆/Proactive 模式
| 环境变量 | 偏移量 | 说明 | zy-code 状态 |
|----------|--------|------|-------------|
| `CLAUDE_CODE_PROACTIVE` | `89919836` | Proactive 模式（主动建议） | ✅ 已有 `ZY_CODE_PROACTIVE`，命名不同 |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `89923436` | 禁用自动记忆 | ✅ 已有 `ZY_CODE_DISABLE_AUTO_MEMORY`，命名不同 |
| `CLAUDE_CODE_DISABLE_MEMORY_BULK_INFLATE` | `89922732` | 禁用记忆批量膨胀 | ❌ 缺失 |
| `CLAUDE_CODE_DISABLE_MEMORY_PERIODIC_RESYNC` | `89922668` | 禁用记忆定期重新同步 | ❌ 缺失 |
| `CLAUDE_CODE_FORCE_EVALUATE_MEMORY` | `89934292` | 强制评估记忆 | ❌ 缺失 |
| `CLAUDE_CODE_FORCE_MEMORY_SURVEY` | — | 强制记忆调查 | ❌ 缺失 |

### 2.4 工作流
| 环境变量 | 偏移量 | 说明 | zy-code 状态 |
|----------|--------|------|-------------|
| `CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS` | `89918600` | 工作流 Agent 数量警告阈值 | ⚠️ 应映射到 orchestrator/WorkflowTool runtime 预算提示 |
| `CLAUDE_CODE_WORKFLOW_SIZE_WARNING_TOKENS` | `89918656` | 工作流 Token 用量警告阈值 | ⚠️ 应映射到 orchestrator/WorkflowTool runtime 预算提示 |
| `CLAUDE_CODE_DISABLE_WORKFLOWS` | — | 禁用工作流系统 | ⚠️ zy-code 需映射为禁用 orchestrator/WorkflowTool runtime，而非照搬 CC 名称 |

### 2.5 诊断/禁用命令
| 环境变量 | 偏移量 | 说明 | zy-code 状态 |
|----------|--------|------|-------------|
| `DISABLE_DOCTOR_COMMAND` | `89918120` | 禁用 `/doctor` | ✅ 已有入口 guard |
| `DISABLE_BUG_COMMAND` | `89918232` | 禁用 `/bug` | ✅ 已有入口 guard |
| `DISABLE_FEEDBACK_COMMAND` | `89917992` | 禁用 `/feedback` | ✅ 已有入口 guard |
| `DISABLE_LOGIN_COMMAND` | `89917760` | 禁用 `/login` | ✅ 已有入口 guard |
| `DISABLE_LOGOUT_COMMAND` | `89917720` | 禁用 `/logout` | ✅ 已有入口 guard |
| `DISABLE_UPGRADE_COMMAND` | `89917328` | 禁用 upgrade | ✅ 已有入口 guard |

### 2.6 其他新增
| 环境变量 | 偏移量 | 说明 | zy-code 状态 |
|----------|--------|------|-------------|
| `CLAUDE_CODE_AGENT_VIEW_RELAUNCH` | — | Agent 视图重新启动 | ❌ 缺失 |
| `CLAUDE_CODE_DISABLE_AGENT_VIEW` | — | 禁用 Agent 视图 | ❌ 缺失 |
| `CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL` | — | 禁用 Claude API 技能 | ❌ 缺失 |
| `CLAUDE_CODE_DISABLE_CLAUDE_CODE_SKILL` | — | 禁用 Claude Code 技能 | ❌ 缺失 |
| `CLAUDE_CODE_DISABLE_POLICY_SKILLS` | — | 禁用策略技能 | ❌ 缺失 |
| `CLAUDE_CODE_DISABLE_WORKING_SYNC` | — | 禁用工作同步 | ❌ 缺失 |
| `CLAUDE_CODE_TASK_LIST_ID` | — | 任务列表 ID | ✅ 已有 `ZY_CODE_TASK_LIST_ID`，命名不同 |

### 2.7 已在基线文档中的新发现（补充偏移）
以下在基线文档中已标记缺失，本次确认偏移量：
- `CLAUDE_CODE_MID_CONVERSATION_SYSTEM` `86848848` ✅ 确认
- `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` `86848904` ✅ 确认
- `CLAUDE_CODE_MCP_ALLOWLIST_ENV` `86848960` ✅ 确认
- `CLAUDE_CODE_IDE_HOST_OVERRIDE` `86849304` ✅ 确认
- `CLAUDE_CODE_HOST_PLATFORM` `86849352` ✅ 确认
- `CLAUDE_CODE_MANAGED_SETTINGS_PATH` `86849008` ✅ 确认

---

## 三、新增 Feature Flags

在 v2.1.205 中确认的 flags（基线文档未覆盖）：

| Flag | 说明 | zy-code 状态 |
|------|------|-------------|
| `ENABLE_AUTO_PIN` | 自动 Pin 功能 | ❌ 缺失 |
| `ENABLE_CLAUDEAI_MCP_SERVERS` | Claude.ai MCP 服务器 | ❌ 缺失 |
| `ENABLE_CONNECT_PROTOCOL` | Connect 协议 | ❌ 缺失 |
| `ENABLE_DESIGN_MCP` | Design MCP | ❌ 缺失 |
| `ENABLE_FTS` | 全文搜索 | ❌ 缺失 |
| `ENABLE_LAUNCH_COMPOSER` | Launch Composer | ❌ 缺失 |
| `ENABLE_MATH_FUNCTIONS` | 数学函数 | ❌ 缺失 |
| `ENABLE_RTREE` | R-Tree 索引 | ❌ 缺失 |
| `ENABLE_TENTATIVE_ERA` | Tentative Era | ❌ 缺失 |
| `ENABLE_UPDATE_DELETE_LIMIT` | 更新删除限制 | ❌ 缺失 |
| `ENABLE_XAA` | XAA 实验性功能 | ❌ 缺失 |
| `DISABLE_ADOPT` | 禁用 Adopt 功能 | ❌ 缺失 |
| `DISABLE_AWAITING_ACTION_OVERRIDE` | 禁用等待操作覆盖 | ❌ 缺失 |
| `DISABLE_BRIEF_MODE_STOP_HOOK` | 禁用简洁模式 Stop Hook | ❌ 缺失 |
| `DISABLE_DELEGATE_ACCESS_RIGHTS` | 禁用委托访问权限 | ❌ 缺失 |
| `DISABLE_DOCTOR_COMMAND` | 禁用 `/doctor` 命令 | ✅ 已有 |
| `DISABLE_GROWTHBOOK` | 禁用 GrowthBook 特性开关 | ❌ 缺失 |
| `DISABLE_MULTITENANTAUTH` | 禁用多租户认证 | ❌ 缺失 |
| `DISABLE_SESSION_PERSISTENCE` | 禁用会话持久化 | ❌ 缺失 |

---

## 四、新设置项对齐分析

| 设置项 | CC 版本 | 说明 | zy-code 状态 | 复杂度 |
|--------|---------|------|-------------|--------|
| `autoMode.classifyAllShell` | 2.1.193 | Auto Mode 全 shell 分类 | ❌ 缺失 | 中 |
| `dynamicWorkflowSize` | 2.1.202 | 动态工作流大小（small/medium/large） | ⚠️ orchestrator 待增强 | 低 |
| 子代理默认后台（隐式） | 2.1.198 | 不再需要显式 `run_in_background` | ⚠️ 部分已有 | 中 |
| `/doctor` 命令 | 2.1.205 | 全面诊断 | ✅ 已有基础，需增强 | 中 |
| `/dataviz` 技能 | 2.1.198 | 数据可视化 | ❌ 缺失 | 低 |
| 堆叠斜杠技能 | 2.1.199 | 链式调用最多 5 个技能 | ✅ **已有** `executeSkillChain()` | — |

### zy-code 已有验证

**堆叠斜杠技能**：zy-code 已有 `executeSkillChain()` 实现（`src/commands/slash/slashCommands.ts`），CC 2.1.199 的堆叠调用与 zy-code 的能力对等。

**/doctor**：zy-code 已有 `src/commands/doctor/`、`src/screens/Doctor.tsx`，并在 `src/commands.ts` 注册；当前更像本地诊断面板，仍需按 CC 2.1.205 补齐网络、MCP auth、插件、sandbox、版本锁、权限策略等诊断项。

**/rewind**：zy-code 已有 `src/commands/rewind/`、`src/utils/fileHistory.ts` 和 headless control loop 的 rewind 事件；需要单独确认 `/clear` 前快照恢复是否与 CC 2.1.193 对齐。

**Chrome / Proactive / 自动记忆 / fork subagent**：Chrome 客户端、Proactive、`ZY_CODE_DISABLE_AUTO_MEMORY`、`ZY_CODE_TASK_LIST_ID`、`FORK_SUBAGENT` 均已有实现基础；本文早期“缺失”判断需要降级为“行为细节待对齐”。

---

## 五、微信专辑细项复核与二进制证据补充

> 本节是对上文的校准：微信专辑从 2.1.91 起列了很多细粒度修复，不能只按 release headline 判断缺口。二进制 offset 来自当前本机 `claude.exe` 的字节扫描。

| 版本 | 细项 | CC 二进制证据 | zy-code 状态 | 落地建议 |
|------|------|---------------|--------------|----------|
| 2.1.193 | `/rewind` 可从 `/clear` 前继续 | `rewind`：`93453880`, `106257222` | ⚠️ 有 `/rewind`，需验 `/clear` 前快照 | 写回归用例覆盖 `/clear -> /rewind -> resume` |
| 2.1.193 | `autoMode.classifyAllShell` 全 shell 分类 | `classifyAllShell`：`93760608`, `223889763`, `223980013` | ❌ 设置缺失 | P0；在 `src/services/permissions/` 扩展分类器入口，不放 `src/utils/permissions/` |
| 2.1.193 | Auto Mode 拒绝理由进入 transcript/toast/recent denials | `DENIAL` 常量与 `autoModeDenials` 相关代码 | ⚠️ 已有 denial tracking，展示面需补齐 | P0；统一 denial reason schema，接入 `/permissions` 最近拒绝列表 |
| 2.1.193 | Bash 模式实时文件路径补全 | 文章确认，未命中稳定 ASCII anchor | ⚠️ 需查 `!` shell input 路径 | P2；复用现有 completion/cache，不新增解析器 |
| 2.1.193 | MCP 需认证时启动提示并引导 `/mcp` | 文章确认，`mcpLogin/mcpLogout` offset 已有 | ⚠️ MCP UI 有基础，启动提示待查 | P1；在 MCP 初始化结果中聚合 auth-needed server |
| 2.1.193 | 后台 shell 内存压力自动回收 | `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP`：`89934968`, `223618514`, `230587582` | ❌ 缺失 | P1；纳入后台 shell registry，支持 env 禁用 |
| 2.1.193 | 流式输出 100ms 合并降 CPU | `100ms`：`80271024`, `80676338`, `236903857` | ⚠️ 有 no-flicker/eager flush 相关实现，需量化 | P1；统一流式渲染 throttle，避免影响 headless |
| 2.1.193 | MCP `headersHelper` 遇 401/403 rerun/reconnect | `headersHelper`：`96543520`, `105895082`; `401/403`：`234570694` | ⚠️ bridge 有 401 OAuth retry，MCP tool-call 层待补 | P1；MCP client 层按 server 粒度刷新 headers |
| 2.1.199 | subagent 被 rate limit/server error 截断时返回 partial work | `model_refusal_fallback`：`113136800`, `116226840`, `118161912`; `cli_nonstreaming_fallback_started`：`124715496`, `234644392`, `234646497` | ⚠️ 需查 AgentTool 错误回传路径 | P0；禁止把 API error 当 success，父代理收到 partial + incomplete 标记 |
| 2.1.199 | mid-stream overloaded/server error 保留 partial output | `tengu_streaming_watchdog_retry`：`124713064`, `234638789`, `234642363` | ⚠️ 有 retry/watchdog 代码，partial preservation 待验 | P0；LLM stream adapter 必须区分 partial、retryable、terminal |
| 2.1.199 | SSL 证书错误 fail-fast，不烧重试 | 文章确认 | ⚠️ 未见集中分类 | P1；在 API/MCP/bridge retry predicate 中加入证书错误短路 |
| 2.1.200 | 默认 Manual；`AskUserQuestion` 不再默认 auto-continue | 文章确认 | ⚠️ 需查当前默认权限策略 | P1；默认值变更需迁移说明，不直接静默改老用户配置 |
| 2.1.200 | daemon stale lock、respawn race、旧构建接管等后台可靠性 | `tengu_bg_*` 事件大量存在 | ⚠️ zy-code daemon 仍偏空桩，AgentTool 有后台参数 | P1；先做 stop/respawn 状态机和锁文件完整性 |
| 2.1.202 | `dynamicWorkflowSize` 与 workflow OTel 属性 | `workflowSize`：`128315880`~`240599638` | ⚠️ orchestrator 待增强 | P2；设置只是 guideline，不做硬 cap，映射到 orchestrator/WorkflowTool runtime budget/concurrency 与 OTel |
| 2.1.202 | 重复加载 skill 不再重复注入 instructions | 文章确认 | ⚠️ 需查 skill context append 路径 | P1；按 skill id + version/hash 做 turn 内去重 |
| 2.1.205 | `/doctor` 与 `DISABLE_DOCTOR_COMMAND` | `DISABLE_DOCTOR_COMMAND`：`89918120` | ✅ 已有基础 | P1；不是新建命令，而是补检查项和 i18n 文案 |

### 细项遗漏结论

真正应该进入近期工作的不是“新增 `/doctor`”，而是 Auto Mode 安全闭环、MCP 认证/重试闭环、流式/子代理 partial error 语义，以及后台任务 stop/respawn 可靠性。`/dataviz`、`dynamicWorkflowSize`、Bash 路径补全属于可排后的体验项。

---

## 六、二进制提取完整新增发现

### 6.1 新遥测事件（tengu_bg_* 系列）

CC 2.1.187+ 新增了大量 daemon 后台遥测事件：

```
tengu_bg_adopt                tengu_bg_adopt_sock_unlinked
tengu_bg_adopt_token_lost_respawn   tengu_bg_adopt_unverified
tengu_bg_adopt_upgrade_respawn      tengu_bg_agent_action
tengu_bg_agent_dispatch        tengu_bg_agent_notification
tengu_bg_agent_terminal        tengu_bg_attach
tengu_bg_attach_first_frame    tengu_bg_attach_kick
tengu_bg_attach_legacy_autorespawn  tengu_bg_attach_outcome
tengu_bg_attach_stall_gave_up  tengu_bg_attach_stall_ms
tengu_bg_attach_stall_respawn  tengu_bg_attach_upgrade
tengu_bg_attach_wake_after_reap     tengu_bg_binary_takeover
```

这表明 CC 的 daemon 子系统在持续增强。zy-code 的 daemon 尚为空桩（`src/daemon/main.ts`）。

### 6.2 子代理嵌套深度（确认）
二进制确认 `subagent_depth_cap` + `"Subagent nesting limit reached (depth ${X} of 5)"`：
- 嵌套限制：5 层
- 子队友限制：`"Teammates cannot spawn other teammates — roster is flat"`
- 后台限制：`"In-process teammates cannot spawn background agents"`

### 6.3 CC 二进制版本元数据
```
Version: 2.1.205
Build: 2026-07-08T17:39:55Z
Commit: 4cf2699a14277d4a8edf7e74442381071fc0cfd2
Platform: win32
Binary: 247MB (较 v2.1.203 的 ~254MB 减小 ~7MB)
```

---

## 七、zy-code 对应实现检查

### 7.1 堆叠斜杠技能
**文件**：`src/commands/slash/slashCommands.ts`
- ✅ `executeSkillChain()` — 已在 CC 2.1.199 之前实现
- 支持链式调用多个斜杠命令

### 7.2 子代理后台运行
**文件**：`src/tools/AgentTool/AgentTool.tsx`、`src/tools/AgentTool/loadAgentsDir.ts`、`src/tools/WorkflowTool/runtime/agentApi.ts`
- ⚠️ zy-code 已有 `run_in_background` schema、agent frontmatter `background`、自动后台 helper
- Workflow agent API 仍显式 `run_in_background: false`，这是同步 workflow 语义，不能直接全局改默认
- 建议对 AgentTool 普通子代理默认后台做灰度，对 WorkflowTool 保持 opt-in

### 7.3 动态工作流大小 / Orchestrator 映射
**文件**：`src/services/api/llmOrchestrator.ts`、`src/tools/WorkflowTool/runtime/orchestration.ts`、`src/tools/WorkflowTool/runtime/budget.ts`、`src/tools/WorkflowTool/runtime/concurrency.ts`
- ⚠️ zy-code 已有 orchestrator/WorkflowTool runtime，不应按 CC 名称重造 workflow
- 需把 CC `dynamicWorkflowSize` 映射为 orchestrator 的 advisory guideline，不应实现为硬性 agent cap
- OTel 属性可保留兼容名 `workflow.run_id` / `workflow.name`，但内部字段建议统一到 orchestrator run/session 概念

### 7.4 /doctor 诊断命令
**文件**：`src/commands/doctor/`、`src/screens/Doctor.tsx`
- ✅ zy-code 已有 `/doctor` 命令和诊断屏
- 需补齐 CC 2.1.205 的细项：MCP auth、网络、插件、sandbox、权限模式、版本锁、可写性/配置解析

### 7.5 /dataviz 技能
- ❌ zy-code 不包含 `/dataviz`
- 可通过 plugin/skill 系统补充

### 7.6 Login 过期警告
- ⚠️ bridge 层已有 OAuth 401 refresh 和 proactive refresh 逻辑
- 终端交互层的“即将过期”用户提示仍需补齐，避免只在失败后反馈

### 7.7 自动模式安全检查
**文件**：`src/services/permissions/`、`src/utils/settings/`
- ⚠️ 已有 yolo classifier、危险命令 pattern、denial tracking、`.zy` 危险目录保护
- ❌ 缺 `autoMode.classifyAllShell` 设置和“所有 shell 命令都进分类器”的执行路径
- ❌ 会话记录文件防篡改需要确认覆盖范围，至少要把 session history、transcript、undo/rewind 历史纳入同一策略

---

## 八、更新优先级建议

### 升级为 P0 的项

| 缺失能力 | 说明 | 复杂度 | 新增原因 |
|----------|------|--------|---------|
| **Auto Mode Shell 全分类** | `classifyAllShell` — PowerShell/cd/gh 等全部经过分类器 | 中 | CC 2.1.193 安全增强 |
| **Auto Mode 拒绝理由闭环** | transcript/toast/`/permissions` recent denials 对齐 | 中 | CC 2.1.193 安全可解释性 |
| **流式/子代理 partial error 语义** | partial output、incomplete 标记、API error 不伪装 success | 中 | CC 2.1.199 可靠性修复 |
| **MCP auth/retry 闭环** | 401/403 headers refresh、OAuth/capability discovery transient retry | 中 | CC 2.1.193 细项修复 |

### 新增 P1 项

| 缺失能力 | 说明 | 复杂度 |
|----------|------|--------|
| 后台任务 stop/respawn 可靠性 | stale lock、永久 stop、重生代理 retarget、低内存提示 | 高 |
| `/doctor` 诊断增强 | 已有命令，补 MCP/network/plugin/sandbox/auth 检查 | 中 |
| Login 即将过期提示 | bridge 有 refresh，TUI 需要主动提示 | 低 |
| 后台 shell 内存压力回收 | `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP` 对齐 | 中 |
| SSL/证书错误 fail-fast | 避免重试消耗额度和时间 | 低 |

### 新增 P2 项

| 缺失能力 | 说明 | 复杂度 |
|----------|------|--------|
| `dynamicWorkflowSize` + workflow OTel | 映射到 orchestrator advisory guideline + `workflow.run_id/name` 兼容属性 | 低 |
| `/dataviz` | 数据可视化技能 | 低 |
| `CLAUDE_CODE_WORKFLOW_SIZE_WARNING_*` | 映射到 orchestrator/WorkflowTool runtime 规模警告阈值 | 低 |
| Bash 模式文件路径补全 | `!` shell input 实时路径补全 | 中 |
| 默认 Manual / AskUserQuestion | 需迁移策略，避免破坏老用户习惯 | 中 |

---

## 九、落地计划

### Phase 1（近期，1-2 周）：安全与错误语义

1. **Auto Mode Shell 全分类**（P0）
   - 在 `src/utils/settings/types.ts`、`src/utils/settings/settings.ts` 增加 `autoMode.classifyAllShell`
   - 在 `src/services/permissions/` 扩展 shell 分类入口，覆盖 Bash/PowerShell/cd/gh 等所有 shell 类工具
   - 会话历史、transcript、rewind/undo 文件写入统一走危险路径保护

2. **Auto Mode 拒绝理由闭环**（P0）
   - 以 `src/services/permissions/denialTracking.ts` 为主实现，不在 `src/utils/` 新增业务逻辑
   - `/permissions` recent denials、tool result、toast/transcript 使用同一个 denial reason 结构
   - 所有新增用户可见文案写入 `src/i18n/locales/en/permissions.ts` 和 `zh-CN/permissions.ts`

3. **流式/子代理 partial error 语义**（P0）
   - LLM adapter 明确区分 retryable error、terminal error、partial output
   - AgentTool 父子代理协议增加 incomplete/partial 标记，API/usage-limit 不再回传 success
   - 补 mid-stream overloaded/server error、transient 429、refusal/non-streaming fallback 的回归测试

### Phase 2（中期，2-3 周）：MCP、后台任务与诊断

4. **MCP auth/retry 闭环**（P0）
   - MCP client/tool-call 层遇 401/403 时重新运行 headers helper 并重连 server
   - capability discovery、OAuth discovery/token 请求增加短退避重试
   - headless 模式认证失败时输出 paste URL，不弹浏览器

5. **后台任务可靠性**（P1）
   - 明确 stopped/pinned/resumed/respawned 状态机，永久 stop 不被自动恢复覆盖
   - stale lock、低内存、control byte 输出过滤、重生 agent retarget 都纳入 daemon/AgentTool 测试
   - 后台 shell 加入内存压力回收和 `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP` 对应开关

6. **/doctor 增强**（P1）
   - 保留现有 `src/commands/doctor/`，补网络、MCP auth、插件、sandbox、权限模式、版本锁检查
   - `DISABLE_DOCTOR_COMMAND` 已存在，只需统一到命令禁用 helper，避免散落 guard

### Phase 3（长期，4-6 周）：Orchestrator 与体验项

7. **Login 即将过期提示**（P1）
   - 复用 bridge OAuth refresh/token expiry 信息，在 TUI 状态栏或通知层给出提前警告
   - 避免重复刷新失败造成循环提示

8. **Orchestrator 动态规模与 OTel**（P2）
   - 在 orchestrator/WorkflowTool runtime 中添加 `dynamicWorkflowSize` 映射设置
   - small/medium/large 只作为 agent 数/上下文规模建议，不作为硬性拦截
   - orchestrator spawn agent 时附加 `workflow.run_id`、`workflow.name` 兼容遥测属性，并保留内部 orchestrator run id

9. **/dataviz 技能**（P2）
   - 实现数据可视化 skill
   - 利用现有 TerminalChart 组件

10. **Bash 路径补全与默认 Manual 迁移**（P2）
   - `!` shell input 路径补全复用现有 completion/cache 能力
   - 默认 Manual 和 `AskUserQuestion` auto-continue 变更需要迁移提示，避免直接改老用户行为

---

## 十、微信专辑 2.1.91 → 2.1.186 补读与二进制证据

> 补读范围：微信公众号专辑可见的 `2.1.91` 起全部文章标题与正文摘要。部分版本跳号或合并发布，按文章覆盖而不是按 npm version 逐号列出。

### 10.1 版本细项摘要

| 版本 | 专辑细项 | zy-code 状态 | 影响 |
|------|----------|--------------|------|
| 2.1.91 | MCP `maxResultSizeChars` 扩到 50 万字符；新增 Shell 执行安全开关；修复会话历史丢失 | ⚠️ MCP 上限/会话历史需核对 | P0/P1 |
| 2.1.92 | 启动强制同步远端配置；Bedrock 交互式认证引导；组织级 bypassPermissions 封堵 | ⚠️ 企业管控部分已有，Bedrock 引导待查 | P1 |
| 2.1.94 | 付费/企业/云平台默认 effort 从 medium 升 high；`stream-json` CJK 多字节乱码修复 | ⚠️ effort 默认策略与 stream-json 编码需核对 | P1 |
| 2.1.97 | `NO_FLICKER` 全面重写，新增 Focus View；修 `--dangerously-skip-permissions` 安全漏洞；修 MCP 内存泄漏 | ✅ 有 `ZY_CODE_NO_FLICKER`，安全细节需复查 | P0/P1 |
| 2.1.98 | 4 个 Bash 权限绕过修复；Vertex AI 交互式配置向导；Perforce 模式；Linux 子进程沙箱隔离 | ⚠️ Bash/PowerShell 权限已有大量逻辑，需专项回归 | P0 |
| 2.1.100 | 权限提示 CPU 死锁、`git pull` 卡顿、全屏重复消息；`--resume` 提速；MCP 单条结果上限扩至 500K | ⚠️ resume/MCP 已有基础，需性能与上限校准 | P1 |
| 2.1.101 | `/team-onboarding`；12 项改进、31 个 bug；命令注入安全补丁 | ❌ team onboarding 缺失；安全补丁需映射 | P0/P2 |
| 2.1.104 | 工具调用权限显式化；静默拦截变可见提示；system prompt 变体精简 | ⚠️ denial tracking 有基础，UI 可见化需补 | P0 |
| 2.1.105 | `PreCompact` Hook 可阻断压缩；子 Agent trust-but-verify；claude-api 防误触标签；SSH/ASCII/定时任务修复 | ⚠️ Hooks 有基础，PreCompact 阻断和 claude-api 标签需查 | P1 |
| 2.1.107 | thinking hints 更早出现；需要权限的 tool calls 两次确认 | ⚠️ 权限二次确认需核对 | P1 |
| 2.1.108 | 新增 `init/statusline/review/security/insights/onboarding`；Skill tool 可调用内置指令 | ✅ 多数命令已有变体，Skill 调内置命令需确认 | P1/P2 |
| 2.1.109 | extended thinking 旋转进度提示 | ⚠️ 体验项 | P2 |
| 2.1.110 | `/tui` 全屏无闪烁；手机推送通知；Write 工具 diff 感知 | ⚠️ TUI/no-flicker 有基础，推送缺失 | P1/P2 |
| 2.1.112 | 修 Opus 4.7 Auto 模式 temporarily unavailable | ⚠️ 模型可用性兜底需查 | P1 |
| 2.1.113-114 | CLI 从 JS 产物切原生二进制；4 处安全加固；Remote Control 可读子 Agent 流 | ⚠️ 架构差异较大，只采安全/remote control 语义 | P1 |
| 2.1.116 | 大会话 `/resume` 最高快 67%；MCP 冷启动提速；thinking 行内提示；VS Code/Kitty 修复 | ⚠️ resume/MCP/TUI 性能项 | P1 |
| 2.1.117 | Opus 4.7 `/context` 识别 1M；Pro/Max 默认 high effort；原生构建用 bfs/ugrep；插件依赖自动解析、managed settings 覆盖插件生命周期 | ⚠️ 插件依赖/managed settings 需核对 | P1 |
| 2.1.118 | vim visual；`/cost` 与 `/stats` 合并为 `/usage`；主题命名/插件分发；`DISABLE_UPDATES`；MCP OAuth 7 处修复 | ✅ `/usage` 有基础；MCP OAuth 需对齐 | P1 |
| 2.1.119 | `/config` 持久化；GitLab/Bitbucket/GHE PR 支持；`--print`/`--agent` 与交互权限对齐 | ⚠️ `/config` 与权限一致性需查 | P1 |
| 2.1.120 | prompt 大瘦身；移除 TodoWrite/PowerShell/computer use 老工具；新增 `ultrareview` 与 `LEAN_PROMPT` | ✅ zy-code 有 ultrareview/review 变体；LEAN_PROMPT 未见 | P2 |
| 2.1.121 | 4 处 GB 级内存泄漏；`PostToolUse` Hooks 改写权扩到全工具；MCP `alwaysLoad` 旁路 ToolSearch | ⚠️ Hooks/MCP 均需细节对齐 | P1 |
| 2.1.122 | Bedrock 服务分层 env；PR URL 反查会话；图片缩放、Vertex AI 输出、ToolSearch 漏 MCP 工具修复 | ⚠️ 云平台/PR 反查待查 | P2 |
| 2.1.126 | `claude project purge` 清空项目状态；Windows 剪贴板隐私；CJK 终端修复 | ❌ `project purge` 缺失；隐私项需查 | P1 |
| 2.1.128 | 子代理缓存写入减少；token 账单、未推送代码、1M context 可用范围修复 | ⚠️ 成本/缓存/上下文需查 | P1 |
| 2.1.129 | 1h prompt cache TTL 被降成 5 分钟的 bug 修复；3 新功能、22 修复 | ⚠️ prompt cache TTL 需确认 | P1 |
| 2.1.131 | Windows VS Code 扩展启动；Mantle `x-api-key` 修复 | ⚠️ 平台兼容项 | P2 |
| 2.1.132 | 29 项修复；新增两个 env；system prompt 重写，把谨慎执行前置 | ⚠️ prompt/环境变量需只记录，不强行照搬 | P2 |
| 2.1.133 | worktree 默认值修正；Hook 获得 effort 上下文；包体/提示词大瘦身 | ⚠️ Hook context 需补 effort 字段 | P1 |
| 2.1.136-137 | MCP 多服务器并发刷新冲突修复，不再频繁重新登录；VSCode Windows 启动补丁 | ⚠️ MCP auth refresh 并发锁需补 | P1 |
| 2.1.139 | `agent view` 上线；`/goal` 跨 turn 完成条件；Hook exec form；50+ 修复 | ✅ `/goal` 已有；agent view/exec form 需核对 | P1 |
| 2.1.140 | 紧急修 2.1.139 回归；prompt tokens 反向减少 | 记录 | P2 |
| 2.1.141 | Hook 新增 `terminalSequence`；Rewind 支持“压缩到此处”；企业身份联邦 workspace 隔离 | ⚠️ terminalSequence/rewind 压缩点待补 | P1 |
| 2.1.142 | agent view 增加 8 个配置 flag；Fast mode 升 Opus 4.7；修 Mac sleep/brew/Chrome 扩展导致后台 crash-loop | ⚠️ agent view 配置链需补 | P1 |
| 2.1.143 | 插件依赖锁；安装前 token 成本预估；agent view/`/bg` 跨 respawn 保留配置；macOS 文件夹权限/App Nap/Windows agents 修复 | ⚠️ 插件依赖锁和配置保留需查 | P1 |
| 2.1.144 | `/resume` 拉回后台 session；`/model` 不再一改全改；MCP `tools/list` 分页不丢工具 | ⚠️ 背景 session resume 与 MCP 分页需补 | P1 |
| 2.1.145 | `agents --json`；OTEL span 增 `agent_id`；Bash 环境变量赋值绕过权限提示修复 | ⚠️ agents JSON/OTEL 部分已有，Bash 安全需专项 | P0/P1 |
| 2.1.146 | `/simplify` 改 `/code-review` 并加 effort；Windows 修复；后台 session 不重复要权限；auto mode 不吞 `AskUserQuestion` | ✅ review/ultrareview 有基础；AskUserQuestion 需查 | P1 |
| 2.1.147 | Ctrl+T pin 后台会话；`/code-review --comment` GitHub 行级评论；auto-updater retry/错误分类；Windows 修复 | ⚠️ pin/update/GitHub comment 需查 | P1 |
| 2.1.148 | 修 2.1.147 的 Bash 回归 | ⚠️ Bash 权限回归测试 | P0 |
| 2.1.149 | `/usage` 按 skills/subagents/MCP server 拆账；4 个 PowerShell 权限绕过；Mac `find` 崩溃 | ✅ usage 有基础；PowerShell 安全需专项 | P0 |
| 2.1.150 | 工具描述 grep 后端切 ripgrep | ✅ 项目已优先 rg | P2 |
| 2.1.152 | `/code-review --fix` 直接改工作区；Auto Mode 不再 opt-in；skill `disallowed-tools`；`MessageDisplay` hook；`/reload-skills` | ⚠️ review/skill/hook 均需细节对齐 | P1 |
| 2.1.153 | 后台会话不再丢响应；MCP 两个安全漏洞；`/model` 默认保存 | ⚠️ 后台/MCP/model 默认策略 | P1 |
| 2.1.154 | Opus 4.8；动态 workflow 多 Agent 编排；后台会话大修 | ⚠️ 映射到 zy-code orchestrator 待增强 | P2 |
| 2.1.156 | 修 Opus 4.8 thinking block 被修改导致 API 报错 | ⚠️ LLM message invariants 需测试 | P1 |
| 2.1.157 | `.claude/skills` 本地 skill 自动加载；worktree 中途切换、Agent 调度修复 | ⚠️ 本地 skill 自动加载需查 | P1 |
| 2.1.158 | Auto Mode 扩到 Bedrock/Vertex/Foundry，仅 Opus 4.7/4.8 opt-in | ⚠️ 云平台 auto mode 需策略 | P1 |
| 2.1.160 | shell 启动文件与构建配置写入前确认；workflow 触发词改 `ultracode`；后台会话批量修复 | ⚠️ 写入前确认属 P0 安全 | P0 |
| 2.1.161 | OTEL 自定义维度；MCP secrets 不泄露到终端；并行工具调用容错 | ⚠️ MCP secret redaction 与并发容错需补 | P0/P1 |
| 2.1.162 | 启动卡死、emoji 截断崩溃、MCP 超时误杀等体验修补 | ⚠️ 稳定性项 | P1 |
| 2.1.163 | 版本强制管控；`/plugin list`；`/btw` 复制；Hook 返回上下文 | ⚠️ 版本管控/Hook context | P1/P2 |
| 2.1.166-167 | 三级备选模型；跨会话权限加固；thinking 可禁用 | ⚠️ fallback model 与权限隔离需查 | P0/P1 |
| 2.1.169 | `safe-mode` 排查模式；`/cd` 会话中切目录不丢 prompt cache；企业 MCP 策略修复 | ✅ safe-mode 有 anchor，行为需核对 | P1 |
| 2.1.170 | Fable 5 上线；VS Code 集成终端 session 保存修复 | 模型名/会话保存项 | P2 |
| 2.1.172 | 子代理 5 层递归；availableModels 管控收网 | ✅ 子代理深度已确认；模型管控需查 | P1 |
| 2.1.173 | Fable 5 模型名 `[1m]` 归一化；Windows 沙箱误报修复 | ⚠️ 模型名规范化 | P2 |
| 2.1.174-176 | `enforceAvailableModels`；`availableModels` enforcement；`footerLinksRegexes` 可编程底部链接 | ⚠️ managed settings 模型管控需补 | P1/P2 |
| 2.1.178 | `Tool(param:value)` 权限匹配；嵌套 `.claude` 目录；auto mode 子代理启动前审查 | ⚠️ 权限 DSL 和嵌套配置需核对 | P0/P1 |
| 2.1.179 | 连接中断保留部分响应；WSL2 滚动、glob 性能、UI 修复 | ⚠️ partial response 已列 P0 | P0 |
| 2.1.181 | `/config key=value` 一行改任意设置；连接中断自动重试；长段落逐行流式 | ⚠️ `/config` 与 streaming 需补 | P1 |
| 2.1.183 | auto mode 拦截破坏性 git/IaC；`attribution.sessionUrl` 防泄露；MCP auth-stub 泄露、webhook 误触审批修复 | ⚠️ 安全项优先 | P0 |
| 2.1.185 | stream-stall 文案改为 Waiting for API response，阈值 10s → 20s | ⚠️ 用户等待提示 | P2 |
| 2.1.186 | MCP 认证搬进 CLI，`--no-browser` 支持 SSH；`!` 命令自动回复；后台子代理权限抛回主会话；agent teams effort 继承 | ⚠️ MCP CLI auth 和权限转发需补 | P1 |

### 10.2 2.1.91 → 2.1.186 关键二进制 anchor

| 能力 | CC offset | zy-code 状态 | 建议 |
|------|-----------|--------------|------|
| MCP `maxResultSizeChars` / 500K 上限 | `102806232`, `212102354`, `227846446`, `227936224`, `228348502` | ⚠️ 需核对 MCP result truncation | P1：统一 server/tool 结果上限与提示 |
| `NO_FLICKER` / Focus View / 全屏无闪烁 | `89920276`, `93447228`, `97785267`, `97785399`, `135102948` | ✅ 有 `ZY_CODE_NO_FLICKER` | P2：只补回归测试 |
| `--dangerously-skip-permissions` 安全漏洞线 | `90255322`, `90255376`, `120380250`, `135098760`, `135098848` | ⚠️ 有 bypass UI/权限模式 | P0：权限 bypass 需要专项 fuzz |
| `bypassPermissions` 企业封堵 | `93284768`, `94716880`, `94718504`, `94718656`, `94734344` | ⚠️ 部分 | P0：组织策略必须压过本地设置 |
| Hook `PreCompact` | `86171382`, `86919630`, `90042663`, `93742824`, `93743512` | ⚠️ Hooks 有基础 | P1：确认能阻断压缩 |
| Hook `PostToolUse` | `86919384`, `86919440`, `86920232`, `86920430`, `86920666` | ⚠️ Hooks 有基础 | P1：全工具改写权需要边界测试 |
| Hook `MessageDisplay` | `90043015`, `106986664`, `125858152`, `151292602`, `151299528` | ⚠️ 需查 | P1：补事件分发和 i18n 文案 |
| Hook `terminalSequence` | `125999296`, `126006557`, `126226580`, `227841332`, `234796228` | ⚠️ 需查 | P2：终端通知/序列透传 |
| `agent view` | `93431760`, `129214073`, `156405750`, `156405949`, `156406261` | ⚠️ agents UI 有基础 | P1：补配置链、JSON、resume/pin |
| `agent_view` telemetry/config | `146232606`, `149976175`, `238154307`, `240483498` | ⚠️ 部分 | P1 |
| `/goal` | `86356144`, `86356256`, `135487787`, `139153680`, `139154112` | ✅ 已有 `src/commands/goal/` | P2：确认跨 turn 完成条件 |
| `project purge` | `194050085`, `229205391` | ❌ 未见 | P1：实现项目状态清理命令 |
| `DISABLE_UPDATES` | `89917368`, `141512784`, `166522248`, `166529336`, `223599970` | ⚠️ 需查 | P2：统一更新禁用开关 |
| `ultrareview` | `90086544`, `104297429`, `104297773`, `104446320`, `104446489` | ✅ review/ultrareview 有基础 | P2：行为对齐即可 |
| `code-review` | `86130176`, `86176655`, `86176754`, `86438460`, `86438513` | ✅ 有 review 命令 | P1：`--fix`/`--comment` 细项核对 |
| `/reload-skills` | `214776408`, `217639320`, `236499115`, `237994289` | ⚠️ 需查 | P2：skill 缓存刷新 |
| `availableModels` | `93427510`, `93427646`, `93427701`, `93427751`, `93469408` | ⚠️ 需查 | P1：企业模型允许列表 |
| `enforceAvailableModels` | `93469440`, `93494240`, `93494281`, `94331584`, `94331856` | ⚠️ 需查 | P1：强制模型管控 |
| `footerLinksRegexes` | `93470808`, `142035272`, `223916209`, `237584469` | ❌ 未见 | P2：可编程底部链接 |
| `safe-mode` | `91226162`, `91227162`, `91227210`, `118567674`, `156387146` | ⚠️ 有 anchor，需行为核对 | P1：排查模式禁用自定义配置 |
| `MCP_TOOL_IDLE_TIMEOUT` | `89933404`, `124290756`, `223617286`, `234516480`, `234540413` | ⚠️ 需核对 | P1：MCP 工具 idle timeout |
| MCP `alwaysLoad` | `103388440`, `137865810`, `137866370`, `153172197`, `212090896` | ⚠️ 需查 | P1：旁路 ToolSearch |
| 权限事件 `PermissionRequest` | `86015374`, `86480081`, `86919263`, `86920245`, `86920443` | ✅ 有权限系统 | P0：与 bypass/auto mode 一起回归 |
| 权限事件 `PermissionDenied` | `58795968`, `90042927`, `106985912`, `122455692`, `125936712` | ✅ 有 denial tracking | P0：拒绝理由展示闭环 |
| `Tool(param:value)` 权限 DSL | `207136729`, `232508939` | ⚠️ 需查 | P0：参数级权限匹配 |
| MCP auth `--no-browser` | `142415210`, `207132018`, `232505631`, `232505722`, `237653451` | ⚠️ 需查 | P1：SSH/headless 登录 |
| stream stall 文案 | `Waiting for API response`：`115421232`, `232572884` | ⚠️ 需查 | P2：等待提示和阈值 |
| 子代理后台参数 | `run_in_background`：`108385717`, `108443472`, `111033209`, `111062323`, `111068812` | ✅ 有 schema | P1：默认/权限转发/agent teams |
| 终端 synchronized update | `SYNCHRONIZED_UPDATE`：`98452208`, `226311356`, `226311392`, `226311424`, `226528319` | ⚠️ TUI 需查 | P2：全屏无闪烁 |
| SGR mouse protocol | `SGR`：`67917225`, `80498952`, `80649704`, `80690464`, `98792904` | ⚠️ 需查 | P2：鼠标/终端协议 |
| Auto Mode env 系列 | `CLAUDE_CODE_AUTO_MODE`：`89935480`, `89938128`, `109038360`, `109040688`, `111743880` | ⚠️ 部分 | P0：和 2.1.183/193 安全项合并 |
| 非必要网络禁用 | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`：`89922448`, `92200936`, `92201976`, `121474364`, `121604858` | ⚠️ 需查 | P2：隐私/企业管控 |

### 10.3 对落地方案的修正

补读到 2.1.91 后，P0 需要从“Auto Mode + MCP + streaming”扩展为五条安全/可靠性主线：

1. **权限绕过专项回归**：Bash、PowerShell、env assignment、`--dangerously-skip-permissions`、`bypassPermissions`、`Tool(param:value)` 参数级规则、破坏性 git/IaC。
2. **MCP 安全与可靠性**：`maxResultSizeChars`、`MCP_TOOL_IDLE_TIMEOUT`、`alwaysLoad`、auth refresh 并发锁、`--no-browser` headless 登录、MCP secret redaction、分页 `tools/list` 不丢工具。
3. **Hook 事件完整性**：`PreCompact` 可阻断、`PostToolUse` 全工具改写、`MessageDisplay`、`terminalSequence`、Hook context 带 effort。
4. **后台会话/agent view 可靠性**：agent view 配置链、`agents --json`、pin/resume、跨 respawn 保留 `--mcp-config`/`--settings`/`--model`、后台权限转发到主会话。
5. **流式与恢复语义**：连接中断保留 partial response、stream stall 文案和阈值、`/resume` 性能、CJK stream-json、全屏 no-flicker。

因此前文 Phase 1 的 Auto Mode 分类仍是 P0，但应并入“权限绕过专项”；MCP auth/retry 不只是 2.1.193 的 401/403 reconnect，还要覆盖 2.1.91 起的 result size、timeout、alwaysLoad、OAuth 并发刷新和 secret redaction。

### 10.4 二次补漏：文章细项未充分展开的功能点

> 本节专门补前文摘要粒度不够的点：后台内存、子 agents 状态、`/code-review` 行为变化、`/reload-skills`、后台通知与权限状态。以下 offset 均来自 v2.1.205 当前二进制。

| 版本 | 漏项 | CC 二进制 anchor | zy-code 状态 | 落地动作 |
|------|------|------------------|--------------|----------|
| 2.1.121 | 4 处 GB 级内存泄漏修复；MCP `alwaysLoad` 旁路 ToolSearch | `heap`：`58859488`, `58872344`, `58885528`; `alwaysLoad`：`103388440`, `137865810`, `137866370` | ⚠️ MCP/Hook 有基础，但缺内存回归维度 | 给 MCP 大输出、Hook 改写、ToolSearch 旁路加 heap/profile 回归；`alwaysLoad` 不应被 ToolSearch 裁掉 |
| 2.1.128 | 子代理缓存写入减少，避免 token 账单与 cache 写入放大 | `subagent_cache_evict`：`124549718`, `234599728`; `subagent`：`86087672`, `86130947`, `88694922` | ⚠️ 有 fork/cache-safe 优势，但子代理缓存逐出策略待核对 | 明确 AgentTool/WorkflowTool 的 cache write/evict 策略，避免 partial/error 子代理污染主会话 cache |
| 2.1.193 | 后台 shell 内存压力自动回收，空闲 shell 在压力下被 reap | `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP`：`89934968`, `223618514`, `230587582`; `low memory`：`157133596`, `157133828`, `241752134` | ❌ 未见等价后台 shell reaper | 后台 shell registry 增加 idle + memory pressure watcher，并支持禁用开关 |
| 2.1.199 | 子代理被 rate limit/server error 截断时返回 partial work，不再静默成功 | `partial work`：`150306566`, `150317672`, `240529282`; `usage limit`：`106116944`, `106122878`, `115421560`; `incomplete response`：`119184318`, `233511549` | ⚠️ CLI partial message 有基础，AgentTool 父子协议待补 | 父代理接收 `partial + incomplete + errorKind`，禁止 API/usage-limit 结果转成 success |
| 2.1.199 | 后台进度指示卡住、SendMessage 投递到重生代理、重生后需要 retarget | `progress indicator`：`240162930`; `SendMessage`：`80028001`, `86321788`, `90033088`; `retarget`：`193697075`, `229121346` | ⚠️ remote/session hooks 有基础，重生 agent 身份校验待查 | 以 agent instance id 区分同名重生实例，SendMessage 命中旧实例时要求重新选择 |
| 2.1.199-200 | stale `daemon.lock`、stop/respawn race、旧构建接管新 daemon、睡眠唤醒后静默停止 | `daemon.lock`：`86447112`, `148654267`, `236566706`, `241755958`; `stale`：`92026776` 等 | ❌ daemon 主体仍未落地，AgentTool 有后台参数 | 先做轻量 roster/lock 状态机测试，再决定完整 PTY daemon；stop 必须是终态，不能被 auto-respawn 覆盖 |
| 2.1.200-201 | Pinned/background agents 不应在自动更新后反复提示 “Continue from where you left off” | `Continue from where you left off`：`116192232`, `232690133` | ⚠️ resume/interrupt 有基础，pinned background 语义待查 | 后台/pinned session 自动恢复时静默 resume；交互 session 才提示继续 |
| 2.1.202 | 大量 git worktree 下 resume picker/name 的性能与内存改进 | `stale`、`download`、`heap` 等通用 anchor；文章细项确认 | ⚠️ resume picker/name 需专项 profile | 在多 worktree 仓库造压测数据，限制扫描范围和缓存 session title/name |
| 2.1.205 | 自动更新流式下载峰值内存降低约 400MB | `download`：`59005905`, `59018867`, `59109001`, `59109239`; `heap`：`58859488`, `59279125` | ⚠️ updater/installer 需查 | 更新包下载必须 streaming 到文件，不把完整包体留在内存；补大文件下载内存测试 |
| 2.1.205 | 后台通知不再伪造用户批准，避免权限/通知状态污染 transcript | `PermissionRequest`：`86015374`, `86919263`; `PermissionDenied`：`58795968`, `90042927`; `background notification` 未命中稳定字面量 | ⚠️ 权限系统和 notification hook 有基础 | 通知类事件不得写成 user approval；transcript/tool result 要区分 notification、approval、denial |
| 2.1.145 | `agents --json` 让脚本读取后台会话，OTEL span 增 `agent_id` 串子代理 trace | `agents --json`：`156154703`, `241617130`, `241618588`; `agent_view`：`146232606`, `149976175` | ⚠️ agents UI/任务面板有基础，JSON/API 化待查 | 为 agents/session roster 输出稳定 JSON schema，并在 telemetry 上补 `agent_id` |
| 2.1.146 | `/simplify` 改 `/code-review` 并加 effort；后台 session 不重复要权限；auto mode 不吞 `AskUserQuestion` | `code-review`：`86130176`, `86176655`, `86438460`; `AskUserQuestion`：`86127840`, `86552281`, `140936808` | ✅ review 有基础；AskUserQuestion/后台权限细节待查 | `/code-review` 参数解析保留 effort；auto mode 下 AskUserQuestion 仍必须显式呈现 |
| 2.1.147 | `/code-review --comment` 支持 GitHub PR 行级评论；auto-updater 增 retry/错误分类 | `code-review` 同上；源码已有 `src/commands/pr-comments/` 与 GitHub app prompt | ⚠️ PR comment 读取有基础，写回行评需查 | 把 comment 发布和 review 结果拆成可测试服务，避免 review 命令直接硬编码 GitHub 行评逻辑 |
| 2.1.152 | `/code-review --fix` 直接应用到工作区；skill 支持 `disallowed-tools`；新增 `MessageDisplay` hook；`/reload-skills` | `code-review`：`86130176`, `86176655`; `disallowed-tools`：`106956824`, `136999890`, `186052850`; `MessageDisplay`：`90043015`, `106986664`; `reload-skills`：`214776408`, `217639320`, `236499115`, `237994289` | ⚠️ review/MessageDisplay 有基础；reload-skills 未作为明确命令落地 | `/code-review --fix` 走现有编辑权限；skill loader 加 disallowed tools 约束；补 `/reload-skills` 或等价 command，刷新本地/插件 skill cache |
| 2.1.202 | `/review <pr>` 恢复快速单 pass；多 agent review 改由 `/code-review <level> <pr#>` 承担 | `code-review` offsets 同上；`/review` 文章细项确认 | ⚠️ review/ultrareview 并存，职责边界需整理 | 明确 `/review` 快速检查、`/code-review` 多级/可修复/PR 评论；避免两个命令互相调用形成延迟 |
| 2.1.186 | 后台子代理权限从自动拒绝改为抛回主会话；agent teams effort 继承 | `run_in_background`：`108385717`, `108443472`, `111033209`; `AskUserQuestion`：`86127840`, `86552281`; `permission`：`59155992`, `60478331` | ⚠️ AgentTool 有后台 schema，权限转发需查 | 后台子 agent 遇权限请求时生成 parent-visible permission request，而不是本地 auto-deny |

### 10.5 文档口径修正

前文的 10.1 表只适合作为版本索引，不能代表完整落地清单。实际排期应以 10.4 的细项表和 11.6 的优先级合并为准，尤其：

- `/code-review` 不是“已有 review 命令即可”，还要核对 `--fix`、`--comment`、effort、快速 `/review` 分流、多 agent review 分流。
- `/reload-skills` 不能只写成 P2 名称，要确认 skill cache、plugin skill、本地 `.claude/skills`、disallowed-tools 生效边界。
- “后台任务可靠性”需要拆成内存 reaper、daemon lock/respawn、agent retarget、权限转发、JSON roster、通知/approval 语义。
- “子代理 partial error”需要覆盖 rate limit/server error、usage limit、partial work、incomplete response、progress indicator，不只是 API error 文案。

---

## 十一、v2.1.187 深度对比基线合并校准

> 本节吸收原 `zy-code-vs-claude-code-deep-comparison.md`。过时内容不再原样保留：凡是当前代码已实现、v2.1.205 二进制证据已改名、或前文已重新定级的项，统一按本节口径覆盖。

### 11.1 保留的有效差距

| 领域 | 原基线结论 | 合并后校准 | 当前落地级别 |
|------|------------|------------|--------------|
| Hooks 系统 | CC hook 事件更多，zy-code 仅有基础事件 | 保留。zy-code 已有 hook 框架和 HTTP hooks 企业管控，但 `MessageDisplay`、`SubagentStart/Stop`、`PermissionRequest/Denied`、`PostToolBatch`、`PostToolUseFailure`、`UserPromptExpansion`、`Setup`、`CwdChanged/FileChanged`、`Elicitation*`、`WorktreeCreate`、`ConfigChange`、`terminalSequence`、Hook context effort 仍需核对/补齐 | P1，权限相关 hook 进入 P0 回归 |
| Refusal fallback | zy-code 只显示 refusal 错误，不切备用模型 | 保留，并已在前文用 v2.1.205 offset 更新：`model_refusal_fallback`、`cli_nonstreaming_fallback_started` 属于同一类容错闭环 | P0 |
| Streaming watchdog / non-streaming fallback | zy-code 有 watchdog 但缺自动重连和非流式降级 | 保留。补充 v2.1.179 partial response、v2.1.185 stream-stall 文案、v2.1.199 partial output/incomplete 语义 | P0 |
| Compact 压缩 | zy-code 多层 compact 领先，缺 `COLD_COMPACT` | 保留为优势项。`COLD_COMPACT` 不进入 P0，只作为 session resume/冷启动体验项 | P2 |
| Prompt cache 管理 | zy-code cache break detection 更细，缺按模型禁用开关 | 保留为优势项。补充 v2.1.129 prompt cache TTL bug 的回归检查 | P2/P1 |
| 工具执行并发 | `MAX_TOOL_USE_CONCURRENCY` 基本对等，缺 `PostToolBatch` hook | 保留。并发执行本体不作为差距，hook batch 事件并入 Hooks | P1 |
| 终端渲染 | zy-code 有 virtual scroll/no-flicker 基础，缺 synchronized update、SGR mouse、wheel acceleration、mouse disable | 保留，但降级为体验/可访问性，不再抢 P0 | P2 |
| Auto-copy | `copyFullResponse` 已有，daemon 模式自动提示缺失 | 保留，但依赖 daemon；不独立排高优先级 | P3 |
| Safe Mode / Supervised | zy-code 无完整安全排查/监管模式 | 保留，补充当前二进制 `safe-mode` offset 已更新到前文 10.2 | P1 |
| Daemon / 多终端会话同步 | daemon 入口空桩，缺 roster/lock/attach/PTY/fleet view | 保留。前文 2.1.199/200/203/204 进一步证明后台 daemon 是长期主线，不适合夹在短期安全修复里 | P2 高复杂度 |
| Session resume 高级参数 | 仅有 `ZY_CODE_RESUME_INTERRUPTED_TURN`，缺从指定 session/prompt/阈值恢复 | 保留，但前文已把 `/resume` 性能和后台 session resume 并入流式/后台主线 | P2 |
| sandbox.credentials / allowAppleEvents | v2.1.187 凭证隔离缺失，macOS Apple Events 缺失 | 保留。`sandbox.credentials` 是安全项，应并入权限绕过/凭证泄漏 P0；Apple Events 是 macOS P2/P3 | P0/P2 |
| MCP 可靠性与管控 | v2.1.178 起 MCP timeout、allowlist、HTTP hook 管控、tools/list 分页等差距 | 保留但重排。HTTP hooks 托管管控已对齐；剩余 MCP result size、idle timeout、alwaysLoad、auth refresh 并发锁、secret redaction、`--no-browser`、tools/list 分页并入 MCP 主线 | P1，secret/权限项 P0 |
| Agent/team/swarm | 子代理嵌套、agent teams、后台会话、agent view 有差距 | 保留，但标注 zy-code 已有 `run_in_background`、`/goal`、AgentTool 基础；差距集中在默认/权限转发/roster/配置链 | P1/P2 |
| 企业/基础设施 | Perforce、OTEL、container id、plugin zip cache、5 级设置源等差距 | 保留为 P2/P3，不与安全主线混排 | P2/P3 |

### 11.2 删除或修正的旧判断

| 旧判断 | 处理 | 原因 |
|--------|------|------|
| “zy-code 无三级 Auto Mode 分类器，仅简单权限模式切换” | 删除 | 当前 `autoMode` settings、permission classifier、dangerous pattern、denial tracking 已有基础；真正差距是 `classifyAllShell`、两阶段/上下文/温度等细节 |
| “`/doctor` 缺失” | 删除 | 当前已有 `src/commands/doctor/` 和 `src/screens/Doctor.tsx`；应写成诊断增强 |
| “Proactive / auto memory / task list / fork subagent 纯缺失” | 删除 | 当前已有 `ZY_CODE_PROACTIVE`、`ZY_CODE_DISABLE_AUTO_MEMORY`、`ZY_CODE_TASK_LIST_ID`、`FORK_SUBAGENT` 对应能力或命名不同实现 |
| “HTTP hooks 企业管控是差距” | 删除 | `allowedHttpHookUrls`、`httpHookAllowedEnvVars`、`allowManagedHooksOnly` 与执行器均已对齐 |
| “Sub-agent 嵌套完全缺失” | 修正 | v2.1.205 二进制确认深度 5；zy-code 需要核对深度限制和父子权限，而不是从零实现 spawn |
| “缺失命令清单按 v2.1.177 直接排期” | 删除 | 多数命令已新增或被重命名；当前只保留 `/dataviz`、`project purge`、`/reload-skills`、`/team-onboarding`、`/recap`、`/stop`、`/scroll-speed` 等需复查项 |
| “旧 offset 可直接继续使用” | 删除 | 本文统一以 v2.1.205 二进制 offset 为准；旧 offset 仅作为历史参考，不再进入执行计划 |
| “Daemon 进程 P2 即可” | 修正 | daemon 本身仍是高复杂度 P2/P3，但后台 session 的 stop/respawn/partial/error 转发是 P1；安全相关转发进入 P0/P1 |

### 11.3 基线文档中的 zy-code 优势，保留为决策约束

| 优势 | 保留原因 | 对落地方案的约束 |
|------|----------|------------------|
| 多 Provider 适配 | zy-code 支持 Anthropic、DashScope、OpenRouter、Generic 等，比 CC 单 Anthropic/Bedrock/Vertex 模式更复杂 | 新增 model fallback、availableModels、Auto Mode 云平台支持时必须经过 provider abstraction，不可写死 Anthropic SDK 类型 |
| 分层模型系统 | advanced/standard/compact 与 modelOverrides 已有 | Fable/Sonnet/Opus 类模型策略应落在 capability/config 层，而不是 scattered if |
| 多层 compact | reactive/micro/cached/API/context collapse/circuit breaker 已有 | 只补 `COLD_COMPACT` 和 resume 场景，不重构 compact 主链 |
| Prompt cache break detection | per-tool hash、cache-control hash、diffable content、cache deletion/compaction 防误报已比基线 CC 更细 | v2.1.129 TTL 修复只需补回归与配置，不要替换现有检测器 |
| Persistent retry + heartbeat | `ZY_CODE_UNATTENDED_RETRY`、429/529 长重试、rate limit reset header 已有 | streaming fallback 要与现有 `withRetry` 合流，不另起一套 retry 状态机 |
| Tool use summary | zy-code 有工具执行摘要生成器 | v2.1.205 的 partial/incomplete 语义需要让摘要能表达失败/部分完成 |
| Cache-safe forked agent | `runForkedAgent()` + `skipCacheWrite` 是优势 | 后续子代理 partial/error 回传要避免污染主会话 cache |
| 独有命令/模式 | Thinkback、Bughunter、UltraPlan、Insights、Advisor、Workflow、Schedule、Teleport、AutoDream 等 | 不追求和 CC 命令一一同名，优先补安全/可靠性语义 |

### 11.4 合并后的设置与环境变量清单

| 类别 | 保留项 | 状态 |
|------|--------|------|
| 已对齐 env | `ZY_CODE_MAX_TOOL_USE_CONCURRENCY`、`ZY_CODE_AUTO_COMPACT_WINDOW`、`ZY_CODE_MAX_RETRIES`、`ZY_CODE_MAX_OUTPUT_TOKENS`、`ZY_CODE_SCROLL_SPEED`、`ZY_CODE_EAGER_FLUSH`、`ZY_CODE_BUBBLEWRAP`、`ZY_CODE_AGENT_LIST_IN_MESSAGES`、`ZY_CODE_DISABLE_PRECOMPACT_SKIP`、`ZY_CODE_NO_FLICKER`、`ZY_CODE_COMMIT_LOG`、`ZY_CODE_BRIEF`、`ZY_CODE_BRIEF_UPLOAD`、`ZY_CODE_SYNTAX_HIGHLIGHT`、`ZY_CODE_TERMINAL_RECORDING`、`ZY_CODE_PERFETTO_TRACE`、`ZY_CODE_SSE_PORT`、`ZY_CODE_SUBAGENT_MODEL`、`ZY_CODE_OVERRIDE_DATE`、`ZY_CODE_STALL_TIMEOUT_MS_FOR_TESTING`、`ZY_CODE_AUTO_MODE_MODEL`、`ZY_CODE_INVESTIGATE_FIRST`、`ZY_CODE_IDLE_TOKEN_THRESHOLD`、`ZY_CODE_IDLE_THRESHOLD_MINUTES`、`ZY_CODE_IS_COWORK`、`ZY_CODE_LOOP_PERSISTENT` | 保留为已对齐，不进入缺失清单 |
| 仍值得补的 env/settings | `DISABLE_REFUSAL_FALLBACK`、`DISABLE_NONSTREAMING_FALLBACK`、`RETRY_WATCHDOG`、`COLD_COMPACT`、`DISABLE_MOUSE`、`SAFE_MODE`、`SUPERVISED`、`RESUME_FROM_SESSION`、`RESUME_PROMPT`、`RESUME_THRESHOLD_MINUTES`、`RESUME_TOKEN_THRESHOLD`、`MCP_TOOL_IDLE_TIMEOUT`、`MCP_ALLOWLIST_ENV`、`MANAGED_SETTINGS_PATH`、`HOST_PLATFORM`、`sandbox.credentials`、`sandbox.allowAppleEvents`、`respondToBashCommands`、`attribution.sessionUrl`、`enforceAvailableModels`、`disableBundledSkills`、`footerLinksRegexes`、`wheelScrollAccelerationEnabled`、`allowedHttpHookUrls` 相关已对齐项只保留验证 | 按前文 P0/P1/P2 重排 |
| 不建议照搬的内部实验项 | Pewter Owl、BYOC Datadog、CFC、tentative/opaque `ENABLE_*`、内部 artifact/plan 变体 | 仅记录，不进入近期落地计划 |

### 11.5 合并后的命令与工具判断

| 类别 | 结论 |
|------|------|
| 已有或有等价实现 | `/ultrareview`、`/review` 远端审查入口、`/security-review`、`/release-notes`、`/insights`、`/tasks`、`/powerup`、`/voice`、`/plan`、`/goal`、`/doctor`、ToolSearch、NotebookEdit、TodoWrite |
| 仍需核对/补齐 | `/code-review` 独立命令与 `--fix/--comment/effort` 语义、`/dataviz`、`project purge`、`/reload-skills`、`/team-onboarding`、`/recap`、`/stop`、`/scroll-speed`、`/fast`、`/usage-credits`、`/extra-usage`、NotebookRead、Cd 工具、PushNotification、RemoteTrigger |
| 不建议单独追的项 | 与 CC 内部运营或 Claude.ai 平台强绑定的 stickers/radio/teleport/desktop/mobile 等，除非 zy-code 产品目标明确需要 |

### 11.6 最终优先级合并

| 优先级 | 合并后主题 | 说明 |
|--------|------------|------|
| P0 | 权限绕过与凭证隔离 | Bash/PowerShell/env assignment、`Tool(param:value)`、bypassPermissions、`sandbox.credentials`、破坏性 git/IaC、Auto Mode 全 shell 分类 |
| P0 | 流式/模型失败恢复 | refusal fallback、streaming watchdog retry、non-streaming fallback、partial output、incomplete 标记 |
| P0/P1 | MCP 安全可靠性 | result size、timeout、auth refresh 并发锁、secret redaction、tools/list 分页、`--no-browser` |
| P1 | Hooks 完整性 | `PreCompact` 阻断、`PostToolUse` 全工具改写、`MessageDisplay`、权限 hooks、terminalSequence、effort context |
| P1 | 后台会话/agent view | stop/respawn、pin/resume、配置链、JSON、权限转发 |
| P1/P2 | 设置与命令体验 | `/code-review` 分流与 `--fix/--comment`、`/reload-skills`、safe-mode、availableModels enforcement、footer links、wheel acceleration、project purge |
| P2/P3 | daemon 完整子系统与企业基础设施 | daemon lock/roster/PTY attach、Perforce、OTEL、plugin zip cache、container id |

---

## 十二、本地 cc 文档全量复核校准

> 2026-07-10 使用 `C:\Users\soleil\Desktop\cc` 下 80 篇 Markdown 全文复核，覆盖 2.1.92、2.1.94、2.1.97、2.1.98、2.1.100-2.1.205。该本地目录作为本文最终校准来源；前文微信专辑索引只保留为版本脉络。

### 12.1 本次复核补出的缺口

| 主线 | 本地文档确认的细项 | 当前文档处理 |
|------|--------------------|--------------|
| Resume / 长会话内存 | 2.1.100 `--resume` 大会话提速 45%、峰值内存降 100-150MB；2.1.101 修 dead-end branch 导致上下文丢失；2.1.187 修零模型回合 `--resume` 找不到会话；2.1.200 修后台 stall respawn 后重跑 Esc 取消 turn | 从“resume 性能”提升为 P1 回归域：恢复路径必须覆盖 fork-heavy、大文件、零 turn、后台 session 与 interrupted turn |
| 历史对话展开 / 全量查看 | 2.1.100/116/117 连续提升 `/resume` 性能；2.1.121 修长会话虚拟滚动器历史列表泄漏；2.1.203 修长 transcript 上滚跳动、context usage indicator 每 turn 全量重算 | zy-code 当前仍有分页/截断式历史加载痕迹：`src/assistant/sessionHistory.ts` `HISTORY_PAGE_SIZE = 100`，`src/bridge/replBridge.ts` `initialHistoryCap = 200`，Remote Bridge 初始 flush 会 cap 到最近消息；需要对齐 CC “可以直接查看所有对话”的体验，减少必须 `Ctrl+E` 手动继续展开 |
| Compact 进度可见性 | 2.1.105 `PreCompact` 可阻断；2.1.117 修 Opus 4.7 autocompact 过度触发；2.1.141 Rewind 支持“压缩到此处”；2.1.186 MEMORY.md 接近上限时提醒压缩；v2.1.205 二进制存在 `compact_progress` / `Compacting` | zy-code 有多层 compact 和 `onCompactProgress` 入口，但文档此前未把“压缩进度条/进度事件”作为落地项；需核对本地 TUI、远程 session、headless 三条路径 |
| MCP result / timeout / auth | 2.1.100 `_meta["anthropic/maxResultSizeChars"]` 单结果最高 500K；2.1.146/147 修 MCP 分页丢 page 1 之后资源；2.1.187 `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`；2.1.191/193 headersHelper 401/403 自动重跑，OAuth discovery/token retry，无头直接 paste URL | MCP 主线拆为 result cap、分页、idle timeout、auth refresh、headless auth、secret redaction，不能只写“增强 MCP” |
| Hooks / skills | 2.1.105 `PreCompact` 可 block compaction，plugin `monitors` 后台监控；2.1.145 `Stop`/`SubagentStop` hook 输入增加 `background_tasks`、`session_crons`；2.1.152 `disallowed-tools`、`/reload-skills`、`SessionStart.reloadSkills`、`MessageDisplay`、`hookSpecificOutput.sessionTitle` | `/reload-skills` 是独立于 `/reload-plugins` 的 skill 目录重扫命令；Hooks 补 `PreCompact`、`MessageDisplay`、Stop/SubagentStop 上下文、plugin monitors |
| Plugin reload | 2.1.98 `/reload-plugins` 可热加载插件提供的 skill；2.1.110 Remote Control 可执行 `/reload-plugins`；2.1.116 `/reload-plugins` 与后台插件更新会自动安装 marketplace 缺失依赖 | `/reload-plugins` 是插件生命周期命令，不能被 `/reload-skills` 合并或替代；zy-code 已有入口，但需要核对 plugin-provided skills、依赖安装、Remote Control 场景 |
| `/code-review` 命令族 | 2.1.146 `/simplify` 改 `/code-review` 并加 effort；2.1.147 `--comment` 行级 GitHub PR 评论，同时旧 cleanup-and-fix 行为移除；2.1.152 `--fix` 又把 review findings 直接应用到工作区，`/simplify` 变快捷方式；2.1.202 `/review <pr>` 回归快速单 pass，多 agent review 下沉到 `/code-review <level> <pr#>` | 当前 zy-code 有 `/ultrareview`，没有独立 `/code-review`。落地应做成 review 命令族语义分层，而不是简单别名 |
| Workflow / Orchestrator | 2.1.154 动态 workflow 多 Agent 编排；2.1.160 触发词从 `workflow` 改 `ultracode`；2.1.202 `dynamicWorkflowSize` 与 `workflow.run_id/name` OTel 属性、`/workflows` 列表 UI 改进 | zy-code 不应按 CC 名字照搬 workflow；应映射到现有 orchestrator / `WorkflowTool` runtime：`src/services/api/llmOrchestrator.ts`、`src/tools/WorkflowTool/runtime/orchestration.ts` |
| 后台 agent 状态 | 2.1.145 `agents --json`、agent OTEL 父子 trace、等待输入数；2.1.147 pinned background session；2.1.187 agent view `working` 状态修复、停止通知归因、subagent depth restore；2.1.198 Notification hook `agent_needs_input`/`agent_completed`、任务面板不再 stale Running；2.1.205 SendMessage 后状态不再卡 failed/completed、无文本 turn 不再从 needs input 跳 working | 需要以 state machine 方式落地：queued/running/needs_input/completed/failed/stopped/resuming/pinned，不再靠文本或单个 boolean |
| daemon / roster / lock | 2.1.199 corrupted worker record 导致 daemon 每 50 秒自杀；stop 与 respawn race；SendMessage 复用旧 agent name 要求 retarget；2.1.200 stale `daemon.lock` PID 复用、旧构建接管新 daemon、roster 损坏、socket token 被清；2.1.203 token 过期自愈、PATH/BaseURL 继承、工作目录失效 clear error、auto-upgrade failure 不杀所有 session、TaskStop/TaskOutput 跨代理查找 | zy-code `src/daemon/workerRegistry.ts` 仍是 `not implemented`，只能写“有入口和桥接基础”，不能写 daemon 已对齐。近期应先做后台可靠性 P1 子集，完整 daemon P2/P3 |
| 内存与渲染 | 2.1.101 virtual scroller 历史 message list 泄漏；2.1.121 4 处 GB 级内存泄漏；2.1.191 streaming 100ms 合并降 37% CPU、终端输出 cache 减长会话内存；2.1.193 后台 shell memory-pressure reaper；2.1.203 lazy load 省 7MB、context usage 不再每 turn 全量重算；2.1.205 update streaming download 省约 400MB | 新增“资源长跑”回归域：interactive render、terminal cache、context indicator、background shell、updater download、resume loader |
| 权限与人工边界 | 2.1.104 permission blocked tool call 从静默变显式；2.1.145 裸 env assignment bypass；2.1.146 auto 不吞 `AskUserQuestion`；2.1.187 `sandbox.credentials`；2.1.191 `autoMode.classifyAllShell` 与 denial reason；2.1.200 默认 Manual、AskUserQuestion 不 auto-continue；2.1.203 手动权限模式 footer 展示灰色 `⏸` 状态；2.1.205 transcript 防篡改、未解析变量 `rm -rf` 先询问、后台通知声明无人工输入 | P0 安全清单需覆盖“人工输入来源可信度”；P1/P2 需要补“当前为手动模式”的可见 UI 状态，而不是只改默认值 |

### 12.2 zy-code 已实现、差异化、待增强

| 类别 | 结论 | 说明 |
|------|------|------|
| 已实现或基本等价 | `/doctor`、`/agents` 交互视图、`/background` 本地 shell 后台化、`/reload-plugins`、`/skills`、`/ultrareview`、`/goal`、`/chrome`、`/mobile`、bridge resume、PermissionRequest hook 基础 | 这些不应再写成“缺失”。但它们多为入口或局部能力，不能等同 CC 对应完整行为 |
| 已实现但需增强 | `/doctor` 应补 `/checkup` alias 与自动修复能力；`/agents` 应补 `--json`、状态机、PR link、pin/resume；`/background` 应补 skill/slash-only 输入、已授权权限继承、低内存提示；`/reload-plugins` 只负责插件生命周期，另补独立 `/reload-skills` 负责 skill 目录重扫 | 这些适合进 P1/P2，不需要从零造命令 |
| 差异化保留 | `/ultrareview` 作为 ZY Code on the web 的远端审查入口继续保留；Thinkback、Insights、Teleport、Bughunter、orchestrator/WorkflowTool runtime 等 zy-code 特性不因 CC 命名变化而删除 | 文档中不再要求命令名一一复制，优先复制安全、可靠性和用户可预期语义 |
| 不建议追 | Claude in Chrome GA、Fable/Sonnet 品牌默认值、AWS `anthropicAws`、Claude.ai 平台强绑定 remote/mobile/sticker/radio 细节、原生二进制瘦身策略 | 除非 zy-code 产品目标明确需要，否则只作为参考，不进入近期计划 |
| 需要用户确认 | 是否把默认权限切到 Manual；是否允许 `/code-review --fix` 默认直接改工作区；后台 agent 是否允许自动 commit/push/draft PR；完整 daemon 是否作为近期里程碑 | 这几项会明显改变交互安全感和产品定位，不建议文档直接拍板 |

### 12.3 修正后的落地方案

1. **P0：安全与人工边界**
   - 补 Auto Mode 全 shell 分类、denial reason、裸 env assignment、`Tool(param:value)`、PowerShell/Bash 绕过、破坏性 git/IaC、session transcript 防篡改。
   - 引入 `sandbox.credentials` 设计，先做敏感文件/敏感 env 隔离策略和日志脱敏。
   - `AskUserQuestion` 和后台通知必须带“是否真人输入”的可信来源字段，禁止 transcript 文本伪造成审批。

2. **P0/P1：流式、partial 与子代理错误语义**
   - AgentTool/WorkflowTool 父子协议增加 `partialWork`、`incomplete`、`errorKind`、`usageLimit`、`rateLimited` 字段。
   - 流式中途 overload/server error 保留 partial output 并标记 incomplete；API/usage-limit 不再回传 success。
   - 复用现有 retry/heartbeat，不另起 retry 状态机。

3. **P1：MCP 可靠性闭环**
   - 支持 `_meta["anthropic/maxResultSizeChars"]`、tools/resources/prompts 分页、`MCP_TOOL_IDLE_TIMEOUT`、401/403 headersHelper 续期、OAuth retry 与 `--no-browser`。
   - 启动时明确提示需要认证的 MCP server；远程/插件 MCP 的 secret、server name reserved、无效名称导入继续等行为进入回归测试。

4. **P1：Hooks 与 skills 热更新**
   - 补 `PreCompact` 阻断、`MessageDisplay`、Stop/SubagentStop 上下文、`terminalSequence`、SessionStart `reloadSkills/sessionTitle`。
   - 新增独立 `/reload-skills`：只负责重扫 skill dir、本地 `.claude/skills`、search index、bundled/builtin/plugin skill cache，并让 SessionStart `reloadSkills:true` 安装的 skill 在当前 session 可见。
   - 保留 `/reload-plugins` 独立语义：负责插件变更、插件提供的 commands/agents/skills/hooks/MCP/LSP、marketplace 依赖安装和 Remote Control 触发，不与 `/reload-skills` 合并。
   - skill/slash frontmatter 支持 `disallowed-tools`，并在工具合并层做最终扣减。

5. **P1：后台 agent 状态与资源长跑**
   - 先不承诺完整 daemon，先做状态机、`agents --json`、pin、needs input、completed/failed/stopped/resuming、SendMessage retarget。
   - 修正后台任务的权限继承、低内存提示、后台 shell reaper、progress indicator、无文本 turn 状态跳变。
   - 建立长会话内存测试：virtual scroller、terminal output cache、context usage indicator、resume loader、update download。

6. **P1：历史对话展开与全量查看**
   - 减少“默认只展示最近一段，用户按 `Ctrl+E` 才能继续展开”的阻塞体验；长会话应能直接查看所有对话，或至少后台渐进加载 older pages，不打断阅读。
   - 统一本地 session、remote session、assistant history 三条路径的分页策略：`HISTORY_PAGE_SIZE`、`initialHistoryCap`、Remote Bridge `flushHistory()` 的 cap 需要变成懒加载/虚拟滚动策略，而不是不可见截断。
   - 长 transcript 查看需要避免 2.1.203 已修过的问题：上滚跳动、每 turn 全量重算 context usage、虚拟列表持有历史副本导致内存增长。
   - UI 应有明确“已加载全部/正在加载更早消息/加载失败可重试”状态，`Ctrl+E` 只能作为快捷键，不应是继续展开历史的唯一入口。

7. **P1：Compact 进度条与可观测性**
   - 复用现有 `src/screens/REPL.tsx` 的 `onCompactProgress` 入口，核对本地 TUI、remote session、headless/print 是否都能收到 compact start/progress/end。
   - `src/query/compaction.ts` 当前主要在 compaction 完成后 yield post-compact messages；需确认 autocompact 过程中是否有阶段/百分比事件，否则补 `compact_progress` 事件桥接。
   - UI 上压缩中应展示稳定进度条/阶段文案，完成后展示 pre/post token、压缩消息数、失败重试/阻断原因；用户可见文案走 i18n。

8. **P1/P2：review 命令族**
   - 保留 `/ultrareview` 远端审查；新增或复用入口实现 `/code-review low|medium|high`、`--comment`、`--fix`、PR number 参数。
   - `/review <pr>` 做快速单 pass；多 agent review 与自动修复走 `/code-review`。
   - `--fix` 默认是否启用需要产品确认；建议先要求显式参数且走权限提示。

9. **P2/P3：完整 daemon 与企业基础设施**
   - 完整实现 daemon roster/lock/socket token/old build handover/PTY attach/worktree isolation/TaskStop/TaskOutput 跨 agent 查找。
   - 企业项如 Perforce、availableModels 强约束、plugin marketplace allowlist、OTEL orchestrator/workflow agent trace、container id 分阶段做。
   - CC 的 `dynamicWorkflowSize` 和 `workflow.run_id/name` 不按名字生搬，映射到 zy-code orchestrator 配置、`WorkflowTool` runtime budget/concurrency 与 OTel 属性。

### 12.4 本地文档复核后的文档口径

- 前文 10.1 版本表只作为索引，不作为排期依据；排期以 12.3 为准。
- “后台会话可靠性”拆成状态机、资源回收、权限转发、daemon roster、通知可信来源五类。
- “子代理状态修复”不只是不谎报成功，还包括 partial work、空结果、usage limit、depth restore、idle collapse、retarget、agent view 状态跳变。
- “内存修复”覆盖 resume、virtual scroller、terminal output cache、context usage indicator、streaming render、background shell、updater download。
- “历史对话展开”不只是 `/resume` 快：还包括长会话直接查看所有消息、渐进加载 older pages、避免 `Ctrl+E` 成为唯一展开路径、以及全量历史下的虚拟滚动/内存控制。
- “Compact 体验”不只包括 `PreCompact` hook，还包括压缩中的进度条/阶段事件、完成后的 token delta 与阻断/失败原因。
- “`/reload-skills`”必须包含 cache invalidation 与同 session 可见性，不能只做命令壳；“`/reload-plugins`”必须保留插件生命周期语义，两者是两个命令。
- “workflow”相关项在 zy-code 中落到 orchestrator/WorkflowTool runtime，文档不再把 CC workflow 原名直接等同为缺失。
- “默认 Manual”不只是一条策略：还包括 `AskUserQuestion` 不默认 auto-continue、手动模式在 footer/状态栏可见、mobile/web/Remote Control 权限模式显示一致。

### 12.5 本地复核新增项的二进制证据锚点

| 功能点 | v2.1.205 二进制字符串/偏移 | 说明 |
|--------|----------------------------|------|
| `/reload-skills` | `214776408`, `217639320`, `236499115`, `237994289` | 对应 2.1.152 新命令，需落到 skill cache reload，而非 plugin reload |
| `/reload-plugins` | `100461006`, `126841263`, `127194157`, `131428478`, `131498303`, `131498527`; `reloadPlugins`：`143659200`, `143802464`, `215258416`, `236815135` | 与 `/reload-skills` 不同；对应插件生命周期、插件提供 skill/command/hook/MCP/LSP、marketplace 依赖刷新 |
| `/code-review` | `86130176`, `86176655`, `86176754`, `86438460`, `86438513` | 对应 rename、effort、`--comment`、`--fix` 命令族 |
| `MessageDisplay` hook | `90043015`, `106986664`, `125858152`, `151292602`, `151299528`, `151313872`, `151329536`, `151329696` | 对应 2.1.152 消息展示改写/隐藏 |
| `AskUserQuestion` | `86127840`, `86552281`, `86552323`, `89948219`, `140926451`, `140936808`, `151437076`, `217408112` | 对应 auto/manual/idle timeout 与人工输入边界 |
| 默认 Manual / 手动模式展示 | `permission mode`：`88803191`, `93391920`, `93451272`, `104412854`; `defaultMode`：`93393128`, `93740992`, `93741344`, `94275208`; `permission-mode`：`88803453`, `120380330`, `135098922`; `Manual`：`59404831`, `86200958`, `114698312` | 对应 2.1.200 默认 Manual、2.1.203 手动模式 footer 可见状态、Remote Control/mobile/web 权限模式一致性 |
| 历史对话展开 / 全量查看 | `conversation history`：`86168017`, `106257600`, `125766015`, `223004257`, `229708869`, `230295473`; `show all`：`59656039`, `61117895`, `133800040`, `133800768`; `Expand`：`59690476`, `59690959`, `59702623`, `59726172`; `Ctrl+E`：`60379399`, `214220128`, `236118360` | 对应历史对话查看、展开和快捷键；zy-code 需从手动继续展开改为全量/渐进历史查看 |
| Compact 进度条/事件 | `compact_progress`：`109892056`, `109915368`, `109963496`, `110123512`, `110152920`, `110162520`, `110180848`, `123562144`, `124986608`; `Compacting`：`107787411`, `107800194`, `107806264`, `124991448`, `230126979` | 对应压缩过程的进度/状态展示；zy-code 需核对 `onCompactProgress` 是否完整接入 autocompact、本地 TUI 和 remote session |
| `disallowed-tools` | `106956824`, `136999890`, `156392653`, `182330641`, `186049466`, `186051802`, `186052850`, `226086954` | 对应 skill/slash frontmatter 禁用工具 |
| `agents --json` | `156154703`, `241617130`, `241618588` | 对应后台会话脚本可观测接口 |
| agent view 状态 | `agent view`：`93431760`, `129214073`, `156405750`, `156405949`, `156406261`; `agent_view`：`146232606`, `149976175`, `238154307`, `240483498` | 对应状态机、PR link、headline、needs input/completed 等 UI |
| 后台运行参数 | `run_in_background`：`108385717`, `108443472`, `111033209`, `111062323`, `111068812` | 对应子代理默认后台化与后台 session 语义 |
| daemon / lock | `daemon.lock`：`86447112`, `148654267`, `236566706`, `238612025`, `241755958`; `retarget`：`193697075`, `229121346`; `stale` 多处 | 对应 stale lock、respawn race、旧构建接管、SendMessage retarget |
| partial / incomplete | `partial work`：`150306566`, `150317672`, `150334669`, `240529282`, `240529698`, `240529926`, `240531058`, `240534454`; `incomplete response`：`119184318`, `119220640`, `233511549`, `233516269` | 对应子代理/API 流式中断不再假成功 |
| usage limit | `106116944`, `106122878`, `106123469`, `106123568`, `106129152`, `106255738`, `106280223`, `115421560` | 对应子代理 usage-limit 错误向父代理上报 |
| 后台 shell 内存回收 | `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP`：`89934968`, `223618514`, `230587582`; `low memory`：`157133596`, `157133828`, `237516554`, `241751950`, `241752134`, `241752516`, `241756973` | 对应 2.1.193/199 资源压力提示与 reaper |
| updater/download 内存 | `download`：`59005905`, `59018867`, `59028891`, `59036320`, `59108967`, `59109001`, `59109211`, `59109239` | 对应 2.1.205 流式下载省 400MB |
| MCP idle timeout | `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`：`89933404`, `124290756`, `223617286`, `234516480`, `234540413` | 对应 2.1.187 远程 MCP 工具挂起超时 |
| MCP result size | `maxResultSizeChars`：`102806232`, `212102354`, `227846446`, `227936224`, `228348502` | 对应 2.1.100 `_meta["anthropic/maxResultSizeChars"]` |
| MCP auth refresh | `headersHelper`：`96543520`, `105895082`; `401/403`：`234570694` | 对应 2.1.191/193 运行时认证过期自动续期 |
| `no-browser` auth | `142415210`, `207132018`, `232505631`, `232505722`, `237653451` | 对应 CLI MCP auth / SSH/headless 体验 |
| Auto Mode 全 shell 分类 | `classifyAllShell`：`93760608`, `223889763`, `223980013`; `CLAUDE_CODE_AUTO_MODE_CLASSIFY_EDITS`：`111743880`, `230857286` | 对应 2.1.191 安全分类覆盖面扩大 |
| 后台通知/权限可信来源 | `PermissionRequest`：`86015374`, `86480081`, `86919263`, `86920245`, `86920443`; `PermissionDenied`：`58795968`, `90042927`, `106985912`, `122455692`, `125936712` | 对应 2.1.205 “未发生人工输入”与 transcript 审批边界 |
| streaming watchdog / fallback | `tengu_streaming_watchdog_retry`：`124713064`, `234638789`, `234642363`; `cli_nonstreaming_fallback_started`：`124715496`, `234644392`, `234646497`; `model_refusal_fallback`：`113136800`, `116226840`, `118161912` | 对应流式无响应、非流式降级与拒绝 fallback |
| terminal sequence / synchronized update | `terminalSequence`：`125999296`, `126006557`, `126226580`, `227841332`, `234796228`; `SYNCHRONIZED_UPDATE`：`98452208`, `226311356`, `226311392`, `226311424`, `226528319` | 对应 no-flicker、tmux 3.4+ 同步输出与终端控制字符过滤 |
| workflow / orchestrator 兼容锚点 | `workflow.run_id`：`94415376`, `224992509`; `workflow.name`：`94415440`, `224992563`; `workflowSize`：`125418752`, `128315880`, `129271168`, `129278848`; `ultracode`：`93432564`, `93443535`, `93471904`; `orchestrator`：`116583528`, `122361409`, `156172624`, `207389800` | CC 侧仍有 workflow/ultracode/orchestrator 字符串；zy-code 落地映射到 orchestrator/WorkflowTool runtime，不按命名硬搬 |

---

## 附录：CC v2.1.205 完整环境变量清单分类

### 已对齐 zy-code 的环境变量（25+）
```
ZY_CODE_AGENT_LIST_IN_MESSAGES    ZY_CODE_AUTO_COMPACT_WINDOW
ZY_CODE_AUTO_MODE_MODEL           ZY_CODE_BRIEF / ZY_CODE_BRIEF_UPLOAD
ZY_CODE_BUBBLEWRAP                ZY_CODE_COMMIT_LOG
ZY_CODE_DISABLE_PRECOMPACT_SKIP   ZY_CODE_EAGER_FLUSH
ZY_CODE_IDE_HOST_OVERRIDE         ZY_CODE_IDLE_THRESHOLD_MINUTES
ZY_CODE_IDLE_TOKEN_THRESHOLD      ZY_CODE_INVESTIGATE_FIRST
ZY_CODE_IS_COWORK                 ZY_CODE_LOOP_PERSISTENT
ZY_CODE_MAX_OUTPUT_TOKENS         ZY_CODE_MAX_RETRIES
ZY_CODE_MAX_TOOL_USE_CONCURRENCY  ZY_CODE_NO_FLICKER
ZY_CODE_OVERRIDE_DATE             ZY_CODE_PERFETTO_TRACE
ZY_CODE_RESUME_INTERRUPTED_TURN   ZY_CODE_SCROLL_SPEED
ZY_CODE_SSE_PORT                  ZY_CODE_STALL_TIMEOUT_MS_FOR_TESTING
ZY_CODE_SUBAGENT_MODEL            ZY_CODE_SYNTAX_HIGHLIGHT
ZY_CODE_TERMINAL_RECORDING        
```

### 关键缺失与待核对（按合并后口径）
见第十、十一节。核心缺口不再按旧基线附录逐项照搬，而按可落地主题归并：
- 权限绕过与凭证隔离：`sandbox.credentials`、`Tool(param:value)`、bypass/auto mode 全 shell 分类、破坏性 git/IaC。
- Refusal / streaming / non-streaming fallback：模型拒绝、流式 watchdog、partial output、incomplete 标记。
- MCP 安全可靠性：result size、idle timeout、auth refresh 并发锁、secret redaction、`--no-browser`、tools/list 分页。
- Hooks 完整性：`PreCompact`、`PostToolUse` 全工具改写、`MessageDisplay`、权限 hooks、`terminalSequence`、effort context。
- 后台会话与 daemon：stop/respawn、pin/resume、agent view 配置链、roster/lock/PTY attach。
- Session resume / terminal / enterprise P2 项：高级 resume 参数、SGR mouse、synchronized update、Perforce、OTEL、plugin zip cache。

---

## 附录：v2.1.205 关键注册事件偏移

| 事件 | 偏移量 |
|------|--------|
| `ConfigChange` | `106986528` |
| `subagent_depth_cap` | `210124128`, `233787825` |
| `subagent_nested_teammate` | `210124560`, `233788189` |
| `subagent_cache_evict` | `124549718`, `234599728` |
| `fork_subagent` | `86130942`, `227968719` |
| `classifyAllShell` | `93760608`, `223889763` |
| `workflowSize` | `128315880`~`240599638`（多处） |
| `/doctor` | `114719690`（3 处） |
| `mcpLogin` / `mcpLogout` | `90073648` / `90073616` |
| `respondToBash` | `93470304` |
| `DISABLE_DOCTOR_COMMAND` | `89918120` |
| `PROACTIVE` | `89919836` |
| `DISABLE_AUTO_MEMORY` | `89923436` |
| `CLAUDE_CODE_VERSION` | `2.1.205`（二进制内嵌） |
