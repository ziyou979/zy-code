# ZY Code

简体中文 | [English](README.md)

ZY Code 是一个基于 TypeScript、React、Ink 和 Bun 构建的终端 AI 编程 Agent。它可以把代码库
连接到不同的模型服务，并通过一组受控工具完成文件读取与编辑、代码搜索、命令执行和长任务协作。

> ZY Code `0.0.1` 是首个公开预览版本。部分能力尚未完备，配置格式和扩展 API 在首个稳定版本前
> 可能发生变化。

## 项目沿革

ZY Code 从 Claude Code 2.1.88 分化而来，此后持续独立演进。项目保留了终端编程 Agent 的基础，
同时逐步形成了自己的多 Provider 模型层、具名连接与订阅路由、中文本地化、外部 Tool 系统、终端
渲染引擎、跨平台支持和长任务工作流。

ZY Code 是独立的开源项目，与 Anthropic 不存在隶属或官方合作关系，也未获得其背书。

## 为什么选择 ZY Code？

- **同时配置多个订阅与服务**：订阅账号、API Key、网关和本地模型可以并存，不必让整个 Agent
  绑定到单一 Provider。
- **按模型档位混搭路由**：advanced、standard、compact 可分别使用不同连接，也可以为任意档位
  配置跨 Provider 的有序候选链。
- **围绕终端工作**：基于 Ink 的交互界面支持流式响应、工具调用、diff、计划、代码审查、
  会话历史和键盘工作流。
- **控制执行边界**：通过权限规则、审批提示、沙箱集成和项目级指令约束文件、Shell 与网络访问。
- **自定义与覆盖 Tool**：通过普通 TypeScript/JavaScript 文件加载项目级或用户级 Tool；对支持覆盖的
  内置 Tool，导出同名实现即可替换。
- **按需扩展 Agent**：可连接 MCP Server，并添加 Skill、Hook、插件和自定义命令。
- **处理更大的任务**：内置上下文管理、持久记忆、后台任务、子 Agent、模型故障转移和可恢复会话。

## 自由混搭模型与订阅

具名连接把 Provider 认证与模型选择解耦。例如，主循环可以优先使用 xAI 订阅；当认证、限流或额度
问题导致无法继续时，自动切换到百炼 API；compact 档位则使用本地模型。切换结果会跨会话保留。

```jsonc
{
  "mainLoopModel": "standard",
  "models": {
    "advanced": { "provider": "grok-subscription", "model": "grok-4.6" },
    "standard": [
      { "provider": "grok-subscription", "model": "grok-4.6" },
      { "provider": "qwen-work", "model": "qwen3.8-max" }
    ],
    "compact": { "provider": "local", "model": "qwen3.5" }
  },
  "modelFailover": {
    "enabled": true,
    "maxConsecutiveFailures": 2
  }
}
```

连接与凭证单独保存在 `~/.zy/auth.json`，模型路由则保留在 settings 中。连接配置和故障切换行为详见
[配置文档](docs/configuration.md)。

## 自定义与覆盖 Tool

ZY Code 会从项目级 `.zy/tools/` 和用户级 `~/.zy/tools/` 加载外部 Tool。使用新名称可以扩展工具集；
对于支持覆盖的内置 Tool，使用相同名称即可在外部实现生效期间替换它。Tool 定义是一个轻量、与框架
无关的对象，只需提供描述、JSON Schema 和异步 `call()` 函数。

