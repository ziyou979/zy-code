# 用 claude-tap 抓 zy-code 流量

## 背景

- **zy-code**：claude-code 的本地分化项目，源码在 `/Users/zy979/IdeaProjects/zy-code/`，通过 zsh alias `zycode` 启动（实际命令为 `bun --preload .../devPreload.ts .../cli.tsx`）
- **目标**：复用 claude-tap 的 trace 追踪能力，看 zy-code 的请求/响应/SSE 流
- **网关**：百炼 OpenAI 兼容端点 `https://dashscope.aliyuncs.com/compatible-mode/v1`，走标准 `chat.completions` 协议

## 结论

**不用改 claude-tap 代码**，直接 `uv tool install claude-tap` 即可。

claude-tap 已具备的能力：

| 你的需求 | 现成支持 | 出处 |
|---|---|---|
| OpenAI Chat Completions 协议 | SSE 累积 + viewer 渲染 + token 归一 | `sse.py:131`, `viewer.html:3486`, `usage.py` |
| 百炼 `/compatible-mode/v1` 上游 | forward 模式无路径白名单；reverse 模式拆 base URL 即可 | `forward_proxy.py` |
| Authorization 透传 | 自动转发，trace 中 mask 显示前 12 字符 | `proxy.py:50-53` |

唯一阻碍：zsh alias 在 subprocess 里看不见——需要一个 shim。

## 一次性准备

### 1. 装 claude-tap

```bash
uv tool install claude-tap        # 或 pip install claude-tap
claude-tap --version              # 验证
```

### 2. 给 zycode 做 shim

zsh alias 只在交互式 shell 里有效，claude-tap 用 `asyncio.create_subprocess_exec` 直接 `execvp` 找不到。写个真实可执行文件：

```bash
cat > ~/.local/bin/zycode <<'EOF'
#!/usr/bin/env bash
exec bun --preload /Users/zy979/IdeaProjects/zy-code/src/entrypoints/devPreload.ts \
         /Users/zy979/IdeaProjects/zy-code/src/entrypoints/cli.tsx "$@"
EOF
chmod +x ~/.local/bin/zycode
```

`~/.local/bin` 已在 PATH 中。zsh alias 与 PATH shim 共存：交互式 shell 走 alias，subprocess 走 shim，行为一致。

## 启动方式

### 方式 A：forward 模式（推荐）

forward proxy 不走路径白名单，透明 MITM 所有 HTTPS。无需关心 `compatible-mode/v1` 前缀。

```bash
# 终端 1
claude-tap --tap-no-launch --tap-proxy-mode forward
# 输出示例：
#   🔍 claude-tap v0.1.71 forward proxy on http://0.0.0.0:58437
#      CA cert: /Users/zy979/.claude-tap/ca.pem

# mac 终端 2（端口和 CA 路径从终端 1 输出抄）
HTTPS_PROXY=http://127.0.0.1:58437 \
NODE_EXTRA_CA_CERTS=/Users/zy979/.claude-tap/ca.pem \
zycode

# win 终端2
$env:HTTPS_PROXY="http://127.0.0.1:58437"; $env:NODE_EXTRA_CA_CERTS="C:\Users\zy979\.claude-tap\ca.pem"; zycode
```

> `0.0.0.0` 表示监听所有网卡，本机访问写 `127.0.0.1` 即可。

想固定端口加 `--tap-port 8888`。

### 方式 B：reverse 模式

需要拆 base URL，让进 proxy 的 path 命中白名单（`proxy.py:69` 的 `/v1/chat/completions`）。

```bash
# 终端 1
claude-tap --tap-no-launch \
  --tap-target https://dashscope.aliyuncs.com/compatible-mode

# 终端 2
OPENAI_BASE_URL=http://127.0.0.1:<port>/v1 zycode
```

URL 推算：
- SDK 发送 `POST http://127.0.0.1:<port>/v1/chat/completions`
- 白名单匹配 `/v1/chat/completions` ✓
- 上游拼接 `https://dashscope.aliyuncs.com/compatible-mode` + `/v1/chat/completions` = `…/compatible-mode/v1/chat/completions` ✓

⚠️ **不要把 `/compatible-mode` 塞进 `OPENAI_BASE_URL`**，否则进 proxy 的 path 是 `/compatible-mode/v1/chat/completions`，不在白名单里会被 404。如果非要这样，加 `--tap-allow-path /compatible-mode`。

> 如果 zy-code 配的是 DashScope provider 且对应 `DASHSCOPE_BASE_URL`，把命令里的 `OPENAI_BASE_URL` 换成 `DASHSCOPE_BASE_URL`。base URL 解析顺序见 `zy-code/src/services/api/client.ts:281`：provider-specific → `OPENAI_BASE_URL` → `LLM_BASE_URL` → onboarding config。

## 日志/trace 在哪

默认输出到当前目录 `./.traces/`，按日期分目录：

```
.traces/
└── 2026-05-17/
    ├── trace_HHMMSS.jsonl     # 实时追加：每次请求/响应完整 JSONL
    ├── trace_HHMMSS.log       # 实时追加：代理诊断日志
    └── trace_HHMMSS.html      # 进程退出时生成：可视化 viewer
```

实时观察：

```bash
tail -f ./.traces/2026-05-17/trace_*.jsonl
tail -f ./.traces/2026-05-17/trace_*.log
```

`.html` 用浏览器打开即可，自带 diff/diff 模态框。

### 想边跑边可视化

加 `--tap-live`，启动时自动开浏览器，SSE 推送：

```bash
claude-tap --tap-no-launch --tap-proxy-mode forward --tap-live
```

输出会多一行 `🌐 Live viewer: http://127.0.0.1:<live_port>`。

### 改输出路径

`--tap-output-dir ~/claude-tap-logs`（默认 `./.traces`，见 `cli.py:922`）。

## 什么情况下才需要改 claude-tap 代码

只有这两种场景才动 `CLIENT_CONFIGS`：

1. 想 `claude-tap --tap-client zy` 一条命令直接拉起 zycode（省去手动设 env）——非必需
2. 命中了 `ALLOWED_PATH_PREFIXES` 之外的端点——优先用 `--tap-allow-path` 临时放行，仍然不用改代码

## 快速回顾

```bash
# 一次性
uv tool install claude-tap
cat > ~/.local/bin/zycode <<'EOF'
#!/usr/bin/env bash
exec bun --preload /Users/zy979/IdeaProjects/zy-code/src/entrypoints/devPreload.ts \
         /Users/zy979/IdeaProjects/zy-code/src/entrypoints/cli.tsx "$@"
EOF
chmod +x ~/.local/bin/zycode

# 每次使用
claude-tap --tap-no-launch --tap-proxy-mode forward --tap-live
HTTPS_PROXY=http://127.0.0.1:<port> NODE_EXTRA_CA_CERTS=/Users/zy979/.claude-tap/ca.pem zycode
```
