# zy-code TODO Stub 与 Claude Code 二进制对照分析

> 分析时间：2026-06-01
> 对照对象：`@anthropic-ai/claude-code`（v24.14.1 npm 全局包，`claude.exe` 大小约 205 MB）
> 提取方式：`grep -aob` 字节定位 + `dd | tr -d '\0'` 抽取 + 上下文比对

## 概述

zy-code 当前在 4 个文件中遗留了 5 处 TODO 形态的 stub。本次将每一处都到 Claude Code 二进制中查找对应实现并比对。结论：

| TODO 项 | Claude Code 是否已实现 | 备注 |
|---|---|---|
| outsideRepl `prompt` stop hook | ❌ 未实现 | CC 二进制中存在完全相同的兜底字符串 |
| outsideRepl `agent` stop hook | ❌ 未实现 | CC 二进制中存在完全相同的兜底字符串 |
| marketplace `npm` 源 | ❌ 未实现 | CC 二进制中存在完全相同的 throw 字面量 |
| `installedPluginsManager` 缓存清理 | ✅ 已实现 | CC 中能检索到 `getInstalledPlugins / installSelectedPlugins / findMissingPlugins / checkEnabledPlugins / getPluginInventory / computePluginTokenCost` 一整套函数 |
| 通过 API error 探测 thinking 能力 | ✅ 已实现 | CC 中用两条正则匹配错误响应：`thinking\.type[^a-z]{1,8}(enabled|adaptive)[^]*?not supported` 与 `\b(adaptive) thinking is not supported` |

---

## 1. REPL 外部 Prompt Stop Hook

### zy-code 现状

