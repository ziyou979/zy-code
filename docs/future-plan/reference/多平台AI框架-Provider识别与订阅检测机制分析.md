# 多平台 AI 编码框架 — Provider 识别与订阅检测机制全解

> 本文系统分析 Claude Code、OpenCode、Oh My Pi (omp)、OpenClaw、Oh My OpenCode (OmO) 五大框架如何识别和管理 Anthropic 订阅、OpenAI 订阅和 API Key 模式，涵盖认证流程、路由机制、回退策略、多 Provider 编排，以及 OAuth 底层实现原理。

---

## 目录

1. [问题背景：为什么 Provider 识别很重要](#1-问题背景为什么-provider-识别很重要)
2. [核心概念：三种认证模式](#2-核心概念三种认证模式)
3. [Claude Code 的 Provider 识别机制](#3-claude-code-的-provider-识别机制)
4. [OpenCode 的 Provider 管理体系](#4-opencode-的-provider-管理体系)
5. [Oh My Pi (omp) 的多 Provider 路由架构](#5-oh-my-pi-omp-的多-provider-路由架构)
6. [OpenClaw 的 Provider Plugin 体系](#6-openclaw-的-provider-plugin-体系)
7. [Oh My OpenCode (OmO) 的 Fallback Chain](#7-oh-my-opencode-omo-的-fallback-chain)
8. [横向对比：五大框架的设计差异](#8-横向对比五大框架的设计差异)
9. [Provider 识别的技术本质](#9-provider-识别的技术本质)
10. [The Harness Problem：平台博弈与开放生态](#10-the-harness-problem平台博弈与开放生态)
11. [OAuth 底层实现原理：三方框架如何接入订阅](#11-oauth-底层实现原理三方框架如何接入订阅)
12. [设计启示与最佳实践](#12-设计启示与最佳实践)

---

## 1. 问题背景：为什么 Provider 识别很重要

现代 AI 编码框架面临一个核心工程挑战：**同一个模型（如 Claude Opus）可以通过多种完全不同的路径访问**——直接 API Key、个人订阅（Pro/Max）、企业订阅（Team/Enterprise）、云平台（Bedrock/Vertex/Foundry）。每种路径的认证方式、计费规则、速率限制、可用功能和 API 行为都不同。

框架需要回答这些问题：

- 用户是 API 付费用户还是订阅用户？
- 当前凭据走哪条传输路径？
- 某个功能（如 prompt caching、fast mode）在当前路径下是否可用？
- 主 Provider 限流时，是否有备选路径？
- 多个 Agent 并行工作时，如何分配不同 Provider 的配额？

---

## 2. 核心概念：三种认证模式

在分析各框架之前，先明确三种基本认证模式：

### 2.1 API Key 模式

```
用户 → 在 Provider 控制台生成 API Key → 设置环境变量 → 框架直接调用 API
```

- **计费**：按量付费（pay-as-you-go）
- **特点**：最灵活，支持全部 API 功能（prompt caching、batch 等）
- **典型变量**：`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`

### 2.2 OAuth / 订阅模式

```
用户 → 浏览器登录 Provider 账户 → OAuth 授权 → 框架获得 Token → 通过订阅配额调用
```

- **计费**：月费订阅，有使用上限（如 Claude Max 的 token 配额）
- **特点**：无需管理 API Key，但受订阅计划限制
- **典型流程**：`/login`、`claude login`、OAuth device code

### 2.3 云平台托管模式

```
用户 → 配置云平台凭据（IAM/SigV4/Service Account）→ 框架通过云平台 API 调用模型
```

- **计费**：通过云平台账单（AWS/GCP/Azure）
- **特点**：企业级安全、VPC 内网访问、合规审计
- **典型变量**：`AWS_ACCESS_KEY_ID`、`GOOGLE_CLOUD_PROJECT`、`ANTHROPIC_FOUNDRY_RESOURCE`

---

## 3. Claude Code 的 Provider 识别机制

Claude Code 是 Anthropic 官方产品，其 Provider 识别相对简单但有明确的优先级链。

### 3.1 认证优先级（从高到低）

```
CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST  （宿主平台锁定，忽略以下所有）
         ↓
ANTHROPIC_API_KEY                     （API Key 模式，覆盖订阅）
         ↓
CLAUDE_CODE_OAUTH_TOKEN               （OAuth Token，覆盖 keychain）
         ↓
Keychain 存储的登录凭据                 （订阅模式：Pro/Max/Team/Enterprise）
         ↓
CLAUDE_CODE_OAUTH_REFRESH_TOKEN       （Refresh Token 自动交换）
```

### 3.2 API Key vs 订阅的切换逻辑

**核心规则**：`ANTHROPIC_API_KEY` 一旦设置，**即使用户已登录订阅账户**，也会被覆盖。

```
if ANTHROPIC_API_KEY is set:
    if interactive mode and first_use:
        prompt user to confirm "use API key instead of subscription?"
    use API key → pay-as-you-go billing
else:
    use subscription credentials from keychain
    → subscription quota billing
```

恢复使用订阅只需 `unset ANTHROPIC_API_KEY`。

### 3.3 多云平台路由

Claude Code 通过专用环境变量识别云平台：

| 环境变量 | Provider 路径 |
|---------|-------------|
| `CLAUDE_CODE_USE_BEDROCK=1` | Amazon Bedrock |
| `ANTHROPIC_VERTEX_PROJECT_ID` | Google Vertex AI |
| `ANTHROPIC_FOUNDRY_RESOURCE` | Microsoft Foundry |
| `ANTHROPIC_AWS_WORKSPACE_ID` | Claude Platform on AWS |
| （无以上变量） | 直接 Anthropic API 或订阅 |

### 3.4 宿主锁定机制

```
CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = true
```

当此变量被设置（通常由 IDE 或托管平台设置），所有用户级的 Provider 配置变量（`ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL` 等）**被静默忽略**。这防止用户在嵌入式环境中覆盖宿主的路由策略。

### 3.5 认证辅助工具

| 变量 | 用途 |
|------|------|
| `ANTHROPIC_AUTH_TOKEN` | 自定义 Authorization header（自动加 `Bearer` 前缀） |
| `ANTHROPIC_CUSTOM_HEADERS` | 注入额外认证 header |
| `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` | 配合 `apiKeyHelper` 设定凭据刷新间隔 |
| `ANTHROPIC_WORKSPACE_ID` | Workload identity federation 中指定目标 workspace |

### 3.6 功能可用性差异

| 功能 | API Key | 订阅 |
|------|---------|------|
| Prompt Caching | 完全支持 | 不适用 |
| Fast Mode (service_tier) | 支持 | 受订阅计划限制 |
| 1M 上下文 | 支持 | 支持 |
| mTLS | 支持 | 不适用 |
| Batch API | 支持 | 不适用 |

---

## 4. OpenCode 的 Provider 管理体系

OpenCode 是目前最大的开源 AI 编码框架（160K+ stars），采用 **AI SDK + Models.dev** 的标准化 Provider 管理方案。

### 4.1 认证存储

所有凭据统一存储在 `~/.local/share/opencode/auth.json`，通过 `/connect` 命令写入。

### 4.2 三种认证路径

#### 路径一：API Key

```bash
# 交互式
/connect anthropic
# 输入 API Key

# 或直接配置
{
  "provider": {
    "anthropic": {
      "options": { "apiKey": "{env:ANTHROPIC_API_KEY}" }
    }
  }
}
```

`{env:VAR}` 语法允许引用环境变量而非硬编码 Key。

#### 路径二：OAuth 登录（订阅模式）

以下 Provider 支持浏览器 OAuth：

| Provider | 订阅类型 | 认证方式 |
|----------|---------|---------|
| OpenAI | ChatGPT Plus/Pro | 浏览器 OAuth |
| Anthropic | Claude Pro/Max | 浏览器 OAuth |
| GitHub Copilot | Individual/Business | Device Code OAuth |
| xAI | SuperGrok/X Premium | 浏览器 OAuth 或 Device Code |
| GitLab Duo | Premium/Ultimate | OAuth 或 Personal Access Token |
| DigitalOcean | — | OAuth（自动发现 Inference Router） |

#### 路径三：云平台环境变量

| Provider | 环境变量 |
|----------|---------|
| Amazon Bedrock | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_PROFILE` |
| Google Vertex AI | `GOOGLE_CLOUD_PROJECT` / `GOOGLE_APPLICATION_CREDENTIALS` |
| Azure OpenAI | API Key via `/connect` + `AZURE_RESOURCE_NAME` |
| SAP AI Core | `AICORE_SERVICE_KEY`（JSON 对象） |

### 4.3 Provider 分类体系

OpenCode 将 75+ Provider 分为六大类：

| 类别 | 示例 | 认证特点 |
|------|------|---------|
| 一线云厂商 | Anthropic, OpenAI, Google, xAI | API Key 或 OAuth |
| 云平台 | Bedrock, Vertex, Azure | IAM / Service Account |
| 聚合网关 | OpenRouter, Vercel Gateway, Cloudflare | API Key + 后端路由 |
| 推理提供商 | Groq, Cerebras, Together, Fireworks | API Key |
| 本地模型 | Ollama, LM Studio, llama.cpp | 无需 Key 或可选 |
| OpenCode 自有 | Zen, Go | 内置订阅 |

### 4.4 模型路由机制

```
/connect → 存储凭据到 auth.json
    ↓
/models → 列出当前 Provider 可用模型
    ↓
opencode.json → 配置默认模型和自定义模型
    ↓
运行时 → 按 Provider + Model 路由请求
```

**聚合路由示例（OpenRouter）：**

```json
{
  "provider": {
    "openrouter": {
      "models": {
        "anthropic/claude-opus-4-8": {
          "options": {
            "provider": {
              "order": ["anthropic"],
              "allow_fallbacks": true
            }
          }
        }
      }
    }
  }
}
```

**自定义兼容 Provider：**

任何 OpenAI 兼容 API 都可通过 `@ai-sdk/openai-compatible` 包接入：

```json
{
  "provider": {
    "my-proxy": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://my-proxy.example.com/v1",
        "apiKey": "{env:MY_PROXY_KEY}"
      },
      "models": {
        "claude-opus": {
          "limit": { "context": 200000, "output": 8192 }
        }
      }
    }
  }
}
```

### 4.5 订阅状态查询（opencode-mystatus 插件）

社区开发的 `opencode-mystatus` 插件可查询各平台的订阅状态和配额使用情况：

| 平台 | 查询端点 | 获取信息 |
|------|---------|---------|
| OpenAI | `chatgpt.com/backend-api/wham/usage` | Plus/Team/Pro 用量百分比、重置时间 |
| 智谱AI | `bigmodel.cn/api/monitor/usage/quota/limit` | Coding Plan 配额 |
| GitHub Copilot | `api.github.com/copilot_internal/user` | Premium 请求消耗、月度重置日 |
| Google Cloud | `cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels` | 按模型分列配额 |

凭据来源是 OpenCode 自身的 `auth.json`，无需额外配置。

---

## 5. Oh My Pi (omp) 的多 Provider 路由架构

Oh My Pi 是 Can Bölük 开发的高性能编码 Agent，以"Harness Problem"理论闻名，拥有最精细的 Provider 分类和路由体系。

### 5.1 Provider 三层分类 + Auth 标签

omp 将 40+ Provider 分为三层，并为每个 Provider 标注认证标签：

#### 层级一：Frontier APIs（直接 API 访问）

```
Anthropic [oauth]
OpenAI [oauth]
Google Gemini [oauth]
xAI [oauth]
Mistral, Groq, Cerebras, Fireworks, Together, HuggingFace, NVIDIA
OpenRouter, DeepSeek, ...
```

#### 层级二：Coding Plans（订阅路由）

```
Cursor [plan]          ← 通过 Cursor 订阅
GitHub Copilot [plan]  ← 通过 Copilot 订阅
GitLab Duo [plan]      ← 通过 GitLab 订阅
Kimi Code [plan]       ← 通过 Kimi 订阅 ($19/月)
MiniMax [plan]         ← 通过 MiniMax Coding Plan
Alibaba [plan]         ← 通过阿里云订阅
Z.AI/GLM [plan]        ← 通过 GLM Coding Plan ($10/月)
Wafer Pass [plan]      ← 通过 Wafer 订阅
```

#### 层级三：Local/Self-hosted

```
Ollama [local]         ← Key 可选
LM Studio [local]
llama.cpp [local]
vLLM [local]
LiteLLM [local]
```

### 5.2 Auth 标签系统

三种标签明确标识认证方式：

| 标签 | 含义 | 认证流程 |
|------|------|---------|
| `oauth` | 通过 Provider 账户 OAuth 登录 | `/login` → 浏览器授权 → Token 存储 |
| `plan` | 通过编码订阅路由 | `/login` → 订阅会话附着 |
| `local` | 本地服务器，Key 可选 | 自动发现或手动配置 URL |

**识别逻辑的关键**：omp 不是在运行时"检测"用户的认证模式，而是**通过 Provider 分类预定义认证方式**。用户选择了哪个 Provider，就走哪条认证路径。

### 5.3 Role-Based 模型路由

omp 创新性地引入了**角色路由**——按任务类型选择不同的模型：

| 角色 | 用途 | 典型模型选择 |
|------|------|-------------|
| `default` | 常规对话 | claude-opus-4-7 |
| `smol` | 廉价子 Agent 扇出 | gpt-5.4-mini / gemini-flash |
| `slow` | 深度推理 | claude-opus-4-8 / o1 |
| `plan` | 规划模式 | claude-opus-4-7 |
| `commit` | Changelog 生成 | 轻量模型 |

### 5.4 Fallback 链 + 凭据轮换

```json
{
  "modelRoles": {
    "default": [
      { "provider": "anthropic", "model": "claude-opus-4-7" },
      { "provider": "openai", "model": "gpt-5.5" },
      { "provider": "xai", "model": "grok-4" }
    ]
  }
}
```

**Fallback 触发条件**：当前 Provider 返回 429 限流或配额耗尽时，自动切换到链中的下一个。

**凭据轮换**：同一 Provider 可配置多个 API Key，运行时以 session affinity + per-credential backoff 策略轮换：

```
ANTHROPIC_API_KEY_1=sk-...
ANTHROPIC_API_KEY_2=sk-...
ANTHROPIC_API_KEY_3=sk-...
```

限流响应（429、`rate_limit`、`quota`、"resource exhausted"）触发轮换；非限流错误不触发。

### 5.5 路径级路由覆盖

```json
{
  "modelRoles": {
    "default": [
      { "provider": "anthropic", "model": "claude-sonnet-4-6" }
    ]
  },
  "paths": {
    "/work/critical-project": {
      "default": [
        { "provider": "anthropic", "model": "claude-opus-4-8" }
      ]
    }
  }
}
```

"closest path wins"——可以为特定项目使用更强的模型。

### 5.6 支持的传输协议

自定义 Provider 可选择七种协议：

| 协议 | 对应平台 |
|------|---------|
| `openai-completions` | 标准 OpenAI Chat Completions |
| `openai-responses` | OpenAI Responses API |
| `openai-codex-responses` | Codex 专用 Responses |
| `azure-openai-responses` | Azure OpenAI |
| `anthropic-messages` | Anthropic Messages API |
| `google-generative-ai` | Google Generative AI |
| `google-vertex` | Google Vertex AI |

---

## 6. OpenClaw 的 Provider Plugin 体系

OpenClaw 是 Peter Steinberger 开发的自托管 AI Agent Gateway，拥有最复杂的 Provider 管理架构。

### 6.1 双轨认证体系

#### API Key 轨道

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-8" }
    }
  }
}
```

支持多 Key 轮换，优先级链：
```
OPENCLAW_LIVE_<PROVIDER>_KEY     ← 单一实时覆盖（最高）
<PROVIDER>_API_KEYS              ← 逗号分隔的 Key 列表
<PROVIDER>_API_KEY               ← 主 Key
<PROVIDER>_API_KEY_1, _2, ...    ← 编号列表
```

#### OAuth/订阅 轨道

| Provider | OAuth 路径 | 触发命令 |
|----------|-----------|---------|
| OpenAI/Codex | ChatGPT OAuth → Codex app-server | `openclaw onboard --auth-choice openai` |
| xAI | SuperGrok/X Premium OAuth | `openclaw models auth login --provider xai` |
| Gemini CLI | Gemini CLI 自有 OAuth | `openclaw models auth login --provider google-gemini-cli` |
| MiniMax | Global/CN 双入口 OAuth | `MINIMAX_OAUTH_TOKEN` |

### 6.2 OpenAI 路由分裂（最复杂的设计）

OpenClaw 中 OpenAI 的路由是所有框架中最复杂的，因为同一个 `openai/*` 模型引用可以走三条完全不同的路径：

```
openai/gpt-5.5
    ├─ 路径 A: Codex app-server (原生订阅执行)
    │     ← OAuth 认证 + 默认 runtime
    │     ← 走 chatgpt.com/backend-api
    │
    ├─ 路径 B: OpenClaw 嵌入式 runtime (API Key)
    │     ← agentRuntime.id: "openclaw"
    │     ← 走 api.openai.com 直接 API
    │
    └─ 路径 C: Codex app-server (API Key fallback)
          ← API Key profile + 默认 runtime
          ← Key 通过 app-server login RPC 传递
```

**路由决策逻辑：**

```javascript
if (有 OAuth profile 且未显式指定 runtime) {
    走 Codex app-server (路径 A)
    // 清除子进程中的 CODEX_API_KEY 和 OPENAI_API_KEY
    // 通过 app-server login RPC 发送凭证
} else if (agentRuntime.id === "openclaw") {
    走 OpenClaw 嵌入式 (路径 B)
} else {
    走 Codex app-server + API Key (路径 C)
}
```

### 6.3 Anthropic 的双模式

```
anthropic/claude-opus-4-8
    ├─ 模式 A: 直接 API (API Key)
    │     ← ANTHROPIC_API_KEY
    │     ← 支持 prompt caching、fast mode
    │
    └─ 模式 B: Claude CLI (订阅复用)
          ← agentRuntime.id: "claude-cli"
          ← 通过 `claude -p` 调用本地 Claude Code CLI
          ← 复用 Pro/Max/Team/Enterprise 订阅配额
```

**计费差异（2026.6.15 后）：**

| 模式 | 计费方式 |
|------|---------|
| API Key | pay-as-you-go |
| Claude CLI | 先扣月度 Agent SDK 额度 → 耗尽后按 API 费率从 usage credits 扣 |

### 6.4 混合认证排序

```json5
{
  auth: {
    order: {
      openai: [
        "openai:user@example.com",    // 订阅优先
        "openai:api-key-backup",       // API Key 备用
      ]
    }
  }
}
```

当订阅配额耗尽时，自动轮换到 API Key profile。

### 6.5 Provider Plugin 架构

OpenClaw 的核心创新是 **Provider Plugin 体系**——官方 Provider 通过 `registerProvider()` 注册，自动发布模型目录，无需用户手动配置模型列表。

Plugin 负责的完整职责链：

```
onboarding             ← 引导用户完成认证
模型目录               ← 自动发布可用模型
auth 环境变量映射       ← 将凭据映射到正确的 header
传输/配置规范化         ← 统一不同 Provider 的请求格式
tool-schema 清理        ← 适配各模型的工具调用格式
failover 分类           ← 区分可重试和不可重试的错误
OAuth 刷新              ← 自动刷新过期 Token
usage 上报              ← 用量统计
thinking/reasoning profiles ← 推理模式配置
```

### 6.6 兼容代理的特殊处理

**非 api.openai.com 的 OpenAI 兼容代理：**
- 强制 `compat.supportsDeveloperRole: false`
- 跳过：`service_tier`、Responses `store`、prompt-cache hints、reasoning-compat payload shaping

**非 api.anthropic.com 的 Anthropic 兼容代理：**
- 抑制隐式 beta headers（`claude-code-20250219`、`interleaved-thinking-2025-05-14`）

这确保了代理/网关不会因为不支持的专有参数而报错。

---

## 7. Oh My OpenCode (OmO) 的 Fallback Chain

OmO 运行在 OpenCode 之上，它不直接管理 Provider 认证（交由 OpenCode 处理），而是专注于**多 Agent 场景下的模型选择和回退**。

### 7.1 双轨模型选择

```
主模型    ← 用户在 OpenCode UI 中手动选择（不受配置文件控制）
子 Agent ← oh-my-openagent.json 中的 agents 字段定义
```

### 7.2 三层 Fallback Chain

```json
{
  "categories": {
    "visual-engineering": {
      "model": "ollama-27b/qwen3.5:27b-q4_K_M",        // 付费首选
      "fallback_models": [
        { "model": "ollama-9b/qwen3.5:9b" },             // 付费备选
        { "model": "google/gemini-3.1-pro-preview", "variant": "high" },
        { "model": "anthropic/claude-opus-4-6", "variant": "max" },
        { "model": "opencode/big-pickle" }                // 免费兜底
      ]
    }
  }
}
```

**三层结构：** 付费首选 → 付费备选 → OpenCode 提供的免费模型兜底。

### 7.3 runtime_fallback 自动切换

```json
{
  "runtime_fallback": {
    "enabled": true,
    "max_fallback_attempts": 7
  }
}
```

切换时弹出 Toast 通知显示当前使用的模型。

### 7.4 按订阅状态生成配置

```bash
# 根据实际订阅情况生成配置
npx oh-my-opencode install --no-tui \
    --claude=yes \      # 有 Anthropic 订阅
    --openai=no \       # 没有 OpenAI 订阅
    --gemini=no \       # 没有 Google 订阅
    --copilot=yes       # 有 Copilot 订阅
```

这是 OmO 的核心策略——**不自动检测订阅状态，而是由用户显式声明**，然后据此生成最优的 Fallback 配置。

### 7.5 本地模型并发控制

```json
{
  "background_task": {
    "providerConcurrency": { "ollama-27b": 1 },
    "modelConcurrency": { "ollama-27b/qwen3.5:27b-q4_K_M": 1 }
  }
}
```

防止多 Agent 同时请求本地模型导致 VRAM 耗尽。

---

## 8. 横向对比：五大框架的设计差异

### 8.1 认证模式支持

| 框架 | API Key | OAuth 订阅 | 云平台 | 本地模型 | 编码计划订阅 |
|------|---------|-----------|--------|---------|-------------|
| Claude Code | ✅ | ✅ (Anthropic) | ✅ (Bedrock/Vertex/Foundry) | ✗ | ✗ |
| OpenCode | ✅ | ✅ (多平台) | ✅ (Bedrock/Vertex/Azure) | ✅ | ✗ |
| Oh My Pi | ✅ | ✅ (多平台) | — | ✅ | ✅ (Kimi/MiniMax/GLM等) |
| OpenClaw | ✅ | ✅ (多平台) | — | — | ✅ (通过 Plugin) |
| OmO | 委托 OpenCode | 委托 OpenCode | 委托 OpenCode | ✅ (Ollama) | 委托 OpenCode |

### 8.2 Provider 识别策略

| 框架 | 识别方式 | 核心理念 |
|------|---------|---------|
| **Claude Code** | 环境变量优先级链 | "一个 Provider，多种接入方式" |
| **OpenCode** | `/connect` 交互式 + AI SDK 标准化 | "75+ Provider 统一管理" |
| **Oh My Pi** | Auth 标签分类 (`oauth`/`plan`/`local`) | "Provider 类型决定认证方式" |
| **OpenClaw** | Plugin 注册 + 认证排序 | "Plugin 全权管理 Provider 生命周期" |
| **OmO** | 安装时声明 + Fallback Chain | "不检测，由用户声明" |

### 8.3 Fallback 策略

| 框架 | 跨 Provider Fallback | 同 Provider 多 Key 轮换 | 触发条件 |
|------|---------------------|----------------------|---------|
| Claude Code | ✗ (单 Provider) | ✗ | — |
| OpenCode | 通过聚合网关间接支持 | ✗ | — |
| Oh My Pi | ✅ 角色级 Fallback 链 | ✅ Session affinity 轮换 | 429/quota/rate_limit |
| OpenClaw | ✅ 认证排序链 | ✅ 编号列表轮换 | 429/quota/rate_limit |
| OmO | ✅ Category 级 3 层 Fallback | ✗ | 模型不可用 |

### 8.4 多 Agent 场景下的 Provider 分配

| 框架 | 策略 |
|------|------|
| Claude Code | 单 Provider，所有 Agent 共享 |
| OpenCode | 单 Provider + 子 Agent 无差异化 |
| Oh My Pi | 角色路由（default/smol/slow/plan），不同角色走不同 Provider |
| OpenClaw | Agent 级别独立认证（每个 Agent 独立 onboard） |
| OmO | Agent 级别 + Category 级别双维度分配 |

---

## 9. Provider 识别的技术本质

综合分析五大框架，Provider 识别的技术路线可归纳为三种范式：

### 9.1 范式一：环境变量驱动（Claude Code）

```
系统启动
  → 扫描环境变量
  → 按优先级链决定认证模式
  → 单一 Provider 路径贯穿整个会话
```

**优点**：实现简单、行为可预测、部署友好（CI/CD 只需设环境变量）
**缺点**：不支持多 Provider、不支持动态切换

### 9.2 范式二：显式注册 + 交互式配置（OpenCode、omp）

```
用户执行 /connect 或 /login
  → 存储凭据到本地文件
  → 按 Provider 类型走对应认证流程
  → 运行时按角色/模型路由到正确 Provider
```

**优点**：支持多 Provider、支持 Fallback、灵活性高
**缺点**：需要用户主动配置、凭据管理复杂度高

### 9.3 范式三：Plugin 全托管（OpenClaw）

```
Plugin 注册 Provider
  → 自动发布模型目录
  → 自动管理认证刷新
  → 自动处理 Failover 分类
  → 自动规范化请求格式
```

**优点**：用户零配置、Provider 行为一致性高、易于扩展新 Provider
**缺点**：Plugin 实现复杂、黑盒程度高

---

## 10. The Harness Problem：平台博弈与开放生态

### 10.1 核心论点

Can Bölük 在 "The Harness Problem" 一文中指出：

> "No vendor will do harness optimization for competitors' models."

Anthropic 不会为 Grok 优化工具格式，xAI 不会为 Gemini 优化，每个厂商只优化自家模型。但社区驱动的开源框架天然支持所有模型——因为贡献者使用不同的模型，修复他们个人遇到的问题。

### 10.2 平台限制实例

- **Anthropic**：曾阻止 OpenCode 通过 Claude Code 订阅访问 Claude
- **Google**：完全禁用了 omp 作者的 Gemini 账号（因 benchmark 活动）

这些事件揭示了一个张力：**平台方希望控制 Harness 层（使用自家工具），而社区希望 Harness 层开放（模型是参数，工具可替换）**。

### 10.3 多 Provider 支持的战略意义

对框架而言，支持多 Provider 不仅是功能需求，更是**生存策略**——如果只依赖一个 Provider，一旦被限制就是灭顶之灾。omp 支持 40+ Provider、OpenCode 支持 75+ Provider，本质上是通过"Provider 分散"降低平台风险。

---

## 11. OAuth 底层实现原理：三方框架如何接入订阅

### 11.1 核心结论：不读浏览器 Cookie

**没有任何主流三方框架通过读取浏览器 Cookie 来获取订阅凭据。** 实际采用四种方式：

| 方式 | 使用框架 | 适用 Provider |
|------|---------|-------------|
| OAuth Authorization Code + PKCE | OpenCode, omp, OpenClaw | Anthropic, OpenAI, xAI |
| OAuth Device Code (RFC 8628) | OpenCode, omp, OpenClaw | GitHub Copilot, xAI |
| CLI Wrapper（调用官方 CLI） | OpenClaw | Anthropic (Claude CLI) |
| App-Server 代理 | OpenClaw | OpenAI (Codex app-server) |

不读 Cookie 的三个原因：
1. **安全性**：Cookie 格式私有且经常变化，读取属于逆向工程行为
2. **可靠性**：OAuth token 有明确的刷新机制，Cookie 随时可能因用户注销或过期而失效
3. **合规性**：OAuth 是 Provider 提供的**官方接口**（Anthropic 开放了 `claude.ai/oauth/authorize` 端点），而 Cookie 不是

---

### 11.2 方式一：OAuth Authorization Code + PKCE（最主流）

这是 **OpenCode 和 Oh My Pi 访问 Anthropic/OpenAI 订阅** 的主要方式，也是 Claude Code 自身使用的认证机制。

有人逆向分析了 Claude Code 的完整 OAuth 流程（[源文](https://akashmohan.com/writings/claude-code-oauth)），核心技术细节如下：

#### 11.2.1 完整流程

```
┌─────────────────────────────────────────────────────────────┐
│  1. 框架在本地启动临时 HTTP 服务器                             │
│     监听 http://127.0.0.1:{随机端口}/callback                │
│     ← 不是读 cookie，是接收 OAuth 回调                       │
│                                                             │
│  2. 生成 PKCE 参数（防授权码劫持）                             │
│     code_verifier = 随机 43-128 字符串（始终保密）              │
│     code_challenge = base64url(sha256(code_verifier))        │
│     state = 随机 43 字符（CSRF 防护）                         │
│                                                             │
│  3. 打开系统浏览器，跳转到 Provider 的授权页面                  │
│     用户看到的是 claude.ai 的正常登录页面                       │
│     用户输入账号密码、完成 2FA 等                               │
│     ← 框架完全不接触用户的密码                                 │
│                                                             │
│  4. 用户点击"授权"后                                          │
│     浏览器重定向到 http://127.0.0.1:{PORT}/callback           │
│     URL 中携带一次性授权码 (authorization_code)                │
│     框架的本地 HTTP 服务器接收到这个授权码                      │
│                                                             │
│  5. 框架用授权码 + code_verifier 向 Token 端点换取 Token       │
│     ← 因为有 PKCE，即使授权码被截获也无法换取 Token             │
│                                                             │
│  6. 收到 access_token + refresh_token                        │
│     存储到本地文件或 Keychain                                  │
│                                                             │
│  7. 后续所有 API 调用使用 access_token                         │
│     过期时用 refresh_token 自动刷新                            │
│     refresh_token 使用 rotation 策略（用一次就换新的）           │
└─────────────────────────────────────────────────────────────┘
```

#### 11.2.2 Anthropic OAuth 关键参数

| 要素 | 值 |
|------|-----|
| 授权端点 | `https://claude.ai/oauth/authorize` |
| Token 端点 | `https://console.anthropic.com/v1/oauth/token` |
| Client ID | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` |
| 可用 Scopes | `user:profile` `user:inference` `org:create_api_key` `user:sessions:claude_code` |
| Access Token 前缀 | `sk-ant-oat01-` |
| Refresh Token 前缀 | `sk-ant-ort01-` |
| Access Token 有效期 | 8 小时（28800 秒） |
| Refresh 策略 | **Rotation** — 每次刷新返回新 refresh_token，旧的立即失效 |

#### 11.2.3 授权 URL 构造示例

```
https://claude.ai/oauth/authorize?
  code=true&
  client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&
  response_type=code&
  redirect_uri=http://localhost:56121/callback&
  scope=user:profile+user:inference&
  code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&
  code_challenge_method=S256&
  state=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
```

#### 11.2.4 Token 交换请求

```http
POST https://console.anthropic.com/v1/oauth/token
Content-Type: application/json

{
  "grant_type": "authorization_code",
  "code": "<一次性授权码>",
  "state": "<与授权请求一致的 state>",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "redirect_uri": "http://localhost:56121/callback",
  "code_verifier": "<原始 verifier，首次在此发送>"
}
```

#### 11.2.5 Token 响应结构

```json
{
  "token_type": "Bearer",
  "access_token": "sk-ant-oat01-xxxx...xxxx",
  "expires_in": 28800,
  "refresh_token": "sk-ant-ort01-xxxx...xxxx",
  "scope": "user:inference user:profile",
  "organization": { "uuid": "...", "name": "..." },
  "account": { "uuid": "...", "email_address": "user@example.com" }
}
```

#### 11.2.6 API 调用时的额外要求

使用 OAuth Token 调用 API 时，除了标准的 `Authorization: Bearer` 之外，还需要：

```http
Authorization: Bearer sk-ant-oat01-xxxx
anthropic-beta: oauth-2025-04-20,claude-code-20250219
anthropic-version: 2023-06-01
```

**关键限制**：API 会验证系统指令的开头必须是 `"You are Claude Code, Anthropic's official CLI for Claude."`。第三方框架调用时需要包含这段前缀。

#### 11.2.7 安全防护体系

| 防护机制 | 防御目标 |
|---------|---------|
| **state 参数** | CSRF 攻击 — 防止攻击者注入恶意授权码 |
| **PKCE (code_verifier/challenge)** | 授权码拦截 — 即使授权码被截获也无法交换 token（因为没有 verifier） |
| **Refresh token rotation** | Token 泄露 — 旧 token 使用即失效 |
| **短期授权码（~5 min）** | 减少授权码被利用的时间窗口 |
| **Access token 8h 过期** | 限制泄露后的影响范围 |

#### 11.2.8 Redirect URI 的两种形式

| 形式 | 适用场景 | URI |
|------|---------|-----|
| 本地回调 | CLI / 桌面应用 | `http://localhost:{动态端口}/callback` |
| 托管回调 | 无本地服务器（手动复制） | `https://console.anthropic.com/oauth/code/callback` |

托管回调模式下，授权码显示在页面上，用户手动复制粘贴回 CLI。

---

### 11.3 方式二：OAuth Device Code Flow（RFC 8628）

适用于 SSH、Docker、VPS 等**无法打开浏览器**的场景。

#### 11.3.1 标准流程

```
┌──────────────────────────────────────────────────────────────┐
│  1. 框架向 Provider 的 device authorization 端点发请求         │
│     POST /device/code                                       │
│     → 收到:                                                  │
│       device_code: "XXXXXXXXXX"    (框架保存，不展示)          │
│       user_code:   "8F43-6FCF"     (展示给用户)               │
│       verification_uri: "https://github.com/login/device"    │
│       interval: 5                  (轮询间隔，秒)              │
│                                                              │
│  2. CLI 输出提示：                                             │
│     ┌─────────────────────────────────────────┐              │
│     │ 请访问: github.com/login/device          │              │
│     │ 输入代码: 8F43-6FCF                      │              │
│     │ 等待授权中...                             │              │
│     └─────────────────────────────────────────┘              │
│                                                              │
│  3. 用户在任意设备（手机/电脑）的浏览器中：                       │
│     ① 打开 verification_uri                                  │
│     ② 输入 user_code                                         │
│     ③ 登录账户并点击授权                                       │
│     ← 不需要本地浏览器                                         │
│     ← 不需要 localhost 回调                                    │
│     ← 可以在另一台设备上完成                                    │
│                                                              │
│  4. 框架持续轮询 Token 端点                                    │
│     POST /device/token                                       │
│     每 {interval} 秒一次                                      │
│     未授权时返回 "authorization_pending"                        │
│     用户完成授权后 → 返回 access_token + refresh_token          │
│                                                              │
│  5. Token 存储到本地，后续流程与方式一相同                       │
└──────────────────────────────────────────────────────────────┘
```

#### 11.3.2 各框架的 Device Code 支持

| 框架 | 支持的 Provider | 触发方式 |
|------|----------------|---------|
| OpenCode | GitHub Copilot | `/connect` → 自动跳转 `github.com/login/device` |
| OpenCode | xAI (headless) | `/connect` → 输出 `x.ai/device` + 短码 |
| OpenClaw | OpenAI | `openclaw onboard --auth-choice openai --device-code` |
| OpenClaw | xAI | `openclaw models auth login --provider xai` |
| Oh My Pi | 多数 `[oauth]` Provider | `/login --device-code` |

#### 11.3.3 与 Authorization Code 流程的关键区别

| 维度 | Authorization Code + PKCE | Device Code |
|------|--------------------------|-------------|
| 是否需要本地浏览器 | 是 | 否 |
| 是否启动本地 HTTP 服务器 | 是（接收回调） | 否 |
| 授权可在其他设备完成 | 否 | 是 |
| 安全性 | PKCE 防劫持 | 短码 + 短有效期 |
| 适用环境 | 桌面/笔记本 | SSH/Docker/VPS/CI |

---

### 11.4 方式三：CLI Wrapper — 调用官方 CLI（OpenClaw 特有）

**OpenClaw 访问 Claude 订阅的独特方式**——不自己实现 OAuth，而是把已登录的 Claude Code CLI 当作"后端"使用。

#### 11.4.1 工作原理

```
┌──────────────────────────────────────────────────────────────┐
│  前提条件：                                                   │
│  用户已在本机运行 `claude login`，完成了 Claude Code 的登录     │
│  → 凭据存储在 macOS Keychain，项目名 "Claude Code-credentials" │
│  → 或存储在 ~/.claude/ 目录下                                 │
│                                                              │
│  OpenClaw 的处理方式：                                        │
│                                                              │
│  ┌──────────┐     ┌──────────────┐     ┌──────────────┐      │
│  │ OpenClaw │ ──→ │ claude -p    │ ──→ │ Anthropic    │      │
│  │ (网关)   │     │ (print mode) │     │ API          │      │
│  └──────────┘     └──────────────┘     └──────────────┘      │
│       │                   │                                   │
│       │  通过 stdio 通信   │  自动从 Keychain                  │
│       │  传入 prompt       │  读取凭据并认证                    │
│       │  接收 response     │                                   │
│                                                              │
│  关键：OpenClaw 不读 Keychain，不读 cookie，不碰 token          │
│  它只是把 Claude CLI 当作一个"黑盒子进程"调用                    │
│  所有认证由 Claude CLI 自己处理                                 │
└──────────────────────────────────────────────────────────────┘
```

#### 11.4.2 限制条件

| 限制 | 原因 |
|------|------|
| 必须同一台机器 | `claude -p` 需要访问本地 Keychain |
| 不支持容器 | Docker/Podman 不挂载 `~/.claude` |
| macOS 首次需确认 | Keychain 会弹出 "Always Allow" 授权弹窗 |
| 不支持 prompt caching | `claude -p` 模式不暴露底层 API 参数 |

#### 11.4.3 配置方式

```json5
{
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-8" },
      models: {
        "anthropic/claude-opus-4-8": {
          agentRuntime: { id: "claude-cli" }  // 关键：指定 CLI 后端
        }
      }
    }
  }
}
```

#### 11.4.4 计费路径

```
claude -p 调用
  → Anthropic 视为 "Agent SDK / 程序化使用"
  → 2026.6.15 前：按 Claude Code 订阅规则
  → 2026.6.15 后：先扣月度 Agent SDK 额度
                  → 耗尽后按标准 API 费率从 usage credits 扣
```

---

### 11.5 方式四：App-Server 代理模式（OpenAI Codex 特有）

OpenAI 的 Codex 产品线提供了一个 **app-server**（本地守护进程），三方框架通过 RPC 与它通信，而非直接调用 OpenAI API。

#### 11.5.1 架构图

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  ┌──────────────┐   stdio/RPC    ┌───────────────────┐       │
│  │  三方框架     │ ────────────→ │ Codex App-Server  │       │
│  │  (OpenClaw/   │               │ (本地进程)         │       │
│  │   OpenCode)   │ ←──────────── │                   │       │
│  └──────────────┘   响应流        └────────┬──────────┘       │
│                                           │                  │
│                                   内部管理 OAuth Token        │
│                                           │                  │
│                                  ┌────────▼──────────┐       │
│                                  │ chatgpt.com/      │       │
│                                  │ backend-api       │       │
│                                  │ (ChatGPT 订阅配额)  │       │
│                                  └────────┬──────────┘       │
│                                           │                  │
│                                  ┌────────▼──────────┐       │
│                                  │ OpenAI 模型       │       │
│                                  │ (GPT-5.5 等)      │       │
│                                  └───────────────────┘       │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

#### 11.5.2 认证选择顺序

Codex app-server 内部的认证优先级：

```
1. auth.order.openai 中排序的 OAuth profiles    ← 最高
2. App-server 已有账户（本地 Codex CLI 登录）
3. 环境变量回退（仅 stdio 启动时）
   └─ CODEX_API_KEY → OPENAI_API_KEY
```

#### 11.5.3 防污染机制

当选择了 OAuth 订阅 profile 时，OpenClaw **主动清除子进程环境中的 `CODEX_API_KEY` 和 `OPENAI_API_KEY`**。这确保流量只走订阅通道，不会因为环境变量意外存在而切换到 API Key 计费。

#### 11.5.4 与直接 OAuth 的区别

| 维度 | 直接 OAuth (方式一) | App-Server 代理 (方式四) |
|------|-------------------|------------------------|
| Token 管理者 | 三方框架自己 | Codex app-server |
| API 端点 | api.openai.com | chatgpt.com/backend-api |
| 三方是否接触 Token | 是 | 否（通过 RPC 间接使用） |
| 依赖本地进程 | 否 | 是（需要 Codex 运行） |

---

### 11.6 Token 存储位置对比

| 框架 | 存储方式 | 路径 |
|------|---------|------|
| Claude Code | macOS Keychain | 项目名 `"Claude Code-credentials"` |
| Claude Code | 环境变量覆盖 | `CLAUDE_CODE_OAUTH_TOKEN` |
| OpenCode | JSON 文件 | `~/.local/share/opencode/auth.json` |
| OpenClaw | JSON 文件 | `~/.openclaw/agents/<id>/agent/auth-profiles.json` |
| OpenClaw (旧) | JSON 文件 (仅导入) | `~/.openclaw/credentials/oauth.json` |
| Oh My Pi | 内置 auth store | 未公开具体路径 |

**都不存储在浏览器中。** Token 一旦通过 OAuth 获得，就脱离浏览器环境，存储在框架自己管理的本地文件或系统 Keychain 中。

---

### 11.7 各 Provider 的 OAuth 回调端口

从各框架文档中提取到的已知回调配置：

| Provider | 框架 | 回调 URI | 模式 |
|----------|------|---------|------|
| Anthropic | Claude Code / OpenCode | `http://localhost:{动态端口}/callback` | Authorization Code + PKCE |
| Anthropic | 无本地浏览器时 | `https://console.anthropic.com/oauth/code/callback` | 手动复制授权码 |
| OpenAI | OpenClaw | 通过 Codex app-server（无直接回调） | App-Server RPC |
| xAI | OpenCode | `http://127.0.0.1:56121/callback` | Authorization Code |
| xAI | OpenCode (headless) | 无回调 | Device Code |
| GitLab | OpenCode (self-hosted) | `http://127.0.0.1:8080/callback` | Authorization Code |
| GitHub Copilot | OpenCode | 无回调 | Device Code |
| DigitalOcean | OpenCode | 未公开 | Authorization Code |

---

### 11.8 完整流程图：三方框架接入 Anthropic 订阅

```
                        用户执行 /connect anthropic
                                 │
                    ┌────────────┼────────────┐
                    ▼            ▼            ▼
              选择 API Key   选择 OAuth    选择 Claude CLI
                    │            │            │
                    ▼            ▼            ▼
              输入 API Key   ① 生成 PKCE    检测本机 claude
              存入 auth.json   code_verifier  CLI 是否已登录
                    │        ② 打开浏览器      │
                    │          claude.ai/      ▼
                    │          oauth/authorize 通过 claude -p
                    │        ③ 用户登录授权    调用 (print mode)
                    │        ④ 回调到 localhost
                    │        ⑤ 授权码换 Token
                    │        ⑥ 存入 auth.json
                    │            │            │
                    ▼            ▼            ▼
              直接调用        调用 API        调用 claude -p
              api.anthropic   加 OAuth       子进程代理
              .com/v1/        headers         │
              messages        │               ▼
                    │         ▼           claude CLI
                    │    Authorization:   自己从 Keychain
                    │    Bearer sk-ant-   读取凭据
                    │    oat01-xxx        调用 API
                    │    +                │
                    │    anthropic-beta:  │
                    │    oauth-2025-...   │
                    │         │           │
                    ▼         ▼           ▼
              ┌──────────────────────────────────┐
              │      Anthropic API Server        │
              │                                  │
              │  API Key → pay-as-you-go 计费     │
              │  OAuth   → 订阅配额计费            │
              │  CLI     → Agent SDK 额度计费      │
              └──────────────────────────────────┘
```

---

### 11.9 为什么不读 Cookie？深层分析

有人可能会想：浏览器已经登录了 claude.ai，直接读 Cookie 不是更简单吗？答案是**技术上可行但实际上不可取**，原因如下：

| 维度 | 读 Cookie | OAuth |
|------|----------|-------|
| **合法性** | 灰色地带，Provider 可视为违规 | 官方提供的标准接口 |
| **稳定性** | Cookie 格式私有，随时可能变更 | OAuth 协议有 RFC 标准 |
| **安全性** | Cookie 包含完整会话，泄露后果严重 | Token 有作用域限制（scope） |
| **刷新机制** | Cookie 过期依赖浏览器行为 | Refresh token 有明确的刷新协议 |
| **跨平台** | 不同浏览器 Cookie 存储位置和加密方式不同 | OAuth 流程与浏览器无关 |
| **权限控制** | Cookie 是全权限会话 | OAuth scope 可限定只授予推理权限 |
| **用户感知** | 用户不知道自己的 Cookie 被读取 | OAuth 有明确的授权页面，用户知情同意 |

**实际案例**：Anthropic 在 OpenCode v1.3.0 之前曾存在通过 Cookie/非官方方式访问订阅的第三方插件，但在 v1.3.0 中被移除，理由是 "Anthropic explicitly prohibits this"。这说明平台方明确反对 Cookie 读取方式，但接受标准 OAuth 流程。

---

## 12. 设计启示与最佳实践

### 12.1 认证架构设计建议

| 原则 | 说明 |
|------|------|
| **分离 Provider 身份与传输路径** | 同一模型（如 claude-opus）可通过不同路径访问，身份（"这是 Anthropic 的模型"）和传输（"通过 Bedrock 调用"）应解耦 |
| **API Key 覆盖订阅** | 环境变量设置的 API Key 应优先于登录态，便于自动化和 CI/CD |
| **凭据不硬编码** | 使用 `{env:VAR}` 引用而非明文存储 |
| **支持多 Key 轮换** | 同一 Provider 配置多个 Key，限流时自动切换 |
| **区分认证添加与默认切换** | 新增 Provider 认证不应自动替换当前默认模型 |

### 12.2 OAuth 实现建议

| 原则 | 说明 |
|------|------|
| **必须使用 PKCE** | CLI 是 public client，无法安全存储 client_secret，PKCE 是唯一的安全替代 |
| **支持 Device Code 作为 fallback** | 远程/无头环境无法打开浏览器，Device Code 是必要的补充 |
| **Token rotation 必须正确实现** | 每次 refresh 保存新 token，否则凭据链断裂 |
| **本地回调端口应动态分配** | 固定端口可能被占用，应绑定到随机可用端口 |
| **支持托管回调（手动复制码）** | 作为无法启动本地 HTTP 服务器时的最后手段 |

### 12.3 路由架构设计建议

| 原则 | 说明 |
|------|------|
| **按角色路由而非按模型** | omp 的 default/smol/slow/plan 模式是最佳实践——任务类型决定模型，而非反过来 |
| **Fallback 链是必需品** | 在多 Agent 并行场景下，单 Provider 必然成为瓶颈，Fallback 链是可靠性保障 |
| **区分可重试和不可重试错误** | 429 限流可重试（换 Key/换 Provider），401 认证失败不可重试 |
| **本地模型并发限制** | 本地 GPU 资源有限，必须控制并发 |

### 12.4 兼容性设计建议

| 原则 | 说明 |
|------|------|
| **检测目标域名再注入专有参数** | OpenClaw 的做法——非 `api.openai.com` 的代理不发送 `service_tier` 等专有参数 |
| **抑制 Beta Header** | 非第一方 API 不发送 beta 测试 header |
| **模型引用规范化** | 统一使用 `provider/model` 格式，遗留别名自动迁移 |
| **协议类型显式声明** | 自定义 Provider 必须声明使用哪种 API 协议 |

---

## 附录 A：各框架凭据存储路径汇总

| 框架 | 凭据路径 | 格式 |
|------|---------|------|
| Claude Code | macOS Keychain `"Claude Code-credentials"` + 环境变量 | OS 原生 |
| OpenCode | `~/.local/share/opencode/auth.json` | JSON |
| Oh My Pi | 内置 auth store | — |
| OpenClaw | `~/.openclaw/agents/<id>/agent/auth-profiles.json` | JSON |
| OmO | 委托 OpenCode 的 `auth.json` | JSON |

## 附录 B：Anthropic OAuth 快速参考

```
授权端点:     https://claude.ai/oauth/authorize
Token 端点:   https://console.anthropic.com/v1/oauth/token
Client ID:    9d1c250a-e61b-44d9-88ed-5944d1962f5e
Scopes:       user:profile user:inference
Grant Type:   authorization_code (with PKCE)
Token 前缀:   access=sk-ant-oat01-  refresh=sk-ant-ort01-
有效期:       access=8h  refresh=rotation
必需 Header:  anthropic-beta: oauth-2025-04-20,claude-code-20250219
```

---

> **总结：五大框架代表了 Provider 识别的三种范式演进——从 Claude Code 的单 Provider 环境变量驱动，到 OpenCode/omp 的多 Provider 显式注册，再到 OpenClaw 的 Plugin 全托管。OAuth 实现上，所有框架均采用标准 OAuth 2.0 协议（Authorization Code + PKCE 或 Device Code），不读取浏览器 Cookie。核心趋势是：认证方式标签化（oauth/plan/local）、路由与认证解耦、Fallback 链标配化。在多 Agent 编排场景下，Provider 管理的复杂度不可避免地上升，最佳实践是按任务角色路由（而非按模型硬编码），并通过 Fallback 链和多 Key 轮换保障可靠性。**
