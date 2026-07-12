# CC 2.1.207 对齐更新计划

> 基于 2026-07-11 发布的 Claude Code 2.1.207（24 项变更）与 ZY Code 源码对比分析。
>
> **文档修订**：
> - 初版：Web 信息 + 二进制粗扫 + 源码静态分析（`main@afbfd107`）
> - **补全（2026-07-12）**：`extract-claude-internal` 深度提取（本机 `claude.exe` 2.1.207，~238MB）+ Auto 门控 / shell 注入 / 滚动流式 三子系统对照；发现多处初版结论需修正，见 [§九 分歧标注](#九分歧标注与修订记录)。
>
> **当前基线**：ZY Code `main@1f04ac3c` · CC `2.1.207` · 二进制 `D:\nvm\nvm4w\nodejs\node_global\node_modules\@anthropic-ai\claude-code\bin\claude.exe`
>
> **实现进度（2026-07-12）**：#1–#9、#12–#13 已落地；#10/#11 Remote Control 延后；#14 已有足够防护；#15 多数 N/A/延后。

---

## 目录

- [变化分类总览](#一变化分类总览)
- [P0 — 安全与可靠性](#二p0--安全与可靠性)
- [P1 — 用户可见 UX](#三p1--用户可见-ux)
- [P2 — 后台系统与开发者体验](#四p2--后台系统与开发者体验)
- [P3 — 边缘修复与排查](#五p3--边缘修复与排查)
- [Feature Flags & 环境变量](#六feature-flags--环境变量)
- [遥测事件新增](#七遥测事件新增)
- [优先级实施路线图](#八优先级实施路线图)
- [分歧标注与修订记录](#九分歧标注与修订记录)
- [附录：分析细节](#十附录分析细节)
- [附录：三子系统深度对照](#十一附录三子系统深度对照)

---

## 一、变化分类总览

| 类别 | CC 变更数 | ZY Code 现状 | 对齐工作量 |
|------|----------|-------------|-----------|
| Auto Mode 变更 | 3 | 门控/熔断/`disableAutoMode` **已有**；**信任源过滤不完整** | 中（收紧源，非从零） |
| 安全修复 (Plugin) | 2 | exec form / env 已有；**shell-form 仍展开 user_config** | 高（小改但 P0） |
| 终端/流式修复 | 2 | StreamingMarkdown + blit + 虚拟滚动 **主体已有** | 低（回归/边角） |
| Worktree 修复 | 1 | **缺失** worktreeConfig 清理 | 中 |
| 后台 Agent 修复 | 3 | 部分实现 | 中 |
| 远程控制修复 | 2 | **部分实现** | 中 |
| 权限系统修复 | 3 | 部分实现 | 低 |
| UI/UX 改进 | 2 | 需要评估 | 低 |
| Deep Research | 1 | N/A（ZY 无此功能） | N/A |
| AWS/Bedrock 修复 | 2 | N/A（不同 provider） | N/A |
| 用量/安装修复 | 2 | 需要评估 | 低 |
| **合计** | **24** | — | — |

**2.1.207 本质**：无全新算法架构；重点是 **信任边界收紧 + shell 注入硬拒绝 + 长内容流式布局修补 + 默认放宽（云侧 Auto）**。

---

## 二、P0 — 安全与可靠性

### #1 `${user_config.*}` Shell-Form 注入修复

> **状态：✅ 已落地**（`commandRunner.ts` + `containsUserConfigRef` + i18n + 单测）

**CC 2.1.207 变更**（CC 二进制偏移：`126892546` shell 拒绝文案；`105515199` headersHelper 一带）：

```
Plugin hooks/monitors/MCP headersHelper:
${user_config.*} in shell-form commands is now rejected (shell-injection fix).
Hooks must use exec form (args array) or $CLAUDE_PLUGIN_OPTION_<KEY>;
monitors and headersHelper should read values inside the script.
```

**CC 提取原文（还原）**：

```text
Hook from <plugin> references ${user_config.*} in a shell-form command.
The substituted value would be re-parsed by the shell.
Use exec form: {"command": "<executable>", "args": ["${user_config.KEY}", ...]}
or read $CLAUDE_PLUGIN_OPTION_<KEY> from the hook's environment.

plugin hook references ${user_config.*} in shell-form command
```

- shell-form：整串 `command` 交给 shell → **禁止** `${user_config.*}`（值会二次解析）
- exec form：`args` 数组字面传递 → 允许展开
- 或脚本内读 `$CLAUDE_PLUGIN_OPTION_<KEY>`（已注入 env）

**ZY Code 现状**（2026-07-12 复核）：

| 维度 | 状态 | 文件 | 行号 |
|------|------|------|------|
| `substituteUserConfigVariables()` | ✅ 已有 | `src/services/plugins/pluginOptionsStorage.ts` | L330–344 |
| `substituteUserConfigInContent()`（skill 脱敏） | ✅ 已有 | 同上 | L359–373 |
| `$CLAUDE_PLUGIN_OPTION_<KEY>` 注入 | ✅ 已有 | `src/services/hooks/commandRunner.ts` | L659–669 |
| **Shell-form vs exec-form 分支** | ✅ **已有** | `commandRunner.ts` | L735–756（`hook.args !== undefined` → `spawn(cmd, args)`；否则 `shell: true`） |
| shell-form 仍做 user_config 展开 | ⚠️ **危险** | `commandRunner.ts` | L610–616（在 spawn 前无条件 `substituteUserConfigVariables`） |
| `${user_config.*}` 在 **shell-form** 中的拒绝 | ❌ **缺失** | — | — |
| exec form 对 `args[]` 逐项 substitute | ⚠️ 待确认 | exec 路径用已展开的 `command`，`args` 是否展开需核对 | L740 |
| headersHelper 不做 user_config 模板展开 | ✅ 合理 | `src/services/mcp/headersHelper.ts` | 直接 `execFile` 脚本 |
| `$CLAUDE_PLUGIN_OPTION_*` 文档醒目度 | ⚠️ 弱 | `schemas.ts` | L562–588 |

> **分歧**：初版写「Shell-form vs exec-form 分支检测 ❌ 缺失」——**错误**。分支已存在；缺口仅是 **shell-form 路径未拒绝 user_config 展开**。

**对齐方案**：

| # | 文件 | 改动 | 估计工时 |
|---|------|------|---------|
| 1 | `src/services/hooks/commandRunner.ts` | **仅**在 `hook.args === undefined`（shell-form）时：若 `command` 含 `${user_config.*}` → 抛错（文案对齐 CC）；**且** shell-form 不再调用 `substituteUserConfigVariables` | 2h |
| 2 | 同上 | exec form：对 `command` 与 `args[]` 做 substitute（argv 安全） | 1h |
| 3 | `src/services/plugins/pluginOptionsStorage.ts` | 导出 `containsUserConfigRef(s: string): boolean` | 0.5h |
| 4 | `src/services/plugins/schemas.ts` + i18n | 安全说明 + `pluginErrors.userConfigShellForm` | 0.5h |
| 5 | tests | shell-form 含 `"; id"` 的 user_config 必须失败；exec form 通过 | 1h |

**伪代码**：

```ts
const USER_CONFIG_REF = /\$\{user_config\.[^}]+\}/
if (hook.args === undefined && USER_CONFIG_REF.test(hook.command)) {
  throw new Error(
    `Plugin hook references \${user_config.*} in a shell-form command. ` +
    `Use exec form {"command":"...","args":["\${user_config.KEY}",...]} ` +
    `or read $CLAUDE_PLUGIN_OPTION_<KEY>.`,
  )
}
// shell-form: 不要 substituteUserConfigVariables(command)
// exec form: substitute command + each arg
```

---

### #2 `pluginConfigs` 作用域限制

> **状态：✅ 已落地**（`loadTrustedPluginConfigOptions` / `TRUSTED_PLUGIN_CONFIG_SOURCES`；写路径仅 userSettings）

**CC 2.1.207 变更**（偏移：`93756216`, `103127366`, `229652700`）：

```
Plugin option values (pluginConfigs) are no longer read from
project-level .claude/settings.json; only user, --settings,
and managed settings are honored.
```

CC 可信源（初版提取 + 复核一致）：

```js
// Trusted sources for pluginConfigs
["userSettings", "flagSettings", "policySettings"]
// projectSettings / localSettings 显式排除
```

**ZY Code 现状**：

| 维度 | 状态 | 文件 | 行号 |
|------|------|------|------|
| `SETTING_SOURCES` | ✅ 5 源 | `src/utils/settings/constants.ts` | L8–23 |
| `pluginConfigs` schema | ✅ | `src/utils/settings/types.ts` | L925 |
| **读路径** `loadPluginOptions` | ❌ 用 **merged** `getInitialSettings()` | `pluginOptionsStorage.ts` | L49–51 |
| **写路径** | ✅ 只写 `userSettings` | 同上 | L170 |
| 已知 TODO | ⚠️ 已注释 merge 泄漏风险 | 同上 | L145–150 |

**风险**：恶意 PR 在 `.zy/settings.json`（project）写入 `pluginConfigs` → 合并进 `loadPluginOptions` → 改变 hook/MCP 行为。

**对齐方案**：

| # | 文件 | 改动 | 估计工时 |
|---|------|------|---------|
| 1 | `settings.ts` | `getSettingsForSources(sources, pick)` 或专用 `getTrustedPluginConfigs()` | 1.5h |
| 2 | `pluginOptionsStorage.ts` | 只合并 user/flag/policy 的 `pluginConfigs[pluginId].options` | 1h |
| 3 | `types.ts` | JSDoc：pluginConfigs 不读 project/local | 0.5h |

---

### #2b Auto Mode 信任源收紧（**提升为 P0**）

> **状态：✅ 已落地**（`TRUSTED_AUTO_MODE_SOURCES`、`hasTrustedDefaultModeAuto`、`getAutoModeConfig` 去 local、`hasAutoModeOptIn` 去 local、遥测 `zy_settings_auto_mode_untrusted_source_ignored`）
>
> **分歧**：初版将 Auto settings 源变更放在 P1 `#3`。深度对照后，与 `#2 pluginConfigs` 同源（**repo 可控授予高权限**），应 **P0**。`#3` 保留作 UX/文案/遥测补充，实现与本条合并。

**CC 2.1.207**：

1. `autoMode` 规则 / classifier 配置：**不再读** `.claude/settings.local.json`；应用户/flag/managed
2. `defaultMode: "auto"`：仅 policy/user/flag 可授予；project/local 触发 untrusted 忽略  
   字符串：`settings defaultMode "auto" ignored — only policy/user/flag settings may grant auto mode (projectSettings and localSettings are repo-controllable)`  
   事件：`tengu_settings_auto_mode_untrusted_source_ignored`（@ `95087608` / `226980850`）  
   > **分歧**：初版事件名写成 `tengu_settings_auto_mode_rules_untrusted_source_ignored`（多了 `_rules`）。二进制实测为 **`tengu_settings_auto_mode_untrusted_source_ignored`**。

**ZY Code 现状**：

| 维度 | 状态 | 位置 | 说明 |
|------|------|------|------|
| `verifyAutoModeGateAccess` | ✅ | `permissionSetup.ts` L1014+ | 与 CC 几乎 1:1（`zy_auto_mode_config`） |
| `disableAutoMode` | ✅ **已有** | `types.ts` L141/L1151；`isAutoModeDisabledBySettings` L1164–1170 | 值为 `z.enum(['disable'])`，非 boolean |
| `getAutoModeConfig()` | ⚠️ **部分** | `settings.ts` L852–889 | 已排除 **project**；仍读 **localSettings** |
| `hasAutoModeOptIn()` | ⚠️ **部分** | L826–836 | 排除 project；仍读 **local** |
| `permissions.defaultMode === 'auto'` | ❌ 读 **merged** | `permissionSetup.ts` L701–728 | project/local 可静默开 auto |
| untrusted 遥测 | ❌ | — | |

**对齐方案**（与原 `#3` 合并实施）：

| # | 文件 | 改动 | 估计工时 |
|---|------|------|---------|
| 1 | `settings.ts` | `getAutoModeConfig()` 源改为 **仅** user/flag/policy（去掉 local） | 1h |
| 2 | `settings.ts` | `hasAutoModeOptIn()` 去掉 local | 0.5h |
| 3 | `permissionSetup.ts` | `defaultMode: auto` 按源读取；忽略 project/local + log/event | 1h |
| 4 | telemetry | `zy_settings_auto_mode_untrusted_source_ignored` | 0.5h |

---

## 三、P1 — 用户可见 UX

### #3 Auto Mode：设置与云默认（实现并入 #2b）

**CC 2.1.207 变更**：

```
Auto mode no longer reads autoMode from .claude/settings.local.json
(repo-resident); use ~/.claude/settings.json instead.

Auto mode available without CLAUDE_CODE_ENABLE_AUTO_MODE on
Bedrock / Vertex / Foundry; disable via disableAutoMode.
```

**门控字符串（CC @ `~141566600`）**：

```text
verifyAutoModeGateAccess: enabledState= … disabledBySettings= … model= …
  modelSupported= … carouselAvailable= … canEnterAuto= …
auto mode disabled: disableAutoMode in settings
auto mode disabled: tengu_auto_mode_config.enabled === "disabled" (circuit breaker)
auto mode disabled: provider <X> requires the CLAUDE_CODE_ENABLE_AUTO_MODE opt-in
auto mode disabled: model <M> does not support auto mode
kickOutOfAutoIfNeeded …
```

**ZY 已对齐部分**（初版未充分写清）：

- `verifyAutoModeGateAccess` / `canEnterAuto` / `carouselAvailable` / `kickOutOfAutoIfNeeded`
- GrowthBook `zy_auto_mode_config`：`enabled | disabled | opt-in`
- `disableAutoMode`（enum `'disable'`）
- 文案：`auto mode disabled by settings` / plan / model
- `classifyAllShell`（2.1.205 对齐已完成）
- critique CLI：`cli/handlers/autoMode.ts`

**ZY 与 CC 差异（N/A 或产品选择）**：

| 项 | CC | ZY | 处理 |
|----|-----|-----|------|
| Provider 维度 opt-in | Bedrock/Vertex/Foundry 2.1.207 免 env | 无同等 3P 矩阵 | **N/A**；用 GB `enabled`/`opt-in` + `ZY_CODE_DEV_AUTO_MODE` |
| 默认 `AUTO_MODE_ENABLED_DEFAULT` | 历史上偏 opt-in | 代码默认 `'enabled'`（L1213） | 产品决策；冷启动更开放 |
| 云默认 Opus 4.8 | Bedrock/Vertex/Platform AWS | 非目标 | N/A |

**本项剩余工作**：见 **#2b**（信任源）。勿再「新增 disableAutoMode schema」。

---

### #4 终端流式传输：长列表/表格/代码块冻结修复

> **状态：✅ 已落地**（2026-07-12）
> - `advanceStreamingMarkdownBoundary`（`utils/markdown.ts`）抽出 + 长 list/table/fence 回归测
> - `StreamingMarkdown` 改用纯函数边界推进
> - `computeScrollFollow` + `scrollHeightHwm`（触底跟随 / 高度回落不回跳）
> - 测试：`tests/utils/markdown-streaming-boundary.test.ts`、`tests/ink/sticky-scroll-follow.test.tsx`

**CC 2.1.207 变更**：

```
Fixed terminal freezing and keystroke lag during streaming of
long lists, tables, paragraphs, or code blocks.
```

**CC 渲染管线锚点**（补全扫描）：

| 锚点 | 偏移（约） | 含义 |
|------|-----------|------|
| `scrollAnchor` / `stickyScroll` / `followGrowth` / `scrollHeightHwm` | `99007872` / `228296*` | 滚动锚定与增高跟随 |
| `skipSelfBlit` / `prevScreen` | `99007664` / `228403976` | 脏矩形 blit |
| `scheduleRender` | `186105088` / `228421713` | 渲染调度 |
| `virtualize` + fullscreen schema | `93731082` | 虚拟化 scrollback |
| `StreamingText` / `isStreaming` | `141900346` | 流式状态 |
| `measureCache` / `MAX_MARKDOWN` | `98258728` / `90252128` | 测量/上限 |

历史铺垫：2.1.191 流式 ~100ms coalesce；2.1.203 live-preview 不全屏 re-render；2.1.207 修 **list/table/paragraph/fence** 流式未闭合时的布局爆炸。

**ZY Code 现状**（远比初版「仅 SYNCHRONIZED_UPDATE」完整）：

| 维度 | 状态 | 位置 |
|------|------|------|
| `SYNCHRONIZED_UPDATE` | ✅ | `ink/termio/dec.ts`；`staticRender.tsx` |
| `StreamingMarkdown` stable/unstable 前缀 | ✅ **关键** | `components/Markdown.tsx` L155–200 |
| `skipSelfBlit` / `prevScreen` blit | ✅ | `ink/render-node-to-output.ts` L369–456 |
| `stickyScroll` + 触底 `grew` 判断 | ✅ | render L704–739（无独立 `followGrowth` 字段，语义内嵌） |
| `scrollAnchor` | ✅ | `ink/dom.ts` L79；`ScrollBox.tsx` |
| `pendingScrollDelta` 限速 drain | ✅ | dom + frame + render |
| `scrollClampMin/Max` | ✅ | `dom.ts` |
| `scheduleRender` 16ms 帧 | ✅ | `ink.tsx` + `FRAME_INTERVAL_MS=16` |
| `VirtualMessageList` | ✅ | `components/VirtualMessageList.tsx`；`Messages.tsx` |
| `MessageRow` memo 跳过静态行 | ✅ | `MessageRow.tsx` L324–334 |
| `scrollHeightHwm` | ❌ 无独立字段 | 仅用 `prevScrollHeight` 单帧对比 |
| 业务层 text delta 100ms coalesce | ⚠️ 未专项确认 | 渲染帧合并有；query 层 setState 频率待审计 |
| 2.1.207 专项回归测 | ❌ | 应用大 table/list/code 流式压测 |

> **分歧**：初版把本项写成「审查瓶颈 + 考虑批次节流」（偏 greenfield）。实际 **主体已对齐**，工作重心是 **回归测试 + 可选 HWM/coalesce 审计**。

**对齐方案**：

| # | 改动 | 估计工时 |
|---|------|---------|
| 1 | 回归：流式超长 list / GFM table / fence 时 keypress 延迟阈值 | 2h |
| 2 | 回归：stream complete 后 transcript 不跳到答案起点之上 | 1h |
| 3 | （可选）`scrollHeightHwm` 跨帧高度 | 1h |
| 4 | （可选）审计 assistant text setState 频率，必要时 100ms coalesce | 2h |

---

### #5 Worktree：`extensions.worktreeConfig` 残留清理

> **状态：✅ 已落地**（`maybeUnsetWorktreeConfigExtension`；`cleanupWorktree` / `removeAgentWorktree` 调用）

**CC 2.1.207 变更**（偏移：`104470952`）：

```
Fixed extensions.worktreeConfig being left in .git/config
(breaking go-git tools like tea) after the last
worktree.sparsePaths worktree was removed.
```

```
git config --local --get extensions.worktreeConfig
git config --local --unset extensions.worktreeConfig  # 最后一个 sparse worktree 删除后
```

**ZY Code 现状**：

| 维度 | 状态 | 文件 | 行号 |
|------|------|------|------|
| Worktree 创建（含 sparse） | ✅ | `src/services/worktree/worktree.ts` | L280–350 |
| Worktree 清理 | ✅ | 同上 | L763–830 |
| `extensions.worktreeConfig` 清理 | ❌ | — | — |
| 稀疏 worktree 计数 | ❌ | — | — |

**对齐方案**：

| # | 文件 | 改动 | 估计工时 |
|---|------|------|---------|
| 1 | `worktree.ts` | `cleanupWorktree()` 后 `git worktree list --porcelain` 计剩余 sparse | 0.5h |
| 2 | 同上 | 剩余 0 时 `git config --local --unset extensions.worktreeConfig` | 0.5h |
| 3 | 同上 | `cleanupWorktreeConfig()` + 日志 | 0.5h |

---

### #6 Agent View：重复粘贴展开 + 阻塞 Peek 改进

> **状态：✅ 已落地**（2026-07-12）
> - 同文本再粘贴 → 展开已有 `[Pasted text #N]`（`inputPaste.ts` + `PromptInput.onTextPaste`）
> - blocked peek：问题优先 + `waiting 3m`（`getBlockedPeekSummary` / `formatWaitingDuration`）
> - 测试：`inputPaste.test.ts`、`blockedPeek.test.ts`、`format-waiting.test.ts`

**CC 2.1.207 变更**：

```
1. Pasting the same text again expands collapsed [Pasted text #N]
   instead of adding a second one
2. Blocked session peeks lead with the question + worded staleness
   (waiting 3m) instead of the same timestamp twice
```

CC 锚点：`"Pasted text #"` @ `99778105`；`waiting ` / staleness 相关字符串。

**ZY Code 现状**：
- 审查 `src/hooks/useTextInput.ts` 粘贴/折叠
- 审查 Agent View session peek

**对齐方案**：

| # | 文件 | 改动 | 估计工时 |
|---|------|------|---------|
| 1 | `useTextInput.ts` 等 | 同文本再粘贴 → 展开已有 placeholder | 1–2h |
| 2 | Agent View 组件 | peek 文案：问题优先 + `waiting 3m` | 1–2h |

---

## 四、P2 — 后台系统与开发者体验

### #7 后台 Agent Team：Crash Loop 修复

> **状态：✅ 已落地**（2026-07-12）
> - `isValidTeammateMessage` 过滤畸形条目并写回干净数组
> - 非法 JSON / 非数组 → quarantine 备份 + 重置 `[]`，避免 poll 每秒 logError
> - 测试：`tests/utils/teammateMailbox.test.ts`

**CC**：malformed teammate mailbox 每秒重试直至手动删文件。  
**CC 锚点**：`mailbox` @ `112506890`；`skipping malformed` @ `103514889` 等。

### #8 后台 Session：Worktree 恢复空白

> **状态：✅ 已落地（缓解）**（2026-07-12）
> - `getAgentTranscriptPathCandidates`：sessionProjectDir / originalCwd / cwd 多路径尝试
> - `getAgentTranscript` 依次加载候选路径
> - agent-view bootstrap：taskId 失败时再试 `task.agentId`
> - 测试：`agentTranscriptPaths.test.ts`

### #9 后台 Session：自动命名显示

> **状态：✅ 已落地**（2026-07-12）
> - `getAgentDisplayName` 优先 `description` / `progress.summary`（plan accept / Agent 启动描述）

### #10 Remote Control：桌面端进度可见性

> **状态：⏸️ 延后** — 需对照 CC bridge 事件协议与桌面端消费方；ZY `bridge/` 已有 task 状态上报骨架，完整对齐需产品侧验收。

### #11 Remote Control：断连后任务状态丢失

> **状态：⏸️ 延后** — 与 #10 同属 bridge 重连快照，建议单独专项。

---

## 五、P3 — 边缘修复与排查

### #12 权限：非交互式静默同意修复

> **状态：✅ 已落地**（2026-07-12）
> - `SecurityCheckResult` 新增 `deferred_non_interactive`
> - 非交互 + 危险设置变更：会话内可用，**不** `saveSettings` 落盘为已同意
> - `shouldPersistManagedSettingsAfterSecurityCheck` + 单测

**CC**：`claude -p` / SDK 在未展示 security consent 时永久记录 remote managed settings 已同意。

### #13 权限：`cd` + 仅 `/dev/null` 重定向

> **状态：✅ 已落地**（2026-07-12）
> - `validateOutputRedirections`：compound cd 时若全部 redirect 为 `/dev/null` 则不 ask
> - 契约测试：`cdDevNullRedirect.test.ts`

### #14 虚假 Prompt-Injection 警告

> **状态：✅ 已有 / 无额外代码** — `sessionTitle.extractConversationText` 已跳过 `isMeta`；系统生成会话更新未走独立 injection-warn 路径。若后续新增 injection 告警 UI，需再加 isSynthetic 短路。

### #15 其他边缘修复

| 变更 | 状态 | 说明 |
|------|------|------|
| transcript 流结束上跳 | ✅ #4 | sticky + HWM |
| Auto-updater 外部 launcher | ⏸️ | 需 native installer 专项 |
| `/usage-credits` 金额 | N/A | ZY 无对等命令 |
| Malformed glob bracket | ⏸️ | 已有 `validateWorktreeSlug` 等；全量 glob 另开 |
| forceLoginOrgUUID / Bedrock SSO / Deep research | N/A | 3P/产品差异 |

---

## 六、Feature Flags & 环境变量

| 环境变量 / 设置 | CC 状态 | ZY Code 状态 | 说明 |
|-----------------|---------|-------------|------|
| `disableAutoMode` | schema（disable 枚举） | ✅ **已有** `z.enum(['disable'])` | 初版标缺失 → **已修正** |
| `CLAUDE_CODE_ENABLE_AUTO_MODE` | 2.1.207 对 3P 不再强制；surface 上有移除记录 | ZY 无对等 env；用 GB + `ZY_CODE_DEV_AUTO_MODE` | N/A |
| `CLAUDE_CODE_AWS_CHAIN_RESOLVE_TIMEOUT_MS` / 60s stall | 新增 | N/A | AWS 特定 |
| `ZY_CODE_AUTO_MODE_MODEL` | — | ✅ 已有 | 分类器模型 |

无强制新增 env；关键差异用 settings 源过滤解决。

---

## 七、遥测事件新增

| CC 遥测事件 | 说明 | ZY 状态 |
|------------|------|--------|
| `tengu_settings_auto_mode_untrusted_source_ignored` | auto/defaultMode 不可信源被忽略 | ❌ 需 `zy_settings_auto_mode_untrusted_source_ignored` |
| `skipped_external_launcher` | 外部启动器跳过清理 | ⚠️ 若有 native updater 可对齐 |
| （hook）`plugin hook references ${user_config.*} in shell-form` | 注入拒绝（log/error） | ❌ 随 #1 加 |

> 事件名以二进制实测为准，见 [§九](#九分歧标注与修订记录)。

---

## 八、优先级实施路线图

```
Sprint 1 — 安全基线（P0）  ~1–2d
  [#1]  shell-form 拒绝 ${user_config.*} + 测试
  [#2]  pluginConfigs 仅 user/flag/policy
  [#2b] autoMode / defaultMode:auto / opt-in 信任源收紧 + 遥测
  └── commandRunner + pluginOptionsStorage + settings + permissionSetup

Sprint 2 — 核心对齐（P1）  ~0.5–1d
  [#5]  worktreeConfig 残留清理
  [#4]  流式长内容回归（+ 可选 HWM）
  └── 独立可并行

Sprint 3 — UX（P1）  ~0.5–1d
  [#6]  paste 展开 + blocked peek 文案
  └── 独立

Sprint 4 — 后台可靠性（P2）  ~1d
  [#7][#8][#9] mailbox / worktree resume / auto-name
  [#10][#11] Remote Control
  └── 大部分独立

Sprint 5 — 边缘（P3）  ~0.5d
  [#12][#13][#14][#15]
  └── 全部独立；#12 若启用 remote managed 建议提前
```

### 估算总工时（修订）

| Sprint | 工时 | 相对初版 |
|--------|------|----------|
| Sprint 1 | ~8h | 含 #2b；#1 工时下调（exec 分支已有） |
| Sprint 2 | ~4h | #4 从「实现」改为「回归」 |
| Sprint 3 | ~3h | |
| Sprint 4 | ~6.5h | |
| Sprint 5 | ~3h | |
| **合计** | **~24.5h** | 与初版相近，**风险排序更准** |

**推荐 PR 顺序**：`#1 → #2 → #2b → #5 → #4 测试 → #6 → P2/P3`。

---

## 九、分歧标注与修订记录

| ID | 主题 | 初版结论 | 补全结论 | 处理 |
|----|------|----------|----------|------|
| D1 | shell-form / exec-form | 「分支检测 ❌ 缺失」 | **exec form 已存在**（`hook.args`）；缺的是 shell-form **拒绝** user_config | 已改正文 #1 |
| D2 | `substituteUserConfig` 命名/位置 | `substituteUserConfig` L1–70 | 实为 **`substituteUserConfigVariables` L330**；另有 `InContent` 变体 | 已改正文 |
| D3 | `disableAutoMode` | 「schema ❌ 缺失」需新增 | **已有** `z.enum(['disable'])` + `isAutoModeDisabledBySettings` | 删除「新增 schema」任务 |
| D4 | Auto 源过滤 | 「`getAutoModeConfig` 无源过滤」 | **已排除 project**，仍读 **local**；`defaultMode:auto` 用 merged 才是最大洞 | 拆 #2b；收紧 local |
| D5 | Auto 优先级 | 整项 P1 | 信任源收紧 **P0**（与 pluginConfigs 同级） | 路线图 Sprint 1 |
| D6 | 遥测事件名 | `tengu_settings_auto_mode_**rules**_untrusted_source_ignored` | 二进制：`tengu_settings_auto_mode_untrusted_source_ignored` | 以二进制为准 |
| D7 | 流式冻结工作量 | 偏 greenfield（批次/节流） | **StreamingMarkdown + blit + VList 已有**；做回归与边角 | 下调 #4 范围 |
| D8 | `user_config` 偏移 | `99392720`, `103001965` | 本机 2.1.207 确认 **`126892546`**（拒绝文案）；`105515199` headersHelper | 附录双记 |
| D9 | `disableAutoMode` 类型 | 文案写 `disableAutoMode: true` | ZY/CC 语义为 **`'disable'` 枚举**，非 boolean | 实现对齐 enum |
| D10 | Bedrock Auto 默认 | 需产品跟进 | ZY **无对等 provider 门控**；N/A | 不进实现清单 |

未解决 / 待二进制 diff 确认：

- 2.1.207 流式卡顿的 **精确函数级 diff**（需并排 2.1.206）
- exec form 是否已对 `args[]` 做 user_config 展开（实现 #1 时一并核对）

---

## 十、附录：分析细节

### A. 方法说明

1. 官方 changelog：https://code.claude.com/docs/en/changelog · GitHub release v2.1.207  
2. `@ClaudeCodeLog`：24 CLI 变更、2 system prompt 变更；bundle +120.5KB；surface 移除强制 `CLAUDE_CODE_ENABLE_AUTO_MODE` 入口  
3. `extract-claude-internal`：`node` 分块扫 249MB 二进制 → 偏移 → 上下文 / strings / js-ish 片段  
4. ZY 源码 `grep` + 精读 `permissionSetup` / `commandRunner` / `pluginOptionsStorage` / `Markdown` / ink render  

### B. 关键 CC 二进制偏移（2.1.207 本机复核）

| 特征 | 偏移 | 备注 |
|------|------|------|
| `disableAutoMode` schema | `93757088` | 与初版一致 |
| `autoMode` / 设置 | `94042505` | |
| `pluginConfigs` | `93756216`, `103127366`, `229652700` | |
| shell-form user_config 拒绝文案 | **`126892546`** | 初版 `103001965` 可能为邻近/旧扫 |
| headersHelper / user_config | `105515199` | |
| `verifyAutoModeGateAccess` 一带 | `141566600` / `141571545` | |
| untrusted auto 事件 | `95087608`, `226980850` | |
| `scrollAnchor` / sticky / follow | `99007872`, `228296946`, `228407418` | |
| `skipSelfBlit` | `99007664`, `228403976` | |
| `worktreeConfig` | `104470952` | |
| externally managed launcher | `115382100` | |
| `Pasted text #` | `99778105` | |
| `SYNCHRONIZED_UPDATE` | `98801144` | |
| `settings.local.json` | `93720295` | |

### C. 术语对照

| CC 2.1.207 | ZY Code | 路径 |
|------------|---------|------|
| `~/.claude/settings.json` | `userSettings` | `~/.zy/settings.json` |
| `.claude/settings.local.json` | `localSettings` | `.zy/settings.local.json` |
| `.claude/settings.json` | `projectSettings` | `.zy/settings.json` |
| `--settings` | `flagSettings` | CLI |
| managed / remote | `policySettings` | |
| `tengu_auto_mode_config` | `zy_auto_mode_config` | GrowthBook |
| `disableAutoMode: "disable"` | 同 enum | `types.ts` |
| `${user_config.*}` | `substituteUserConfigVariables` | `pluginOptionsStorage.ts` |
| `$CLAUDE_PLUGIN_OPTION_*` | 同名 env | `commandRunner.ts` L668 |
| `followGrowth` | 内嵌 `grew && atBottom` | `render-node-to-output.ts` |

### D. 参考资料

- [CC 官方 Changelog](https://code.claude.com/docs/en/changelog) · 2.1.207 (July 11, 2026)
- [GitHub Release v2.1.207](https://github.com/anthropics/claude-code/releases/tag/v2.1.207)
- ClaudeCodeLog / marckrenn cli-surface（env 面移除说明）
- 技能：`.zy/skills/extract-claude-internal/SKILL.md`
- 提取产物（本机）：`D:\grok\cc-extract-207\`
- 前序进度：`docs/progress/cc-v2.1.205-alignment.md`
- ZY 基线：`main@1f04ac3c`（初版分析时为 `afbfd107`）

---

## 十一、附录：三子系统深度对照

### A. Auto Mode 门控

```
CC 2.1.207 canEnterAuto ≈
  !disableAutoMode
  && config.enabled !== "disabled"
  && modelSupported
  && (provider 不在 opt-in 名单 || env)   // 3P 已放开

defaultMode/auto 来源：仅 policy | user | flag

ZY canEnterAuto ≈
  !disableAutoMode
  && zy_auto_mode_config.enabled !== "disabled"
  && modelSupported
  // 无 provider 维

defaultMode/auto：getInitialSettings() 全量合并  ← 缺口
getAutoModeConfig：user+local+flag+policy      ← local 仍过宽
```

| Feature | CC | ZY | Status |
|---------|----|----|--------|
| verifyAutoModeGateAccess | ✅ | `permissionSetup.ts` L1014 | ✅ |
| disableAutoMode | ✅ | types + isAutoModeDisabledBySettings | ✅ |
| circuit breaker | tengu_* | zy_auto_mode_config | ✅ |
| kickOutOfAutoIfNeeded | ✅ | ✅ | ✅ |
| defaultMode auto 源过滤 | 仅可信源 | merged | ❌ P0 |
| autoMode 规则去 local | ✅ 2.1.207 | 仍读 local | ⚠️ P0 |
| provider opt-in | 3P 放开 | N/A | N/A |

### B. Shell 注入 + pluginConfigs

```
CC: shell-form + ${user_config.*} → REJECT
    exec form args / $CLAUDE_PLUGIN_OPTION_* → OK

ZY: shell-form + substitute → shell:true  → 仍可注入  ← P0
    exec form hook.args → 已有
    pluginConfigs 读 merged → project 可污染        ← P0
```

### C. 滚动 / 流式

```
CC: Streaming path → partial markdown → yoga/blit → sticky/anchor → virtualize
ZY: StreamingMarkdown → MessageRow memo → skipSelfBlit → sticky/anchor → VirtualMessageList
```

主体 ✅；缺 2.1.207 专项回归与可选 HWM。架构对齐，非从零实现。

---

## 十二、与 2.1.205 对齐文档关系

`docs/progress/cc-v2.1.205-alignment.md` 已覆盖：`classifyAllShell`、Manual 默认、VirtualMessageList、MCP idle、doctor 等。

**2.1.207 增量只应做**：

1. 信任边界三件套（auto 源 / pluginConfigs 源 / shell user_config）  
2. worktreeConfig 清理  
3. 流式长内容 **验证**  
4. mailbox / remote / paste 等可靠性与 UX  

**不要**重做 auto classifier 或 Ink 虚拟滚动。