[outsideRepl.ts#L180-L188](file:///Users/zy979/IdeaProjects/zy-code/src/utils/hooks/outsideRepl.ts#L180-L188)

```ts
// TODO: 实现 REPL 外部的 prompt stop hook
if (hook.type === 'prompt') {
  return {
    command: hook.prompt,
    succeeded: false,
    output: 'Prompt stop hooks are not yet supported outside REPL',
    blocked: false,
  }
}
```

### Claude Code 二进制对应内容

字节偏移 `120068336` 处命中（共 2 处，第二处是 sourcemap 重复区）：

```
hook_type_unsupported  prompt  Prompt stop hooks are not yet supported outside REPL
```

上下文中并行的 hook 类型分发字面量集合：

```
callback / prompt / agent / function / mcp_tool / http
```

可见 CC 的 `executeHooksOutsideREPL` 同样是用 `hook.type` 分支表，而 `prompt` 分支只埋了 `hook_type_unsupported` 遥测事件 + 同一行兜底文案。**没有任何函数体调用**。

### 差异点

无功能差异。CC 主线同样未实现该路径。

### 补齐建议

短期保留 TODO 即可，与上游一致。若要主动补齐，思路是把 REPL 内部的 `executeStopHooks → executePromptHook` 路径抽出来：把当前会话的 messages 数组通过 `getAppState()?.messages` 取出（`outsideRepl.ts` 入参已有 `getAppState`），构造一次轻量 query 调用 LLM 生成 stop 决策。但 REPL 外部场景（session_end、notifications）通常不期望产生新的模型请求，需谨慎评估。

---

## 2. REPL 外部 Agent Stop Hook

### zy-code 现状

[outsideRepl.ts#L190-L198](file:///Users/zy979/IdeaProjects/zy-code/src/utils/hooks/outsideRepl.ts#L190-L198)

```ts
// TODO: 实现 REPL 外部的 agent stop hook
if (hook.type === 'agent') {
  return {
    command: hook.prompt,
    succeeded: false,
    output: 'Agent stop hooks are not yet supported outside REPL',
    blocked: false,
  }
}
```

### Claude Code 二进制对应内容

字节偏移 `120068976` 处命中：

```
agent  Agent stop hooks are not yet supported outside REPL
```

紧邻 `function` / `Function hook reached executeHooksOutsideREPL for ...` 等同源字面量，结构与 `prompt` 分支完全对称。

### 差异点

无功能差异。CC 主线同样未实现。

### 补齐建议

与 §1 同。要补齐需引入 sub-agent 调用栈（需要 `AgentTool` 调度器、coordinator、tool registry），在 REPL 外部环境复杂度更高。建议跟随上游节奏。

---

## 3. NPM Marketplace 源

### zy-code 现状

[marketplaceManager.ts#L1554-L1557](file:///Users/zy979/IdeaProjects/zy-code/src/utils/plugins/marketplaceManager.ts#L1554-L1557)

```ts
case 'npm': {
  // TODO: 实现 npm 包支持
  throw new Error('NPM marketplace sources not yet implemented')
}
```

### Claude Code 二进制对应内容

字节偏移 `101645152` 处命中：

```
NPM marketplace sources not yet implemented
```

紧邻其它 marketplace 源的处理字符串：

```
SSH not configured for GitHub, using HTTPS for ...
HTTPS git clone failed for marketplace ...
HTTPS clone failed, retrying with SSH: ...
HTTPS clone failed for ... falling back to SSH
SSH clone fallback also failed for ...
NPM marketplace sources not yet implemented   ← 当前 TODO
.claude-plugin / marketplace.json / settings   ← git/file/directory/settings 源支持
Unsupported marketplace source type
Reading marketplace from ...
Marketplace file not found at ...
```

### 差异点

无功能差异。CC 当前对外发布的版本依然只支持 `git / file / directory / settings` 四种源类型，npm 同样以 throw 短路。

### 补齐建议

无需先于上游补齐。若必须自行实现，标准流程是：

1. `npm pack <pkg>@<version>` 拉取 tarball 到临时目录；
2. 解压后定位 `package/.zy-plugin/marketplace.json`（与 `git` 源对齐目录结构）；
3. 复用现有 `parseFileWithSchema(PluginMarketplaceSchema())` 校验。

需要额外考虑 npm registry 鉴权（私有源走 `.npmrc`）、版本锁定与缓存淘汰，工作量明显大于 git 源。

---

## 4. installedPluginsManager 缓存

### zy-code 现状

[pluginLoader.ts#L2998](file:///Users/zy979/IdeaProjects/zy-code/src/utils/plugins/pluginLoader.ts#L2998)

```ts
export function clearPluginCache(reason?: string): void {
  ...
  loadAllPlugins.cache?.clear?.()
  loadAllPluginsCacheOnly.cache?.clear?.()
  ...
  clearPluginSettingsBase()
  // TODO: 当 installedPluginsManager 实现时清除已安装插件缓存
}
```

### Claude Code 二进制对应内容

字节偏移 `77839328` 处命中导出符号表，相邻函数密集出现，足以勾勒出整套 manager 的形状：

```
skillIndexCacheKey
getSkillIndex
clearSkillIndexCache
settingSourceToScope
isPersistableScope
installSelectedPlugins
getPluginEditableScopes
getInstalledPlugins         ← 已安装插件查询
findMissingPlugins          ← 找出未安装的依赖
checkEnabledPlugins         ← 校验启用状态
scaleCharsToTokens
getPluginInventory          ← 已安装清单（含 token 估算）
computePluginTokenCost
formatVersion
formatAll
ReleaseNotesPicker
renameSystemReminder
performRename
...
```

另一处 `204744962` 等多个偏移命中 `installedPlugins` 字段名，与 `pendingUpdate / pluginCount / updateCount / removeCount / hasPendingActions / onManageComplete` 共同出现，说明 CC 已经实现完整的「已安装插件管理面板」UI 状态机。

### 差异点

CC 已经将 manager 落地（含 inventory、安装/找缺/启用校验/版本格式化/重命名提醒），并把 `installedPlugins` 缓存纳入 `clearPluginCache` 的清理范围（具体字节偏移因 minify 难以精确定位，但符号链路完整）。

zy-code 这一侧只 fork 自 v2.1.88（彼时 manager 尚未完全成型），后续 CC 在主线持续补齐，zy-code 滞后。

### 补齐建议

这是**最值得跟进的一项**。建议分两步：

1. **先建空壳模块**：新建 `src/services/plugins/installedPluginsManager.ts`，导出 `getInstalledPlugins() / findMissingPlugins() / checkEnabledPlugins() / clearInstalledPluginsCache()`，先用空集合实现，让 `clearPluginCache` 可以解除 TODO。
2. **后续逐项填充**：
   - `getInstalledPlugins`：扫描 `~/.zy/plugins/installed/` 与 `enabledPlugins` settings；
   - `findMissingPlugins`：对比 marketplace 中 enabledPlugins 缺失项；
   - `checkEnabledPlugins`：校验 enabled list 与已安装目录是否一致；
   - `clearInstalledPluginsCache`：在 `clearPluginCache` 末尾调用，保证 settings 变更后的缓存一致性。

---

## 5. 通过 API Error 探测 Thinking 能力

### zy-code 现状

[thinking.ts#L84-L95](file:///Users/zy979/IdeaProjects/zy-code/src/utils/thinking.ts#L84-L95)

```ts
// TODO(inigo): add support for probing unknown models via API error detection
// 按 provider 感知的 thinking 支持检测
// @[MODEL LAUNCH]: 将新模型添加到 ~/.zy/model-capabilities.json
export function modelSupportsThinking(model: string): boolean {
  // ~/.zy/model-capabilities.json 本地配置优先
  if (localModelHasCapability(model, 'thinking')) {
    return true
  }
  // 未知模型：根据 Provider 能力决定
  const provider = getAPIProvider()
  return providerHasCapability(provider, 'thinking')
}
```

### Claude Code 二进制对应内容

字节偏移 `86991165` 处命中两条 API 错误探测正则：

```
thinking\.type[^a-z]{1,8}(enabled|adaptive)[^]*?not supported
\b(adaptive) thinking is not supported
```

附近还伴生：

```
signature in thinking block
thinking block
`thinking`
redacted_thinking
cannot be modified
invalid signature
anthropic-beta
Unexpected role
input message role
not supported
role .{0,2}system
apiErrorStatus
request_id
```

这表明 CC 在收到 API 错误响应（`apiErrorStatus` 或 4xx body）后，会把 `error.message` 走这两条正则：

- 第一条匹配类似 `"thinking.type: enabled is not supported on this model"` 形态；
- 第二条匹配 `"adaptive thinking is not supported"`。

匹配中后即把当前 model 的 `thinking` / `adaptive_thinking` 能力**动态降级写入运行时缓存**（与 `model-capabilities.json` 形成互补：本地白名单优先，API error 用作运行时反向探测）。

### 差异点

| 维度 | zy-code | Claude Code |
|---|---|---|
| 本地 capability 表 | ✅ `~/.zy/model-capabilities.json` | ✅ `~/.claude/model-capabilities.json` |
| Provider 默认能力推断 | ✅ `providerHasCapability` | ✅（同源） |
| **API error 反向探测** | ❌ TODO(inigo) | ✅ 两条正则 + 运行时降级 |

### 补齐建议

这是**实现成本最低、收益最高**的一项。补齐步骤：

1. 在 `src/services/api/` 下新建 `modelCapabilityProbe.ts`，导出 `probeThinkingFromError(model: string, error: unknown): void`；
2. 内部维护 `Map<string, { thinking?: false; adaptive_thinking?: false }>` 运行时降级表；
3. 拦截 `LLMError`（`isAPIError(error) === true`）后，对 `error.message` 应用上述两条正则：
   ```ts
   const RE_THINKING_NOT_SUPPORTED = /thinking\.type[^a-z]{1,8}(enabled|adaptive)[^]*?not supported/
   const RE_ADAPTIVE_NOT_SUPPORTED = /\b(adaptive) thinking is not supported/
   ```
4. 命中后写入降级表；
5. `modelSupportsThinking()` / `modelSupportsAdaptiveThinking()` 在「本地配置」与「provider 默认」之间插入「运行时降级表」一层。

---

## 总结

> 最后更新：2026-06-06

| 优先级 | TODO 项 | 状态 | 说明 |
|---|---|---|---|
| ~~🟢 高~~ | ~~API error 探测 thinking~~ | ✅ 已完成 | 2026-06 实现 `src/services/api/modelCapabilityProbe.ts`，含 7 个测试 |
| ~~🟡 中~~ | ~~installedPluginsManager 缓存~~ | ✅ 已完成 | `src/utils/plugins/installedPluginsManager.ts` 已存在 |
| ⚪ 低 | NPM marketplace 源 | ❌ 未做 | 与 CC 上游持平（同为 throw stub），暂缓 |
| ⚪ 低 | Prompt / Agent stop hook (outsideRepl) | ❌ 未做 | 与 CC 上游持平（同为兜底字符串），跟随上游 |

剩余 2 项均为低优先级，与 Claude Code 主线保持一致（都未实现）。无需主动补齐。
