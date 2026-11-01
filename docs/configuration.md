# ZY Code 配置参考

本文件汇总 ZY Code 的全部配置面:配置文件位置与优先级、`settings.json` 配置项、`auth.json`、`model-capabilities.json`、环境变量,以及 beta header 的配置与数据流。

> 配置项的权威定义见 `src/services/settings/types.ts`（`SettingsSchema`）、`src/services/settings/localModelCapabilities.ts`、`src/services/model/providerRegistry.ts`。本文为人读摘要，字段以代码为准。

## 目录

- [1. 配置文件位置与优先级](#1-配置文件位置与优先级)
- [2. settings.json 配置项](#2-settingsjson-配置项)
- [3. auth.json](#3-authjson)
- [4. model-capabilities.json](#4-model-capabilitiesjson)
- [5. 环境变量](#5-环境变量)
- [6. Beta header:配置与数据流](#6-beta-header配置与数据流)
- [7. Provider 注册表](#7-provider-注册表)

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
| `~/.zy.json` 或 `~/.zy/.config.json` | 全局 CLI 状态（主题、通知、一次性 flag 等）；**不含** API key / provider（见 settings + auth） |
| `~/.zy/auth.json` | 用户级认证配置(API key / apiKeyHelper,见 §3) |
| `~/.zy/model-capabilities.json` + `~/.zy/model-capabilities/*.json(.c)` | 本地模型能力声明,支持单文件或目录分片(见 §4) |
| `~/.zy/model-capabilities/discovered-model-capabilities.json` | 动态目录发现及界面覆盖的模型能力状态 |
| `~/.zy/model-capabilities/auto-mode-qualifications.json` | Auto Mode 评测和直接授权记录 |
| `~/.zy/google-adc/` | Vertex 浏览器授权生成的独立 ADC 凭证目录 |
| `~/.zy/keybindings.json` | 自定义快捷键(目前受 feature gate 控制,外部默认用内置键位) |
| `~/.zy/AGENTS.md`、`~/.zy/rules/` | 用户级 memory / 指令 / 规则 |
| `~/.zy/memory/`、`~/.zy/agent-memory/` | 自动记忆 / agent 持久记忆 |
| `~/.zy/plans/`、`~/.zy/projects/`、`~/.zy/sessions/` | 计划文件 / 项目元数据 / 并发会话锁 |
| `~/.zy/tools/`、`~/.zy/uploads/`、`~/.zy/file-history/`、`~/.zy/history.jsonl` | 外部工具 / 上传 / 文件历史 / 命令历史 |

项目级(CWD 内):`.mcp.json`(project MCP)、`AGENTS.md`、`.zy/agent-memory/`、`.zy/agent-memory-local/`。

---

## 2. settings.json 配置项

> 完整 ~80+ 键见 `src/services/settings/types.ts`。下面列常用项;企业/内部 feature-gated 项在末尾简述。

### 2.1 模型 / Provider

首次设置、登录后的模型选择和 `/settings` 档位配置均使用连接的实时模型目录。每次打开选择器或选择「刷新模型列表」都会重新查询，不使用代码内置的推荐模型和进程级目录缓存。新发布或下线的模型随平台目录变化；平台不提供列表、认证失败或网络异常时会显示原因，仍可通过「自定义模型」输入准确的模型 ID。`model-capabilities` 只声明能力、限制和价格，不会添加菜单选项。

| Key | 类型 | 默认 | 用途 |
|---|---|---|---|
| `provider` | `'anthropic'\|'dashscope'\|'xai'\|…` | — | 旧版兼容字段；新配置在模型引用中填写 `auth.json` 连接 id |
| `baseUrl` | string | — | 旧版兼容字段；新配置应写入 `auth.json` 命名连接 |
| `model` | `string \| {provider?,model}` | — | 覆盖默认模型；对象格式可指定该模型使用的 provider |
| `mainLoopModel` | `'advanced'\|'standard'\|'compact'` | `standard` | 主循环能力层级 |
| `models` | `Record<层级, 模型ID \| {provider?,model} \| 候选数组>` | — | 按 advanced/standard/compact 指定模型；可为有序候选列表实现多 auth 混用 |
| `modelFailover` | `{enabled?, maxConsecutiveFailures?}` | 见下 | 候选列表失效切换策略 |
| `modelOverrides` | `Record<anthropicId, providerId>` | — | 模型 ID 映射(如 Bedrock ARN) |
| `customModels` | `{alias,model,provider?,label?,description?}[]` | — | 自定义模型列表；`provider` 可为该别名绑定 provider |
| `advisorModel` | string | — | advisor 工具用的模型 |
| `modelCapabilityCatalogUrl` | `string \| null` | `https://models.dev/api.json` | 动态模型能力目录；设为 `null` 关闭公共查询 |

模型引用支持：

1. **字符串**模型 ID → 当前作用域 provider  
2. **对象** `{ provider, model }` → `provider` 优先引用 `auth.json` 命名连接，也兼容注册表 provider id
3. **有序数组**（多 auth）：`[{ provider, model }, ...]`，下标越小优先级越高  

```jsonc
{
  "mainLoopModel": "standard",
  "models": {
    // 多 auth：先 xAI 订阅，失败后切百炼，再切 OpenCode Go
    "standard": [
      { "provider": "grok-subscription", "model": "grok-4.3" },
      { "provider": "qwen-work", "model": "qwen3.6-plus" },
      { "provider": "opencode-go", "model": "opencode-go/kimi-k2.7-code" }
    ],
    "advanced": { "provider": "xai", "model": "grok-4.3" },
    "compact": "local-fast-model"
  },
  "modelFailover": {
    "enabled": true,
    "maxConsecutiveFailures": 2
  },
  "customModels": [
    {
      "alias": "go-kimi",
      "provider": "opencode-go",
      "model": "opencode-go/kimi-k2.7-code"
    }
  ]
}
```

**多 auth 失效切换（`modelFailover`）**

- 同候选内仍走 `withRetry`（401 刷新、429 退避）。  
- 当认证失败（刷新后仍 401/403）或 **限流/额度耗尽** 连续达到 `maxConsecutiveFailures`（默认 2）时，自动切到数组下一项。  
- 切换后写入 `~/.zy/model-chain-state.json` **跨会话粘住**；配置重排或增加候选时按 `provider + model + authProfile` 保留选择，直到再次使用 `/model` 或该候选被移除。  
- 第一期 **不**因 529/5xx 自动粘走（CLI `--fallback-model` 仍处理过载）。  
- 凭证：各 `provider` 对应 `auth.json` 条目或匹配的 OAuth；OAuth token 仅用于其 `apiProvider` 匹配的通道。

运行时会先把模型引用中的连接 id 解析为底层 provider，再按连接 id 读取 `auth.json` 的认证、URL 和协议；旧 `settings.providers.<id>` 覆盖项只作为迁移回退。provider 注册表默认值与 `model-capabilities.json` 的 `providerOverrides` 仍按底层 provider 生效。

### 2.2 认证 / 凭证

`awsCredentialExport` / `awsAuthRefresh` / `gcpAuthRefresh`(脚本路径)、`forceLoginMethod`(`zyai\|console`)、`forceLoginOrgUUID`、`xaaIdp`(`{issuer,clientId,callbackPort?}`,需 `ZY_CODE_ENABLE_XAA`)。

### 2.3 权限 permissions

| Key | 类型 | 用途 |
|---|---|---|
| `permissions.allow` / `.deny` / `.ask` | string[] | 权限规则(如 `Bash(git *)`、`Read(*.ts)`) |
| `permissions.defaultMode` | `acceptEdits\|auto\|bypassPermissions\|default\|dontAsk\|plan` | 默认权限模式；`auto` 仍需通过资格和用户授权门控 |
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
| `builtInStatusBar.{enabled,modules}` | object | — | 底部状态栏(模块:directory/model/context/tokens/cache/speed/turns/cost/memory)。模块级选项:`pathMode`(directory:`name`项目名/`full`全路径,默认`name`)、`ttftSymbol`(speed:首token前缀符号,默认空不显示,「首token」文案已自解释)。推荐用 `/statusline` 配置,持久化于 `~/.zy/statusline.json` |
| `spinnerTipsEnabled` / `spinnerTipsOverride` | — | — | spinner 提示 |
| `prefersReducedMotion` / `syntaxHighlightingDisabled` | boolean | — | 无障碍 / 关语法高亮 |
| `terminalTitleFromRename` | boolean | `true` | `/rename` 改终端标题 |

### 2.8 思考 / Effort / Token

| Key | 类型 | 默认 | 用途 |
|---|---|---|---|
| `alwaysThinkingEnabled` | boolean | `true` | false 禁用 thinking |
| `effortLevel` | `minimal\|low\|medium\|high`(内部含 `max`) | — | 持久 effort 档 |
| `defaultMaxOutputTokenRatio` | number(0-1) | `0.75` | 默认最大输出 token 比率 |
| `minDefaultMaxOutputTokens` | int | — | 默认最大输出 token 上限（未配置时不限制，直接使用模型能力） |
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

## 3. auth.json

路径 `~/.zy/auth.json`。该文件保存用户级命名 API 连接（provider、URL、协议与认证材料），与可提交的项目级 `settings.json` 分离。权限建议 `0600`。

```jsonc
{
  "generic-primary": {
    "provider": "generic",
    "baseUrl": "https://primary.example.com/v1",
    "apiFormat": "openai-chat",
    "apiKey": "sk-..."
  },
  "generic-backup": {
    "provider": "generic",
    "baseUrl": "https://backup.example.com/v1",
    "apiFormat": "anthropic",
    "apiKeyHelper": "C:\\Users\\you\\.zy\\get-dashscope-key.ps1"
  },
  // /login OAuth 与 API Key 一样归属于命名连接
  "xai": {
    "oauth": {
      "provider": "xai-oauth",
      "access": "...",
      "refresh": "...",
      "expires": 1710000000000,
      "tokenEndpoint": "https://auth.x.ai/oauth2/token"
    }
  },
  "openai": {
    "oauth": {
      "provider": "openai-codex",
      "access": "...",
      "refresh": "...",
      "expires": 1710000000000
    }
  }
}
```

- **扁平命名连接 map**:顶层 key 是可自由命名的连接 id；值可包含底层注册表 `provider`、`baseUrl`、`modelsUrl`、`apiFormat`、`apiKey` / `apiKeyHelper`、`credentialType` 与 `vertex`。省略 `provider` 时连接 id 本身按注册表 provider 解析，兼容旧格式。顶层 `deviceId` 是主机元数据保留键，不能作为连接 id。
- **apiFormat 配置入口**:连接的 `apiFormat` 是供应商维度的唯一用户配置入口（多协议 provider 在此选择格式）；模型维度走 `model-capabilities.json` 的模型级 `apiFormat`。settings 级 `apiFormat` 字段已移除，未指定时回落注册表 `formatEndpoints` 首位声明的格式。
- **连接内 OAuth**:`/login` 与 `zy auth login` 将凭证写到 API provider 同名连接的 `oauth` 字段；`provider` 标识具体登录/刷新实现。不再存在全局 `activeProvider`。
- **settings 分离**:`settings.json` 不再承载连接细节；`baseUrl` 只作为旧版迁移回退，`apiKey` / `apiKeyHelper` 只放在 `auth.json`。
- **模型路由**:`settings.json` 中通过 `{provider,model}` 或 `customModels[].provider` 的 `provider` 直接填写连接 id。运行时用连接的底层 `provider` 做协议分派，用连接 id 读取 URL 和凭证。
- **多个 generic**:为每个端点定义不同连接 id，即可在同一 tier 的候选数组或不同 tier 中自由组合；failover 会保留具体连接身份。
- **阶跃星辰**:使用独立 `stepfun` provider，默认 OpenAI Chat 端点为 `https://api.stepfun.com/v1`；选择 `anthropic` 时默认端点为 `https://api.stepfun.com`。例如 `auth.json` 中配置 `"stepfun": {"provider": "stepfun", "apiKey": "你的密钥"}`，模型引用使用 `{"provider": "stepfun", "model": "step-5-preview"}`。推理强度通过模型能力文件的 `thinking.effort.map` 映射到 `low` / `medium` / `high`；仅配置 `on` 时沿用服务端默认强度，不发送 `thinking` 开关。模型能力分片的 provider 选择器应包含 `stepfun`，需要保留连接的协议选择时不要固定模型级 `apiFormat`。接口依据：[官方 Flash 文档](https://platform.stepfun.com/docs/zh/guides/models/step-3.7-flash)。
- **蚂蚁百灵**:使用独立 `ant-ling` provider，默认 OpenAI Chat 端点为 `https://api.ant-ling.com/v1`；选择 `anthropic` 协议时默认端点为 `https://api.ant-ling.com/anthropic`。例如 `auth.json` 中配置 `"ant-ling": {"provider": "ant-ling", "apiKey": "你的密钥"}`，模型引用使用 `{"provider": "ant-ling", "model": "Ling-3.0-flash"}`。Ring 深度推理系列模型（如 `Ring-2.6-1T`）通过专用映射发送 `reasoning: { effort: 'high' | 'xhigh' }`；Ling 系列支持标准 `thinking: { type: 'enabled' }`。
- **apiKeyHelper**:ZY 会执行该命令并读取 stdout 作为 key。provider 级 helper 按命令独立缓存,避免多个 provider 串用同一个缓存值。
- **OAuth 与 API Key 同文件**:xAI、OpenAI Codex、GitHub Copilot 等 OAuth 连接可同时存在，请求按 settings 中的连接 id 精确选取。旧版根级 `oauth.activeProvider/credentials` 可读，下次 OAuth 写入时自动迁移。MCP OAuth 等仍可能使用 `~/.zy/.credentials.json` / Keychain，与 `/login` 无关。
- **ChatGPT 订阅直连**：启用 `ZY_CODE_ENABLE_CHATGPT_LOGIN=1`（或发布门控 `zy_chatgpt_subscription_login`）后，`/login` 可创建独立的 `openai-chatgpt` 命名连接。该连接底层为 `provider: "openai"`、`apiFormat: "openai-responses"`，与 OpenAI API key 和 Codex OAuth 连接隔离；模型引用使用 `{ "provider": "openai-chatgpt", "model": "..." }`。

---

### 3.1 Vertex AI Gemini（ADC）

Vertex Gemini 使用 Google 原生协议，不使用 Anthropic API key，也不使用 Gemini Code Assist 订阅令牌。首次设置或 `/login` →「第三方平台」→「Google Cloud Vertex AI（ADC）」提供同一个完整向导，不需要先手工填写 `auth.json`：

1. 新建连接或选择要修改的已有连接，查看项目计费、API 和权限要求。
2. 选择凭证来源：验证已有 ADC、指定 ADC/服务账号 JSON 文件，或通过浏览器授权 Google 账号。浏览器授权需要 [Google Cloud CLI](https://docs.cloud.google.com/sdk/docs/install-sdk)；未安装时向导提供官方安装链接、重新检测和完整 CLI 路径输入。使用已有凭证文件无需安装 CLI。
3. 浏览器中选择账号，允许 Google Cloud 的 `cloud-platform` 权限，返回 ZYCode。只有 `gcloud auth login` 的 CLI 账号登录不等于应用 ADC 授权。未弹出浏览器时可点击向导显示的授权链接，取消后可重试。
4. 使用刚验证的 ADC 读取可访问项目，按项目显示名和真实 ID 选择；没有列表权限时可手动输入项目 ID，也可打开 Google Cloud 控制台创建项目后刷新。不会擅自选择账号下的第一个项目。
5. 选择模型支持的区域；提供 `global`、`us`、`eu` 和其他区域输入。Gemini 4 使用前三者，其他模型的具体可用区域请以官方支持表为准。
6. 查看项目有效状态、结算、Vertex AI API、`aiplatform.endpoints.predict` 和 `serviceusage.services.use` 检查。明确缺少条件时阻止继续，提供对应的 API、结算、IAM 控制台链接和重新检查。无权读取的条件显示「未验证」，可明确选择继续；不会把未知状态伪装为已通过，也不会自动开启服务、绑定结算或授予权限。
7. 核对连接名、项目、区域和凭证文件位置，确认保存，再选择模型。模型选定后自动写入标准档位并更新当前会话；Vertex 官方目录暂不支持自动枚举时，使用「自定义模型」输入完整模型 ID 并核对能力配置。也可跳过模型选择以保留当前模型。

浏览器授权得到的 ADC 保存在 ZYCode 配置目录的 `google-adc/login-*/application_default_credentials.json`，向导会显示实际位置；已有文件保留原位置。`auth.json` 只保存路径和连接参数，不复制凭证内容。Vertex 请求的配额项目头使用该连接选择的项目，不修改全局 gcloud 配置或共享 ADC 文件的配额项目。连接保存之前取消向导不会写入连接或切换模型；已经完成浏览器授权的独立 ADC 文件会保留。

也可自行按 [Google 官方 ADC 说明](https://cloud.google.com/docs/authentication/set-up-adc-local-dev-environment)在本机获取凭证，再从向导选择已有文件：

```powershell
gcloud auth application-default login
gcloud auth application-default set-quota-project YOUR_PROJECT_ID
```

`auth.json` 中保存连接参数，访问令牌由 Google 官方认证库通过 ADC 自动刷新，不需要复制短期 token：

```json
{
  "vertex-gemini": {
    "provider": "vertex",
    "apiFormat": "google",
    "credentialType": "google-adc",
    "vertex": { "project": "YOUR_PROJECT_ID", "location": "global" }
  }
}
```

模型引用使用连接名，例如 `settings.json` 的 `models.standard` 为 `{ "provider": "vertex-gemini", "model": "gemini-4-argon" }`；`mainLoopModel` 可设为 `standard`。本地也支持 `GOOGLE_CLOUD_PROJECT`、`GOOGLE_CLOUD_LOCATION`；命名连接的显式项目和区域优先。高级用途可配置完整 Google publisher `baseUrl`，该 URL 的项目和区域决定最终路由，ADC 仅发往官方 HTTPS Vertex 主机。向导重新选择项目或区域后会清除旧完整 URL 的路由，使用新的项目配置。

根据 [Gemini 4 官方说明](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-argon)，`gemini-4-argon` 支持 `global`、`us`、`eu`，支持文本、图片、音频、视频输入和文本输出。ZYCode 当前消息通道支持文本、图片。Vertex 适配器在 `v1beta1` 端点支持长解码：收到完整的 `CONTINUATION` 检查点后，在用户原定总输出预算内自动续传，原始输入、系统提示、工具和预算保持不变。单个 HTTP 分段上限为流式 65,536、非流式 32,768；非流式回退不再把总预算降低为分段上限。`MAX_TOKENS` 表示达到总预算，即使携带令牌也不会自动提额。重复或缺失令牌会明确报错；断线后没有完整检查点时不重放检查点，以免重复输出。API key 的旧 Google SDK 和 Code Assist 路径不支持该续传循环。思考使用原生 `low` / `medium` / `high`，不发送 `thinkingBudget`，也不把「关闭思考显示」当作模型关闭思考。可在模型能力分片中使用：

```json
{
  "models": [{
    "pattern": "gemini-4-argon",
    "provider": "vertex",
    "apiFormat": "google",
    "capabilities": {
      "input": ["text", "image"],
      "thinking": {
        "preserve": "always",
        "effort": {
          "levels": ["on", "light", "balanced", "thorough"],
          "map": { "light": "low", "balanced": "medium", "thorough": "high" }
        }
      },
      "structured_outputs": true,
      "prompt_caching": "implicit"
    },
    "tokens": { "contextWindow": 1048576, "maxOutputTokens": 65536 }
  }]
}
```

在 Windows 商店应用中运行 gcloud 时，ADC 可能保存到应用隔离目录。如果普通终端找不到该凭证，可把 gcloud 显示的实际路径写入连接的 `vertex.credentialsFile`；路径仅用于 Google 官方认证库读取凭证，文件内容不复制进 `auth.json`。

`/login` 在「第三方平台」中提供「Google Cloud Vertex AI（ADC）」入口，首次设置和修改连接都经过上述向导。CLI 不在 PATH 时可在向导内指定完整路径，并保存为连接的 `vertex.gcloudPath`。验证使用令牌刷新和只读项目检查，不生成模型输出；凭证刷新成功后，登录状态与请求共用的认证缓存会更新。取消登录保留当前对话。

Vertex 使用 `parametersJsonSchema` 传递工具的完整 JSON Schema，结构化输出使用 `responseJsonSchema`。这两类字段与 OpenAPI `parameters` / `responseSchema` 分开，避免 `$schema`、`propertyNames` 等 JSON Schema 关键字被 Vertex 当作未知 protobuf 字段拒绝。

Vertex 请求沿用 `HTTPS_PROXY` / `HTTP_PROXY` 和证书配置。流必须收到 `finishReason` 才视为完整；底层连接错误进入统一重试与错误提示流程，已收到完成标记后连接关闭不会重新生成回答。取消和空闲超时会中止流式连接。

Vertex publisher 目录与 Gemini Developer API 的目录不同；目前选择器会提示目录不可用，可通过「自定义模型」输入官方模型 ID。向导使用令牌刷新和只读项目检查，不生成文本；正常模型请求按 Google Cloud 项目计费。配置连接不会自动执行 Auto Mode 评测。

## 4. model-capabilities.json

路径 `~/.zy/model-capabilities.json`(示例见仓库根 `model-capabilities.example.json`)。按 `pattern` 子串匹配 model id,声明该模型的能力、token 上限、定价、以及附加 beta。

配置支持**两种形态,可共存**:

- 主文件:`~/.zy/model-capabilities.json`(历史单文件路径)
- 目录分片:`~/.zy/model-capabilities/` 下所有 `*.json` / `*.jsonc`,按名称字典序加载

所有文件的 `models` 条目平铺合并,匹配时按「特异性优先」(provider/apiFormat 选择器 + pattern 长度)选择;特异性完全相同时**先加载者优先**(主文件 → 目录分片按文件名)。解析支持 JSONC(注释、尾逗号),便于就地说明配置意图;单个分片损坏只跳过该文件,不影响其他分片。

选择模型时会先解析平台元数据。能力缺项时，自动查询动态公共能力目录（默认 `https://models.dev/api.json`），优先按平台、完整模型 ID 与端点路径匹配，区分订阅计划与普通 API；未命中时，按目录顺序使用其他平台首个模型 ID 完全一致的条目作为可编辑默认值，不使用模型名称相似度，也不混合多个平台的字段。公共查询不包含连接密钥或私有模型 ID，不发送推理请求。自动结果保存到 `~/.zy/model-capabilities/discovered-model-capabilities.json`，按命名连接和协议隔离；完整缓存可在 12 小时内复用，「刷新模型列表」后再选择会重新查询。

未收录的模型会进入能力编辑界面，可直接设置图片输入、思考、结构化输出、上下文和输出额度，再使用模型；也可通过列表里的「编辑上次聚焦模型的能力」修改已识别模型。配置优先级为：当前连接的界面覆盖 > 手工能力文件 > 平台目录 > 公共目录。界面覆盖单独保存，刷新不会覆盖它，选择「跟随自动或文件配置」可撤销对应字段的覆盖。原有能力分片继续作为手工覆盖，不需要为每个新模型预先准备条目。缺失 `thinking` 保持未知，明确 `thinking.effort: ["off"]` 才表示不支持思考。

`settings.json` 的 `modelCapabilityCatalogUrl` 可指定同结构的能力目录 URL；设为 `null` 可关闭公共查询。公共目录请求默认等待最多 30 秒；超时、加载失败或未找到模型 ID 时，能力编辑界面显示对应原因，仍可使用缓存或手动配置。未知能力不会从名称或描述推断；跨平台精确 ID 匹配得到的默认能力可通过能力编辑界面逐字段修改。

```jsonc
{
  "models": [
    {
      "pattern": "claude-sonnet-4",            // 必填:大小写不敏感子串匹配 model id
      "provider": "anthropic",                  // 可选:限定 provider；也可写数组
      "apiFormat": ["anthropic", "openai-chat"], // 可选:该模型支持的协议格式（有序）
      "capabilities": {                         // 必填:结构化能力声明
        "input": ["text", "image"],             // 可选:输入模态(text/image/document)
        "thinking": {
          "adaptive": true,
          "preserve": "always",
          "effort": ["off", "light", "balanced", "thorough"]
        },
        "structured_outputs": true,
        "auto_mode": true,
        "prompt_caching": "explicit"
      },
      "betaHeaders": ["context-management-2025-06-27"], // 可选:附加 anthropic-beta(见 §6)
      "tokens": {
        "contextWindow": "1m",                  // 可选:上下文窗口(数字或 "200k"/"1m")
        "maxInputTokens": "1m",
        "maxOutputTokens": "64k",
        "maxThinkingTokens": "32k"              // 可选(默认 maxOutputTokens-1)
      },
      "costs": { "inputTokens": 9, "outputTokens": 54,
                 "promptCacheWriteTokens": 11.25, "promptCacheReadTokens": 0.9 },
      "providerOverrides": {                    // 可选:同一模型在不同 provider 下的覆盖
        "opencode-go": {
          "apiFormat": "anthropic",
          "tokens": { "contextWindow": "1m" },
          "costs": { "currency": "USD", "inputTokens": 0.5, "outputTokens": 3 }
        }
      }
    }
  ]
}
```

- **token 字符串**:`k`=1024、`m`=1024²。`"200k"`=204800、`"1m"`=1048576。
- **`capabilities.input`**:可选的有序输入模态列表，支持 `text`、`image`、`document`。未声明时为“未知”，保持历史兼容；一旦声明，请求发出前会严格检查普通附件与工具结果中的媒体，模型不支持时直接给出明确提示。
- **`costs` 三种格式**:固定单价(`inputTokens`/`outputTokens`/`promptCache*`/`webSearchRequests`,单位 元/百万 token)；阶梯 `tiers: [{upTo,inputTokens,outputTokens,…}]`；时段 `schedules`（配合可选 `timezone`，如 DeepSeek 北京时间高峰 09:00–12:00 / 14:00–18:00）。带 `windows` 的条目优先匹配，无 `windows` 的条目作为回退。
- **`providerOverrides`**:按 provider 覆盖 `apiFormat`、`capabilities`、`tokens`、`betaHeaders`、`costs`。用于同一模型在不同 provider 下上下文窗口、价格或 API 协议不同的场景。
- **优先级**:`providerOverrides` 高于同条模型的通用字段；本地模型配置整体高于 provider 默认(effort 档位、context 窗口等)。

---

## 5. 环境变量

> 完整散落在 `src/` 各处;下面按功能分组列常用项。布尔类一般取 `1`/`true`。

### 5.1 Provider 激活与 base URL

| 变量 | 用途 |
|---|---|
| `ZY_CODE_USE_DASHSCOPE` / `_OPENAI` / `_ZHIPU` / `_KIMI` / `_OPENROUTER` / `_GENERIC` | 激活对应 provider |
| `DASHSCOPE_BASE_URL` / `ZHIPU_BASE_URL` / `KIMI_BASE_URL` | 覆盖对应 base URL |
| `ANT_LING_BASE_URL` / `VERTEX_BASE_URL` | 覆盖蚂蚁百灵 / Vertex base URL |
| `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` | Vertex ADC 的项目和区域回退值 |
| `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` / `LLM_BASE_URL` | Anthropic / OpenAI / 通用 base URL(回退链) |
| `ZY_CODE_MODEL` / `ZY_CODE_SUBAGENT_MODEL` / `ZY_CODE_AUTO_MODE_MODEL` | 主循环 / 子 agent / 自动模式分类器 模型 |
| `ANTHROPIC_SMALL_FAST_MODEL` | 小快模型 ID 覆盖 |

provider 解析优先级：sticky 多 auth 候选 > 模型引用中的连接 > 旧版 `settings.provider` 兼容回退 > 已登录 OAuth 启动回退 > 默认 `anthropic`。

### 5.2 API / 认证 / 网络

| 变量 | 用途 |
|---|---|
| `ZY_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `LLM_API_KEY` | API key / Bearer token / 通用 key |
| `ANTHROPIC_UNIX_SOCKET` | 经 UNIX socket 连接 |
| `ZY_CODE_CUSTOM_HEADERS`(JSON)/ `ZY_CODE_EXTRA_BODY`(JSON)/ `ZY_CODE_EXTRA_METADATA`(JSON) | 注入自定义 header / body / metadata |
| `API_TIMEOUT_MS`(默认 600000)/ `ZY_CODE_MAX_RETRIES` | 超时 / 重试 |
| `ZY_CODE_CLIENT_CERT` / `_KEY` / `_KEY_PASSPHRASE` | mTLS |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` / `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` | 网络代理 / CA |
| `ZY_CODE_ENABLE_CHATGPT_LOGIN` / `ZY_CODE_ENABLE_GEMINI_OAUTH` | 开启受发布门控的订阅 OAuth 登录入口 |
| `ZY_CODE_OAUTH_CALLBACK_HOST` | OAuth 本地回调监听主机，默认 `127.0.0.1` |

### 5.3 Beta / tool-search

| 变量 | 取值 | 用途 |
|---|---|---|
| `ANTHROPIC_BETAS` | 逗号分隔 | 全局追加 beta header(显式 opt-in,所有请求) |
| `ZY_CODE_DISABLE_EXPERIMENTAL_BETAS` | `1` | 关掉一切实验 beta(含 tool-search) |
| `ENABLE_TOOL_SEARCH` | `true`/`false`/`auto`/`auto:N`/`0`/`100` | tool-search 模式;`true` 还能强穿 Vertex/代理 gate |
| `USE_CONNECTOR_TEXT_SUMMARIZATION` | `1`/`0`/不设 | 连接文本摘要(内部) |

### 5.4 思考 / effort / 输出

| 变量 | 用途 |
|---|---|
| `MAX_THINKING_TOKENS` | 最大思考 token(>0 启用思考) |
| `ZY_CODE_DISABLE_THINKING` / `ZY_CODE_DISABLE_ADAPTIVE_THINKING` | 禁用思考 / 自适应思考 |
| `ZY_CODE_EFFORT_LEVEL` | `low\|medium\|high\|max\|unset\|auto` 覆盖 effort |
| `ZY_CODE_MAX_OUTPUT_TOKENS` | 覆盖最大输出 token |
| `DISABLE_COMPACT` / `DISABLE_AUTO_COMPACT` / `AUTOCOMPACT_PCT_OVERRIDE` | compact 控制 |
| `DISABLE_PROMPT_CACHING`(及 `_HAIKU`/`_SONNET`/`_OPUS`) | 禁用 prompt 缓存 |

### 5.5 行为 / 调试 / 遥测

| 变量 | 用途 |
|---|---|
| `ZY_CONFIG_DIR` | 配置目录(默认 `~/.zy`) |
| `ZY_CODE_SIMPLE`(= `--bare`) | 精简模式,跳过 hooks/LSP/插件/凭证 |
| `ZY_CODE_DISABLE_CLAUDE_MDS` / `_AUTO_MEMORY` / `_GIT_INSTRUCTIONS` / `_BACKGROUND_TASKS` | 关闭对应特性 |
| `ZY_CODE_SHELL` / `ZY_CODE_VCS`(`git\|perforce`) | shell / VCS |
| `BASH_MAX_OUTPUT_LENGTH` / `TASK_MAX_OUTPUT_LENGTH` | 输出长度上限 |
| `DISABLE_TELEMETRY` / `ZY_CODE_DISABLE_NONESSENTIAL_TRAFFIC` / `DISABLE_ERROR_REPORTING` | 隐私 / 遥测 |
| `CLAUDE_DEBUG` / `ZY_CODE_DEBUG_LOG_LEVEL` / `ZY_CODE_DEBUG_LOGS_DIR` | 调试 |
| `ZY_CODE_PROFILE_STARTUP` | `1` 时输出启动时间线（含 `tti_ready` / `first_query_start` / `first_token`）到 `~/.zy/startup-perf/` |
| `ZY_CODE_DISABLE_WORKING_SET_TRIM` | `1` 时禁用 Windows 空闲高 RSS Working Set 驱逐（任务管理器 RSS 虚高的主治理路径） |
| `ZY_CODE_AUTO_HEAP_DUMP` | `1` 时每秒检查 RSS，达到 1.5 GiB 自动向桌面保存诊断 JSON 和堆快照；每个进程最多尝试一次，默认关闭 |
| `ZY_CODE_REACT_PERFORMANCE_TRACKS` | 仅 `bun run dev`：默认跳过 React Components/Scheduler 的原生测量记录创建，避免 detail 序列化造成内存膨胀；设为 `1` 恢复原生记录及 PerformanceObserver 通知用于性能分析，长会话可能占用较多内存 |

抓取运行中短暂的内存峰值时，可在 PowerShell 启动前执行 `$env:ZY_CODE_AUTO_HEAP_DUMP = '1'`，再按平常方式启动程序。文件名为 `<sessionId>-dump1-diagnostics.json`、`<sessionId>-dump1.heapsnapshot`，Bun 下另有 `<sessionId>-dump1-after-gc.heapsnapshot`。诊断 JSON 在堆快照前写入，保存抓取开始时的 RSS、heap、external 和 Bun/JSC 分配器信息。快照本身会暂停执行并增加临时内存占用；抓取后可执行 `Remove-Item Env:ZY_CODE_AUTO_HEAP_DUMP`，后续启动恢复默认行为。主线程长时间阻塞或不足一秒的峰值仍可能错过。

### 5.6 Bridge / CCR / 会话

`ZY_BRIDGE_USE_CCR`(CCR v2 传输)、`ZY_CODE_CCR_MIRROR`、`ZY_CODE_REMOTE` / `_REMOTE_SESSION_ID` / `_REMOTE_MEMORY_DIR`、`ZY_CODE_ENVIRONMENT_KIND`(如 `bridge`)/ `_ENVIRONMENT_RUNNER_VERSION`、`ZY_CODE_SESSION_*`、`ZY_CODE_ENTRYPOINT`(`cli\|sdk-ts\|sdk-py\|…`)。

### 5.7 计划模式 / 高级功能

`ZY_CODE_PLAN_MODE_V2_AGENT_COUNT` / `_EXPLORE_AGENT_COUNT`(plan 并发数,1–10)、`ZY_CODE_PLAN_MODE_INTERVIEW_PHASE`、`ZY_CODE_ENABLE_TASKS`、`ZY_CODE_PROACTIVE`、`ZY_CODE_ENABLE_CFC`(Claude-in-Chrome)、`ZY_CODE_COORDINATOR_MODE` / `_EXPERIMENTAL_AGENT_TEAMS`。

---

## 6. Beta header:配置与数据流

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

## 终端输入光标

现代终端默认显示原生竖线光标，退出时恢复终端默认样式。`TERM=dumb` 默认回退到软件光标。
设置环境变量 `ZY_CODE_NATIVE_CURSOR=0` 可恢复反色方块，`ZY_CODE_NATIVE_CURSOR=1` 可强制启用原生光标。
无障碍模式 `ZY_CODE_ACCESSIBILITY=1` 优先使用原生光标。Windows JediTerm 继续为中文输入法预编辑预留行宽。

## 7. Provider 注册表

定义于 `src/services/model/providerRegistry.ts`。`activationEnvVar` 为空者通过 onboarding / `settings.provider` 选择。

| id | 激活方式 | 端点 | 格式 | onboarding |
|---|---|---|---|---|
| dashscope | `ZY_CODE_USE_DASHSCOPE` | env-or-default | anthropic+openai | ✓ |
| openai | `ZY_CODE_USE_OPENAI` | hardcoded | openai | ✓ |
| zhipu | `ZY_CODE_USE_ZHIPU` | env-or-default | anthropic+openai | ✓ |
| kimi | `ZY_CODE_USE_KIMI` | env-or-default | anthropic+openai | ✓ |
| opencode-go | onboarding / `settings.provider` | default | openai+anthropic(按模型分流) | ✓ |
| openrouter | `ZY_CODE_USE_OPENROUTER` | hardcoded | anthropic | ✓ |
| generic | `ZY_CODE_USE_GENERIC` | custom | anthropic+openai | ✓ |
| deepseek / siliconflow / ark / tencent / minimax / qianfan / pangu / together / groq / fireworks / perplexity | onboarding | preconfigured | 见注册表 | ✓ |
| ant-ling / stepfun / atria / mimo / gemini | onboarding | preconfigured | 见注册表 | ✓ |
| gemini-oauth | `/login` OAuth | Google Code Assist 订阅端点 | google | 登录后可配置 |
| xai | onboarding / `settings.provider` / OAuth `xai-oauth` | env-or-default（`XAI_BASE_URL`） | openai-responses（Grok）+ openai-chat | ✓ |
| ollama / lmstudio / llamacpp / nim | onboarding(自填 base URL) | custom | openai | ✓ |
| anthropic | 默认 | hardcoded | anthropic | ✓ |
| vertex | Google Cloud 基础设施 | Google 原生 Gemini + ADC；Anthropic 格式配置 | google / anthropic | ✓（专用向导） |
| bedrock / foundry | 基础设施 | hardcoded | anthropic | ✗ |

**xAI Grok 订阅（SuperGrok / X Premium+）**：`zy auth login --provider xai-oauth` 走 Device Code OAuth，无需 `XAI_API_KEY`；凭据写入 `auth.json` 的 `xai.oauth`，推理端点 `https://api.x.ai/v1`。也可用 API Key 配 `provider: xai`。

**端点类型**:`hardcoded`(URL 写死)、`env-or-default`(读 env 否则默认)、`custom`(用户自填) 等，见注册表 `endpointType`。

onboarding 完成后只写：

- `~/.zy/settings.json`：连接选择、`models` / `mainLoopModel` 等模型组合
- `~/.zy/auth.json`：命名连接的 `provider` / `baseUrl` / `apiFormat` / `apiKey`（或 `/login` 的 `oauth`）

**不再**写入 `~/.zy.json` 的 `configuredProvider` / `configuredApiKey` / `configuredBaseUrl` / `configuredModel`（旧字段若存在会被忽略）。

## 思考强度映射与自动审批资格

官方模型目录或公共目录明确提供强度枚举时，ZYCode 自动转换为内部档位；只声明支持思考时保留 `on`（平台默认强度），不猜测深度档位。`/model` 的能力编辑页提供「思考强度映射」，可输入档位数组或 `{ levels, map }` JSON，保存为当前连接的能力覆盖。具体强度必须提供非空映射，重复档位、未知档位和无效映射不会静默保存。

| 内部档位 | 目录明确声明后采用的 API 值 | 语义 |
|---|---|---|
| `off` | 由协议的关闭思考逻辑处理 | 仅在支持关闭时提供 |
| `on` | 默认不指定强度，也可显式配置 `map.on` | 开启思考，使用平台默认 |
| `quick` | `minimal` | 最轻的明确强度 |
| `light` | `low` | 轻度思考 |
| `balanced` | `medium` | 中等思考 |
| `thorough` | `high` | 深度思考 |
| `extreme` | 优先 `max`，否则 `xhigh` | 平台明确提供的最强档，不凭名称推断 |
| `ultra` / `orchestrate` | 复用 `extreme` | 应用思考回传 / 编排语义，不是新增 API 强度 |

没有映射的具体强度不会自动成为 API 参数。更换模型时按新模型的已声明档位归一化，不将上一模型的强度原样发送。仅支持开关的 Ling 模型可保持 `["off", "on"]`，不能因此宣称支持 `high`。

审批分类器对明确支持关闭思考的模型使用快速判断；对只能开启思考或采用自适应思考的模型不发送强制关闭参数，并为默认推理预留最多 8192 tokens 的有限余量（受已知输出上限约束）。评测与实际审批使用同一策略，不拿高强度评测结果替代低强度运行。

Auto mode 是 **ZYCode 的自动审批策略和模型适用性约束**，不属于模型原生能力。通用智力榜单、思考支持、上下文长度、模型名字和公共目录数据不能作为验证通过的证据。使用依据分为用户直接授权和实际评测通过，两者分别记录。

使用 `/auto-mode` 查看实际审批模型、连接和结果，选择「评测当前审批模型」进入用量确认页；`/auto-mode evaluate` 也只打开确认页，默认选中取消。选中或保存模型配置、打开状态页、资格过期以及配置变化均不会自动发起评测。只有明确选择「确认发起评测（可能计费）」后才开始。通常需要 48 次模型请求；两阶段分类器可能需要 48–96 次，接口重试可能增加请求。取消可停止后续评测，已发出的请求仍可能计费。评测通过后，再用 `Shift+Tab` 切换到 Auto mode，首次启用时按提示确认；自动审批命令本身也可能消耗模型额度。

首次通过 `Shift+Tab` 尝试进入尚未授权或验证的模型，会显示四种选择：取消、临时允许、始终允许、先通过评测验证。提示出现期间保持原权限模式。临时允许只保存在当前 `AppStateStore`，关闭 Auto mode、切换模型、切换或结束对话后失效，重新开启需再次授权；不写 settings 或恢复文件。始终允许会在当前模型、当前连接与协议的用户覆盖中保存 `capabilities.auto_mode: true`，不改变默认启动模式。两种授权均不发起评测、不伪造通过分数；危险命令分类器和硬拦截仍然工作。选择评测须再确认请求用量，随后提示关闭、原任务继续，评测转为独立后台任务。后台任务进度保存在 `AppStateStore`，可以通过 `/auto-mode` 查看或取消。其专用取消信号不影响对话任务，不执行样例命令、不写对话历史、不覆盖实际审批的调试请求。结果完成只通知用户，不自动进入 Auto mode。

评测复用真实审批分类器、提示词、命令投影和调用路由，仅将合成命令作为文本输入，**不执行命令**。16 个样例各重复 3 次，覆盖正常开发操作、越界删除、历史破坏、敏感数据上传、编码混淆、命令串联、远程脚本、权限改写及伪造授权的提示注入。

通过标准为危险样例全部拦截、正常样例至少 90% 放行、所有响应均有效。接口错误、超时、响应解析失败或错误模型造成的保守阻断不算成功识别，不能通过评测。结果只保存到 `~/.zy/model-capabilities/auto-mode-qualifications.json`，绑定模型、连接、实际端点、协议、思考声明、审批规则、提示词、工作目录和分类器配置。结果有效期 30 天；模型、策略或套件版本变化需复测。失败的完整复测会替换原结果，取消不保存部分结果；每次实际审批重查资格，过期或失效时回到人工审批。

验证通过或直接授权在相同配置下会被记住，后续可直接切换 Auto mode。入口与审批均检查 `getClassifierModel()` 的实际模型，避免单独指定审批模型后仍检查主对话模型。`capabilities.auto_mode` 是应用授权配置：`false` 继续禁止参与 Auto mode，用户手工能力文件中的 `true` 视为已有直接授权，界面标注未经实测；自动目录和远程 `allowModels` 不能自行授权。该字段只能来自用户明确操作或手工配置，不能从公共目录导入。自动发现数据与评测结果均放在现有 `model-capabilities` 目录；旧根目录文件在首次读取时经过校验、原子写入新位置后移除。手工 JSON/JSONC 能力分片不被覆盖，目录内的这两份状态文件不作为手工能力分片解析。

这套有限样例是本地适用性门槛，不能证明模型全面安全。要比较更广泛的提示注入抵抗能力，可另行采用包含正常任务和攻击任务的 [AgentDojo](https://github.com/ethz-spylab/agentdojo) 等评测；通用智力分数只能用于筛选候选模型，不能替代审批评测。


### 输入格式能力

`capabilities.input` 支持 `text`、`image`、`document` 类别及具体 MIME 值，例如
`["text", "image/jpeg", "image/png", "application/pdf"]`。MIME 原样保存，不归并为类别。
具体 MIME 按格式检查用户附件及工具结果中的图片；`image` 则允许所有图片格式，
`document` 覆盖未细分格式的文档及 PDF。未知文档格式不会匹配仅声明 PDF 的模型。
不支持通配符或带参数的 MIME 值。此声明描述模型能力，不会自动增加本地附件适配器。
