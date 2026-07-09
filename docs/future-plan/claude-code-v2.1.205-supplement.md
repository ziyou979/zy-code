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
| `CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS` | `89918600` | 工作流 Agent 数量警告阈值 | ❌ 缺失 |
| `CLAUDE_CODE_WORKFLOW_SIZE_WARNING_TOKENS` | `89918656` | 工作流 Token 用量警告阈值 | ❌ 缺失 |
| `CLAUDE_CODE_DISABLE_WORKFLOWS` | — | 禁用工作流系统 | ❌ 缺失 |

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
| `dynamicWorkflowSize` | 2.1.202 | 动态工作流大小（small/medium/large） | ❌ 缺失 | 低 |
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
| 2.1.202 | `dynamicWorkflowSize` 与 workflow OTel 属性 | `workflowSize`：`128315880`~`240599638` | ❌ 缺失 | P2；设置只是 guideline，不做硬 cap |
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

### 7.3 动态工作流大小
**文件**：`src/tools/WorkflowTool/`
- ❌ zy-code 无 `dynamicWorkflowSize` 设置
- 需在 WorkflowTool 配置中添加 advisory guideline，不应实现为硬性 agent cap

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
| `dynamicWorkflowSize` + workflow OTel | advisory guideline + `workflow.run_id/name` | 低 |
| `/dataviz` | 数据可视化技能 | 低 |
| `CLAUDE_CODE_WORKFLOW_SIZE_WARNING_*` | 工作流规模警告阈值 | 低 |
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

### Phase 3（长期，4-6 周）：工作流与体验项

7. **Login 即将过期提示**（P1）
   - 复用 bridge OAuth refresh/token expiry 信息，在 TUI 状态栏或通知层给出提前警告
   - 避免重复刷新失败造成循环提示

8. **动态工作流大小与 OTel**（P2）
   - 在 WorkflowTool 中添加 `dynamicWorkflowSize` 设置
   - small/medium/large 只作为 agent 数/上下文规模建议，不作为硬性拦截
   - 工作流 spawn agent 时附加 `workflow.run_id`、`workflow.name` 遥测属性

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
| 2.1.154 | Opus 4.8；动态工作流多 Agent 编排；后台会话大修 | ⚠️ 动态工作流缺失 | P2 |
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
| 已有或有等价实现 | `/ultrareview`/`/code-review`、`/security-review`、`/release-notes`、`/insights`、`/tasks`、`/powerup`、`/voice`、`/plan`、`/goal`、`/doctor`、ToolSearch、NotebookEdit、TodoWrite |
| 仍需核对/补齐 | `/dataviz`、`project purge`、`/reload-skills`、`/team-onboarding`、`/recap`、`/stop`、`/scroll-speed`、`/fast`、`/usage-credits`、`/extra-usage`、NotebookRead、Cd 工具、PushNotification、RemoteTrigger |
| 不建议单独追的项 | 与 CC 内部运营或 Claude.ai 平台强绑定的 stickers/radio/teleport/desktop/mobile 等，除非 zy-code 产品目标明确需要 |

### 11.6 最终优先级合并

| 优先级 | 合并后主题 | 说明 |
|--------|------------|------|
| P0 | 权限绕过与凭证隔离 | Bash/PowerShell/env assignment、`Tool(param:value)`、bypassPermissions、`sandbox.credentials`、破坏性 git/IaC、Auto Mode 全 shell 分类 |
| P0 | 流式/模型失败恢复 | refusal fallback、streaming watchdog retry、non-streaming fallback、partial output、incomplete 标记 |
| P0/P1 | MCP 安全可靠性 | result size、timeout、auth refresh 并发锁、secret redaction、tools/list 分页、`--no-browser` |
| P1 | Hooks 完整性 | `PreCompact` 阻断、`PostToolUse` 全工具改写、`MessageDisplay`、权限 hooks、terminalSequence、effort context |
| P1 | 后台会话/agent view | stop/respawn、pin/resume、配置链、JSON、权限转发 |
| P1/P2 | 设置与命令体验 | safe-mode、availableModels enforcement、footer links、wheel acceleration、project purge、reload-skills |
| P2/P3 | daemon 完整子系统与企业基础设施 | daemon lock/roster/PTY attach、Perforce、OTEL、plugin zip cache、container id |

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