> [!IMPORTANT]
> 内置 `WebSearch` 依赖自行部署的 [OpenSERP](https://github.com/karust/openserp)，并从
> `http://127.0.0.1:7000` 访问；ZY Code 不会内置或托管该服务。可以通过
> `docker run --rm -p 127.0.0.1:7000:7000 karust/openserp:latest serve -a 0.0.0.0 -p 7000`
> 启动，也可以按照下方示例使用自己的外部 Tool 覆盖 `WebSearch`。

仓库内置的 [DuckDuckGo WebSearch demo](examples/external-tools/web-search-duckduckgo.ts) 展示了如何在
不修改 ZY Code 源码的情况下替换内置 `WebSearch`：

```bash
mkdir -p .zy/tools
cp examples/external-tools/web-search-duckduckgo.ts .zy/tools/web-search.ts
```

重启 ZY Code 即可加载；也可以运行 `/reload-tools`，在当前会话中应用 Tool 的新增、修改、删除与覆盖。
删除覆盖文件并重新加载后，内置 Tool 会自动恢复。

## 环境要求

- [Bun](https://bun.sh/) 1.3 或更高版本
- Git
- 推荐使用支持真彩色的终端
- macOS、Linux 或 Windows

部分沙箱、系统钥匙串、浏览器和原生计算机操作能力与平台有关；缺少这些能力不影响核心 CLI 运行。

## 从源码构建

```bash
git clone https://github.com/ziyou979/zy-code.git
cd zy-code
bun install --frozen-lockfile
bun run build
bun run start
```

构建产物位于 `dist/cli.js`。首次启动时，引导流程会要求选择 API Provider、凭证、API 格式和模型档位。

本地开发可直接运行：

```bash
bun install
bun run dev
```

## 配置

ZY Code 默认把用户配置保存在 `~/.zy`；可通过 `ZY_CONFIG_DIR` 指定其他目录。

| 路径 | 用途 |
| --- | --- |
| `~/.zy/settings.json` | 用户设置、模型档位、权限、Hook 和界面偏好 |
| `~/.zy/auth.json` | 具名 Provider 连接与凭证 |
| `.zy/settings.json` | 可随仓库共享的项目设置 |
| `.zy/settings.local.json` | 项目本地覆盖；不要提交密钥 |
| `~/.zy/model-capabilities.json` | 可选的模型能力、限制、价格和路由声明 |
| `.mcp.json` | 项目 MCP Server 配置 |
| `AGENTS.md` | 提供给编程 Agent 的项目指令 |

设置会按用户、项目、本地、命令行和托管策略来源合并。完整字段、优先级、Provider 连接、模型故障转移、
权限、Hook、MCP 与沙箱配置请参考[配置文档](docs/configuration.md)。

请勿提交 API Key 或 `.zy/settings.local.json`。

## 开发

```bash
bun run format          # 格式化源码与测试
bun tsc --noEmit        # 类型检查
bun test                # 运行完整测试
bun run lint            # 运行 Biome 检查
bun run quality         # 运行完整本地质量门禁
```

相关文档：

- [架构说明](docs/architecture.md)
- [开发规范](docs/development-guidelines.md)
- [配置参考](docs/configuration.md)
- [Feature Flags](FEATURE_FLAGS.md)
- [更新日志](CHANGELOG.md)

主要目录：

```text
src/entrypoints/   CLI、SDK 与 MCP 入口
src/cli/           CLI 启动、参数、命令与传输层
src/components/    Ink/React 终端界面
src/commands/      交互式斜杠命令
src/tools/         Agent 工具及其 UI/Prompt 定义
src/services/      模型、API、MCP、沙箱、设置及其他领域服务
src/state/         应用共享状态
src/i18n/          英文与简体中文界面翻译
packages/          浏览器和计算机操作相关工作区包
tests/             与源码目录对应的测试
```

## 参与贡献

欢迎提交 Issue 和 Pull Request。提交修改前请：

1. 阅读 `AGENTS.md` 和[开发规范](docs/development-guidelines.md)。
2. 用户可见文本同时维护英文和简体中文翻译。
3. 运行 `bun run format`、`bun tsc --noEmit` 和相关的 `bun test`。
4. 不要手动修改 `dist/` 中的生成文件。

报告安全问题时，请勿在公开 Issue 中包含凭证、私有代码或漏洞利用细节；请私下联系维护者。

## 许可证

ZY Code 基于 [MIT License](LICENSE) 开源。
