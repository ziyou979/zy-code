# ZY Code 配置参考

本文件汇总 ZY Code 的全部配置面:配置文件位置与优先级、`settings.json` 配置项、`model-capabilities.json`、环境变量,以及 beta header 的配置与数据流。

> 配置项的权威定义见 `src/utils/settings/types.ts`(`SettingsSchema`)、`src/utils/settings/localModelCapabilities.ts`、`src/services/model/providerRegistry.ts`。本文为人读摘要,字段以代码为准。

## 目录

- [1. 配置文件位置与优先级](#1-配置文件位置与优先级)
- [2. settings.json 配置项](#2-settingsjson-配置项)
- [3. model-capabilities.json](#3-model-capabilitiesjson)
- [4. 环境变量](#4-环境变量)
- [5. Beta header:配置与数据流](#5-beta-header配置与数据流)
- [6. Provider 注册表](#6-provider-注册表)

---

## 1. 配置文件位置与优先级

配置根目录由 `getZyConfigHomeDir()` 决定:`process.env.ZY_CONFIG_DIR ?? ~/.zy`。

### settings 来源与合并优先级(低 → 高)

```
plugin 设置  <  user(~/.zy/settings.json)  <  project(.zy/settings.json)
  <  local(.zy/settings.local.json)  <  --settings(CLI)  <  policy(企业托管)
```

| 来源 | 路径 | 说明 |
|---|---|---|
| user | `~/.zy/settings.json` | 用户全局 |
| project | `<项目>/.zy/settings.json` | 随 VCS 提交、团队共享 |
| local | `<项目>/.zy/settings.local.json` | 自动 gitignore、仅本地 |
| flag | `--settings <path>` | 运行时指定 |
| policy | `managed-settings.json`(平台相关)/ MDM / remote | 企业管理员,不可被用户覆盖 |

合并规则:深合并;**数组字段拼接去重**(非替换),标量后者覆盖前者。

### `~/.zy/` 下的其它文件/目录

| 路径 | 用途 |
|---|---|
| `~/.zy.json` 或 `~/.zy/.config.json` | 全局配置(onboarding 结果:provider / apiKey / baseUrl / model、user 级 mcpServers) |
| `~/.zy/model-capabilities.json` | 本地模型能力声明(见 §3) |
| `~/.zy/keybindings.json` | 自定义快捷键(目前受 feature gate 控制,外部默认用内置键位) |
| `~/.zy/AGENTS.md`、`~/.zy/rules/` | 用户级 memory / 指令 / 规则 |
| `~/.zy/memory/`、`~/.zy/agent-memory/` | 自动记忆 / agent 持久记忆 |
| `~/.zy/plans/`、`~/.zy/projects/`、`~/.zy/sessions/` | 计划文件 / 项目元数据 / 并发会话锁 |
| `~/.zy/tools/`、`~/.zy/uploads/`、`~/.zy/file-history/`、`~/.zy/history.jsonl` | 外部工具 / 上传 / 文件历史 / 命令历史 |

项目级(CWD 内):`.mcp.json`(project MCP)、`AGENTS.md`、`.zy/agent-memory/`、`.zy/agent-memory-local/`。

---

## 2. settings.json 配置项

> 完整 ~80+ 键见 `src/utils/settings/types.ts`。下面列常用项;企业/内部 feature-gated 项在末尾简述。

### 2.1 模型 / Provider

| Key | 类型 | 默认 | 用途 |
|---|---|---|---|
| `provider` | `'anthropic'\|'dashscope'\|'openrouter'\|'generic'\|'local'\|'zhipu'\|'kimi'` | — | API 提供商(覆盖 onboarding 与 env) |
| `apiKey` | string | — | 提供商 API key(覆盖 env) |
| `apiKeyHelper` | string | — | 输出认证值的脚本路径 |
| `model` | string | — | 覆盖默认模型 |
| `mainLoopModel` | `'advanced'\|'standard'\|'compact'` | `standard` | 主循环能力层级 |
| `models` | `Record<层级, 模型ID>` | — | 按 advanced/standard/compact 指定具体模型 |
| `modelOverrides` | `Record<anthropicId, providerId>` | — | 模型 ID 映射(如 Bedrock ARN) |
| `customModels` | `{alias,model,label?,description?}[]` | — | 自定义模型列表 |
| `advisorModel` | string | — | advisor 工具用的模型 |

### 2.2 认证 / 凭证

`awsCredentialExport` / `awsAuthRefresh` / `gcpAuthRefresh`(脚本路径)、`forceLoginMethod`(`zyai\|console`)、`forceLoginOrgUUID`、`xaaIdp`(`{issuer,clientId,callbackPort?}`,需 `ZY_CODE_ENABLE_XAA`)。

### 2.3 权限 permissions

| Key | 类型 | 用途 |
|---|---|---|
| `permissions.allow` / `.deny` / `.ask` | string[] | 权限规则(如 `Bash(git *)`、`Read(*.ts)`) |
| `permissions.defaultMode` | `acceptEdits\|bypassPermissions\|default\|dontAsk\|plan` | 默认权限模式 |
| `permissions.additionalDirectories` | string[] | 额外纳入权限范围的目录 |
| `permissions.disableBypassPermissionsMode` | `'disable'` | 禁用绕过权限 |

### 2.4 Hooks

| Key | 类型 | 用途 |
|---|---|---|
| `hooks` | `Record<HookEvent, HookMatcher[]>` | 工具/会话生命周期上挂自定义命令 |
| `disableAllHooks` | boolean | 禁用所有 hooks |
| `allowManagedHooksOnly` | boolean | 仅运行托管 hooks |
| `allowedHttpHookUrls` | string[] | HTTP hooks URL 白名单(支持 `*`) |

HookEvent:`PreToolUse`/`PostToolUse`/`UserPromptSubmit`/`SessionStart`/`SessionEnd`/`Stop`/`PreCompact`/`SubagentStop`/… HookCommand 5 型:`command`/`prompt`/`http`/`agent`/`mcp_tool`。

### 2.5 MCP 服务器

`enableAllProjectMcpServers`、`enabledMcpjsonServers` / `disabledMcpjsonServers`(`.mcp.json` 批准/拒绝名单)、`allowedMcpServers` / `deniedMcpServers`(企业白/黑名单,黑名单优先)、`allowManagedMcpServersOnly`。

### 2.6 沙箱 sandbox

`sandbox.enabled`、`sandbox.failIfUnavailable`、`sandbox.autoAllowBashIfSandboxed`、`sandbox.allowUnsandboxedCommands`、`sandbox.network.{allowedDomains,allowLocalBinding,httpProxyPort,…}`、`sandbox.filesystem.{allowWrite,denyWrite,denyRead,allowRead}`、`sandbox.excludedCommands`、`sandbox.ripgrep`。

### 2.7 UI / 显示

| Key | 类型 | 默认 | 用途 |
|---|---|---|---|
| `language` | string | — | 响应/听写/UI 语言(如 `Chinese`) |
| `outputStyle` | string | — | 助手输出风格 |
| `showThinkingSummaries` | boolean | `false` | transcript 显示思考摘要 |
| `builtInStatusBar.{enabled,modules}` | object | — | 底部状态栏(模块:directory/model/context/tokens/cost/memory) |
| `spinnerTipsEnabled` / `spinnerTipsOverride` | — | — | spinner 提示 |
| `prefersReducedMotion` / `syntaxHighlightingDisabled` | boolean | — | 无障碍 / 关语法高亮 |
| `terminalTitleFromRename` | boolean | `true` | `/rename` 改终端标题 |

### 2.8 思考 / Effort / Token

| Key | 类型 | 默认 | 用途 |
|---|---|---|---|
| `alwaysThinkingEnabled` | boolean | `true` | false 禁用 thinking |
| `effortLevel` | `minimal\|low\|medium\|high`(内部含 `max`) | — | 持久 effort 档 |
| `defaultMaxOutputTokenRatio` | number(0-1) | `0.75` | 默认最大输出 token 比率 |
| `minDefaultMaxOutputTokens` | int | `8000` | 默认最大输出 token 上限 |
| `promptCacheTTL` | `5m\|1h` | `5m` | prompt cache TTL |

### 2.9 Git / 归属

`attribution.{commit,pr}`(自定义提交/PR 归属文本,空串隐藏)、`includeCoAuthoredBy`(已弃用,用 `attribution`)、`includeGitInstructions`(默认 true)。

### 2.10 Worktree

`worktree.symlinkDirectories`(symlink 进 worktree 的目录,如 node_modules)、`worktree.sparsePaths`、`worktree.bgIsolation`(`none\|full`,默认 full)。

### 2.11 文件 / 清理 / 内存

| Key | 类型 | 默认 | 用途 |
|---|---|---|---|
| `respectGitignore` | boolean | `true` | 文件选择器遵守 .gitignore |
| `cleanupPeriodDays` | int | `30` | 聊天记录保留天数(0=不持久化) |
| `plansDirectory` | string | `~/.zy/plans/` | 计划文件目录 |
| `autoMemoryEnabled` / `autoMemoryDirectory` / `autoDreamEnabled` | — | — | 自动记忆 |
| `agentsMdExcludes` | string[] | — | 排除加载的 AGENTS.md(glob) |

### 2.12 插件 / 市场

`enabledPlugins`(`"plugin@marketplace": true`)、`extraKnownMarketplaces`、`pluginConfigs`、`strictPluginOnlyCustomization`、企业级 `strictKnownMarketplaces` / `blockedMarketplaces`。

### 2.13 其它行为开关

`promptSuggestionEnabled`(默认 true)、`defaultShell`(`bash\|powershell`)、`agent`(主线程 agent 名)、`companyAnnouncements`、`feedbackSurveyRate`(0-1)、`skipWebFetchPreflight`、`webSearch.region`、`remote.defaultEnvironmentId`、`sshConfigs`、`autoUpdatesChannel`(`latest\|stable`)、`minimumVersion`、`channelsEnabled`。

**Feature-gated(特定构建/flag 才出现)**:`classifierPermissionsEnabled`、`minSleepDurationMs`/`maxSleepDurationMs`(PROACTIVE/KAIROS)、`voiceEnabled`(VOICE_MODE)、`assistant`/`assistantName`(KAIROS)、`autoMode.*`/`useAutoModeDuringPlan`(TRANSCRIPT_CLASSIFIER)、`disableSkillShellExecution`。

---

## 3. model-capabilities.json

路径 `~/.zy/model-capabilities.json`(示例见仓库根 `model-capabilities.example.json`)。按 `pattern` 子串匹配 model id,声明该模型的能力、token 上限、定价、以及附加 beta。

```jsonc
{
  "models": [
    {
      "pattern": "claude-sonnet-4",            // 必填:大小写不敏感子串匹配 model id
      "capabilities": [                         // 必填:能力列表
        "thinking", "adaptive_thinking", "structured_outputs",
        "context_management", "interleaved_thinking", "prompt_caching",
        "web_search", "advisor", "auto_mode"
      ],
      "effortLevels": ["low","medium","high"],  // 可选:effort 档位(省略=不支持设 effort)
      "betaHeaders": ["context-management-2025-06-27"], // 可选:附加 anthropic-beta(见 §5)
      "contextWindow": "1m",                    // 可选:上下文窗口(数字或 "200k"/"1m")
      "maxInputTokens": "1m",                   // 可选
      "maxOutputTokens": "64k",                 // 可选
      "maxThinkingTokens": "32k",               // 可选(默认 maxOutputTokens-1)
      "costs": { "inputTokens": 9, "outputTokens": 54,
                 "promptCacheWriteTokens": 11.25, "promptCacheReadTokens": 0.9 }
    }
  ]
}
```

- **token 字符串**:`k`=1024、`m`=1024²。`"200k"`=204800、`"1m"`=1048576。
- **`costs` 两种格式**:固定单价(`inputTokens`/`outputTokens`/`promptCache*`/`webSearchRequests`,单位 元/百万 token),或阶梯 `tiers: [{upTo,inputTokens,outputTokens,…}]`。
- **优先级**:这里的配置高于 provider 默认(effort 档位、context 窗口等)。

---

## 4. 环境变量

> 完整散落在 `src/` 各处;下面按功能分组列常用项。布尔类一般取 `1`/`true`。

### 4.1 Provider 激活与 base URL

| 变量 | 用途 |
|---|---|
| `ZY_CODE_USE_DASHSCOPE` / `_OPENAI` / `_ZHIPU` / `_KIMI` / `_OPENROUTER` / `_GENERIC` | 激活对应 provider |
| `DASHSCOPE_BASE_URL` / `ZHIPU_BASE_URL` / `KIMI_BASE_URL` | 覆盖对应 base URL |
| `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` / `LLM_BASE_URL` | Anthropic / OpenAI / 通用 base URL(回退链) |
| `ZY_CODE_MODEL` / `ZY_CODE_SUBAGENT_MODEL` / `ZY_CODE_AUTO_MODE_MODEL` | 主循环 / 子 agent / 自动模式分类器 模型 |
| `ANTHROPIC_SMALL_FAST_MODEL` | 小快模型 ID 覆盖 |

provider 解析优先级:`settings.provider` > onboarding configuredProvider > 激活 env var > 默认 `anthropic`。

### 4.2 API / 认证 / 网络

| 变量 | 用途 |
|---|---|
| `ZY_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `LLM_API_KEY` | API key / Bearer token / 通用 key |
| `ANTHROPIC_UNIX_SOCKET` | 经 UNIX socket 连接 |
| `ZY_CODE_CUSTOM_HEADERS`(JSON)/ `ZY_CODE_EXTRA_BODY`(JSON)/ `ZY_CODE_EXTRA_METADATA`(JSON) | 注入自定义 header / body / metadata |
| `API_TIMEOUT_MS`(默认 600000)/ `ZY_CODE_MAX_RETRIES` | 超时 / 重试 |
| `ZY_CODE_CLIENT_CERT` / `_KEY` / `_KEY_PASSPHRASE` | mTLS |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` / `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` | 网络代理 / CA |

### 4.3 Beta / tool-search

| 变量 | 取值 | 用途 |
|---|---|---|
| `ANTHROPIC_BETAS` | 逗号分隔 | 全局追加 beta header(显式 opt-in,所有请求) |
| `ZY_CODE_DISABLE_EXPERIMENTAL_BETAS` | `1` | 关掉一切实验 beta(含 tool-search) |
| `ENABLE_TOOL_SEARCH` | `true`/`false`/`auto`/`auto:N`/`0`/`100` | tool-search 模式;`true` 还能强穿 Vertex/代理 gate |
| `USE_CONNECTOR_TEXT_SUMMARIZATION` | `1`/`0`/不设 | 连接文本摘要(内部) |

### 4.4 思考 / effort / 输出

| 变量 | 用途 |
|---|---|
| `MAX_THINKING_TOKENS` | 最大思考 token(>0 启用思考) |
| `ZY_CODE_DISABLE_THINKING` / `ZY_CODE_DISABLE_ADAPTIVE_THINKING` | 禁用思考 / 自适应思考 |
| `ZY_CODE_EFFORT_LEVEL` | `low\|medium\|high\|max\|unset\|auto` 覆盖 effort |
| `ZY_CODE_MAX_OUTPUT_TOKENS` | 覆盖最大输出 token |
| `DISABLE_COMPACT` / `DISABLE_AUTO_COMPACT` / `AUTOCOMPACT_PCT_OVERRIDE` | compact 控制 |
| `DISABLE_PROMPT_CACHING`(及 `_HAIKU`/`_SONNET`/`_OPUS`) | 禁用 prompt 缓存 |

### 4.5 行为 / 调试 / 遥测

| 变量 | 用途 |
|---|---|
| `ZY_CONFIG_DIR` | 配置目录(默认 `~/.zy`) |
| `ZY_CODE_SIMPLE`(= `--bare`) | 精简模式,跳过 hooks/LSP/插件/凭证 |
| `ZY_CODE_DISABLE_CLAUDE_MDS` / `_AUTO_MEMORY` / `_GIT_INSTRUCTIONS` / `_BACKGROUND_TASKS` | 关闭对应特性 |
| `ZY_CODE_UI_LANG` / `ZY_CODE_SHELL` / `ZY_CODE_VCS`(`git\|perforce`) | UI 语言 / shell / VCS |
| `BASH_MAX_OUTPUT_LENGTH` / `TASK_MAX_OUTPUT_LENGTH` | 输出长度上限 |
| `DISABLE_TELEMETRY` / `ZY_CODE_DISABLE_NONESSENTIAL_TRAFFIC` / `DISABLE_ERROR_REPORTING` | 隐私 / 遥测 |
| `CLAUDE_DEBUG` / `ZY_CODE_DEBUG_LOG_LEVEL` / `ZY_CODE_DEBUG_LOGS_DIR` | 调试 |

### 4.6 Bridge / CCR / 会话

`ZY_BRIDGE_USE_CCR`(CCR v2 传输)、`ZY_CODE_CCR_MIRROR`、`ZY_CODE_REMOTE` / `_REMOTE_SESSION_ID` / `_REMOTE_MEMORY_DIR`、`ZY_CODE_ENVIRONMENT_KIND`(如 `bridge`)/ `_ENVIRONMENT_RUNNER_VERSION`、`ZY_CODE_SESSION_*`、`ZY_CODE_ENTRYPOINT`(`cli\|sdk-ts\|sdk-py\|…`)。

### 4.7 计划模式 / 高级功能

`ZY_CODE_PLAN_MODE_V2_AGENT_COUNT` / `_EXPLORE_AGENT_COUNT`(plan 并发数,1–10)、`ZY_CODE_PLAN_MODE_INTERVIEW_PHASE`、`ZY_CODE_ENABLE_TASKS`、`ZY_CODE_PROACTIVE`、`ZY_CODE_ENABLE_CFC`(Claude-in-Chrome)、`ZY_CODE_COORDINATOR_MODE` / `_EXPERIMENTAL_AGENT_TEAMS`。

---

## 5. Beta header:配置与数据流

ZY 是第三方 harness,`anthropic-beta` header 按「**模型是不是真 Claude**」+「**端点接不接受**」两维决定,而非按 provider 一刀切。

### 怎么配

1. **按模型加任意 beta** —— `model-capabilities.json` 的 `betaHeaders`(显式 opt-in,无条件透传该模型):
   ```json
   { "pattern": "claude-sonnet-4", "betaHeaders": ["some-beta-2026-xx"] }
   ```
2. **全局加** —— `ANTHROPIC_BETAS=a,b,c`(所有请求)。
3. **关掉实验 beta** —— `ZY_CODE_DISABLE_EXPERIMENTAL_BETAS=1`。
4. **tool-search** —— `ENABLE_TOOL_SEARCH=true|auto|auto:N`;Vertex 默认关(端点不接受),用 `true` 强开。

### 内置 beta 的触发(自动,仅对 Claude 模型)

| beta | 触发条件 | 相关配置 |
|---|---|---|
| `context-1m-2025-08-07` | model 是 Claude && 上下文窗口 ≥1M | `contextWindow: "1m"` |
| `context-management-2025-06-27` | Claude && 用 thinking && 模型声明 `context_management` | `capabilities` 含 `context_management` |
| effort(`effort-2025-11-24`) | Claude && 支持 effort && 设了 effort 值 | `effortLevels` |
| tool-search(`advanced-tool-use` / `tool-search-tool`) | Claude && 支持 tool_reference(非 Haiku)&& 非 Vertex(除非强开)&& 有可延迟工具 | `ENABLE_TOOL_SEARCH` |
| strict(`structured-outputs`) | statsig `zy_strict_tools` && 模型声明 `structured_outputs` | `capabilities` 含 `structured_outputs` |

> 「模型是不是 Claude」按 model id 判断(`claude`/`sonnet`/`opus`/`haiku`,兼容 `anthropic/`、`anthropic.` 前缀),所以 **openrouter 上的 `anthropic/claude-*` 会自动拿到 betas**;qwen/glm 等不会。`betaHeaders`(用户显式配)不受此门控。

### 数据流(参数如何进 header)

```
model-capabilities(betaHeaders/contextWindow/capabilities) + env(ANTHROPIC_BETAS/…) + 代码 conditional
   │  getAllModelBetas(model) / getMergedBetas + 运行时(effort / tool-search / advisor / AFK)
   ▼
betas: string[]（去重）
   ▼
buildAnthropicCreateParams → out.betas = betas
   ▼
Anthropic SDK client.beta.messages.create({...params, betas})
   ▼
SDK 把 betas 摘出 body → HTTP 头: anthropic-beta: a,b,c
```

**Bedrock 例外**:betas 不走 header,改塞进请求体 `extraBodyParams.anthropic_beta`。

---

## 6. Provider 注册表

定义于 `src/services/model/providerRegistry.ts`。`activationEnvVar` 为空者通过 onboarding / `settings.provider` 选择。

| id | 激活方式 | 端点 | 格式 | onboarding |
|---|---|---|---|---|
| dashscope | `ZY_CODE_USE_DASHSCOPE` | env-or-default | anthropic+openai | ✓ |
| openai | `ZY_CODE_USE_OPENAI` | hardcoded | openai | ✓ |
| zhipu | `ZY_CODE_USE_ZHIPU` | env-or-default | anthropic+openai | ✓ |
| kimi | `ZY_CODE_USE_KIMI` | env-or-default | anthropic+openai | ✓ |
| openrouter | `ZY_CODE_USE_OPENROUTER` | hardcoded | anthropic | ✓ |
| generic | `ZY_CODE_USE_GENERIC` | custom | anthropic+openai | ✓ |
| deepseek / siliconflow / volcark / tencentlke / minimax / baiduqianfan / huaweicloud / together / groq / fireworks / perplexity | onboarding | preconfigured | 见注册表 | ✓ |
| ollama / lmstudio / llamacpp / nvidia-nim | onboarding(自填 base URL) | custom | openai | ✓ |
| anthropic | 默认 | hardcoded | anthropic | ✓ |
| bedrock / vertex / foundry | 基础设施 | hardcoded | anthropic | ✗ |

**端点类型**:`hardcoded`(URL 写死)、`env-or-default`(读 env 否则默认)、`preconfigured`(onboarding 存 configuredBaseUrl)、`custom`(用户自填)。

onboarding 完成后写入全局配置(`~/.zy.json`):`configuredProvider` / `configuredApiKey` / `configuredBaseUrl` / `configuredModel`。
