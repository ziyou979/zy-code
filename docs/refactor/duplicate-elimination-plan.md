# 重复实现消除整改计划

> 基于代码库全量扫描确认的 19 处重复实现，按**影响面、风险、改动成本**三维度排序。每项给出：权威实现位置、需清理的重复位置、具体收敛动作、验收标准。

---

## 📋 总览表

| 优先级 | 类别 | 重复点 | 权威实现 | 涉及文件数 | 预估工时 |
|--------|------|--------|----------|------------|----------|
| **P0** | 行为不一致 | `/model` 命令双入口 | `constants/xml.ts` + `performModelChange.ts` | 3 | 1.5h |
| **P0** | 潜在 bug | `isNodeError` 守卫分叉 | `teamMemorySyncShared.ts` | 2 | 0.5h |
| **P1** | 数据完整性 | `apiKeyResponses.approved` 四处维护 | `auth.ts:saveApiKey` + `Config.tsx` | 4 | 2h |
| **P1** | 逻辑漂移 | token 粗估双轨 | `tokenEstimation.ts` | 2 | 2h |
| **P1** | 逻辑漂移 | 认证头构造四处 | `http/authHeaders.ts`（新建统一导出） | 4 | 1.5h |
| **P1** | 兼容风险 | OSC 8 链接六处 | `ink/termio/osc.ts:link()` | 6 | 1.5h |
| **P2** | 代码膨胀 | OpenAI `countTokens` 三份复制 | `shared/countTokens.ts`（新建） | 3 | 1h |
| **P2** | 代码膨胀 | `isUsingOAuth` 两处 | 统一到 `auth.ts` | 2 | 0.5h |
| **P2** | 维护负担 | keybindings async/sync 复制 | `parseKeybindingsCore.ts`（新建） | 1 | 1h |
| **P3** | 细微差异 | 视觉宽度 pad 三处 | `utils/truncate.ts:padVisual` | 3 | 0.5h |
| P3 | 细微差异 | truncate 按 code point | `utils/truncate.ts:truncateToWidth` | 2 | 0.5h |
| P3 | 代码膨胀 | wrapText 四实现 | `ink/wrapText.ts` | 4 | 1h |
| P3 | 代码膨胀 | 重试骨架四份 | `utils/retry.ts`（新建） | 4 | 1h |
| P3 | 常量分散 | `anthropic-version` 三处 | `constants/api.ts`（新建） | 3 | 0.5h |
| P3 | 规范违规 | 兼容 re-export | 删除别名 | 1 | 0.1h |
| P3 | 重复工具 | 时间戳格式化四处 | `utils/formatTimestamp.ts`（新建） | 4 | 0.5h |
| P3 | 重复常量 | `COMMON_HELP_ARGS` 两处 | `constants/xml.ts` | 2 | 0.1h |

> 共 **16 项**，总预估 **~15h**。建议分 3 个 PR 推进，避免单次改动过大。

---

## 🔴 P0：必须先改（有可见行为差异 / 潜在 bug）

### 1. `/model` 命令双入口收敛
**权威**：`src/constants/xml.ts:72` (`COMMON_INFO_ARGS` 13 项) + `src/commands/model/performModelChange.ts` (业务逻辑层)  
**清理**：
- `src/commands/model/model.tsx:185` 删除局部 `renderModelLabel`，改用 `performModelChange.ts` 导出的同名函数
- `performModelChange.ts:29` 删除局部 `COMMON_INFO_ARGS`，改 `import { COMMON_INFO_ARGS } from '../../constants/xml'`
- `performModelChange.ts:49,95,106` 硬编码文案全部改 `tSync('modelCommand.set'|'current'|'planModeOverride')`（需同步补 i18n key）
- `model.tsx:51,159` 已走 i18n，保持不动

**验收**：`zy /model view` 与 `zy -p "/model view"` 输出完全一致（含中文、样式、退出码）。

**测试要求**：
- 新增 `performModelChange.test.ts` 覆盖：info args 识别、模型设置文案、plan mode override 文案、i18n key 存在性
- 现有 `model.test.tsx` 补充：双入口输出一致性快照测试

---

### 2. `isNodeError` 守卫修复
**权威**：`src/services/team-memory-sync/teamMemorySyncShared.ts:48`  
**动作**：
```ts
// policy-limits/index.ts:48 替换为
export function isNodeError(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && 'code' in e && typeof e.code === 'string';
}
```
- 同步导入类型 `NodeJS.ErrnoException`（已在 team-memory 处引用）
- 删除 `teamMemorySyncShared.ts` 同名函数，改 `import { isNodeError } from '../policy-limits'`

**验收**：`bun tsc --noEmit` 无类型报错；单测覆盖 `code` 存在/缺失两种分支。

**测试要求**：
- `policy-limits.test.ts` 新增：`isNodeError` 对 `{ code: 'ENOENT' }`、`new Error()`、普通对象、`null` 的判断
- 确认 `team-memory-sync` 现有测试不受影响

---

## 🟠 P1：数据/逻辑一致性风险高

### 3. `apiKeyResponses.approved` 统一写入路径
**权威**：`src/services/auth/auth.ts:563 saveApiKey()`（去重 + 初始化 rejected）  
**动作**：
- `ApproveApiKey.tsx:15`、`ApiKeySetup.tsx:63` 删除内联 `config.set('apiKeyResponses.approved', …)`，改调用 `auth.saveApiKey(fingerprint)`
- `Settings/Config.tsx:1166` 保留（最严谨），但内部改复用 `saveApiKey` 避免双维护
- `auth.ts:581 isApiKeyApproved` 与 `Config.tsx:1038 getApiKeyStatus` 合并为 `auth.ts` 单一导出，Config 改 import

**验收**：同一 key 连点 5 次“批准”，配置里仅出现 1 条指纹；`rejected` 字段自动初始化为 `[]`。

**测试要求**：
- `auth.test.ts` 扩展：`saveApiKey` 幂等性、rejected 初始化、并发写入不重复
- `ApproveApiKey.test.tsx`、`ApiKeySetup.test.tsx`：mock `auth.saveApiKey` 验证调用参数
- `Config.test.tsx`：`getApiKeyStatus` 返回值与 `auth.isApiKeyApproved` 一致

---

### 4. token 粗估单轨化
**权威**：`src/services/tokenEstimation.ts`（注释完备、被 `analyzeContext.ts:70 countTokensWithFallback` 依赖）  
**动作**：
- `compact/microCompact.ts:141 calculateToolResultTokens`、`168 estimateMessageTokens` 删除，改 `import { roughTokenCountEstimationForMessage } from '../tokenEstimation'`
- 同步检查 `tokenEstimation.ts` 是否覆盖 microCompact 所有 block 类型（attachment、tool_result 递归等），补齐缺口
- 删除 `tokenEstimation.ts:24 countTokensViaHaikuFallback`（别名，已过时），`analyzeContext.ts` 已直接用 `countTokensWithFallback`

**验收**：`bun test` 覆盖 `tokenEstimation.test.ts` 全量通过；`microCompact.ts` 不再含估算逻辑。

**测试要求**：
- `tokenEstimation.test.ts` 补充：所有 block 类型（text、tool_use、tool_result、attachment、thinking）的估算值快照
- `microCompact.test.ts`：对比收敛前后同一输入消息数组的估算总 token 差异 < 1%
- `analyzeContext.test.ts`：`countTokensWithFallback` 回退链正常

---

### 5. 认证头构造统一导出
**权威**：新建 `src/services/http/authHeaders.ts` 统一导出 `getAuthHeaders(options)`  
**参数设计**：
```ts
interface AuthHeadersOptions {
  apiKey?: string;           // 可选，优先级最高
  oauthToken?: string;       // 可选，次之
  userAgent?: string;        // 可选，team-memory 需要
  betaHeader?: boolean;      // 可选，OAUTH_BETA_HEADER
}
```
**清理**：
- `policy-limits/index.ts:216`、`remote-managed-settings/index.ts:193` 删除实现，改 import
- `settings-sync/index.ts:210` 删除，改 import（传入 `oauthToken` 即可）
- `team-memory-sync/teamMemorySyncShared.ts:70` 删除，改 import（传入 `oauthToken + userAgent`）
- `http.ts:67` 原 `getAuthHeaders`（按 provider 构造）重命名 `getProviderAuthHeaders`，避免命名冲突

**验收**：四处调用点行为不变；单测覆盖 4 种组合（仅 apiKey / 仅 oauth / 两者都有 / 都没有）。

**测试要求**：
- `authHeaders.test.ts` 新建：4 种组合的 header 输出快照
- 每个调用方现有测试：mock `getAuthHeaders` 验证参数透传
- 确认无循环导入：`http/authHeaders.ts` 不依赖四个被清理模块

---

### 6. OSC 8 超链接单一实现
**权威**：`src/ink/termio/osc.ts:420 link()`（含 id 分组、fallback）  
**动作**：
- 新建 `src/utils/hyperlink.ts` 导出 `createHyperlink(url, label, opts?)` —— 薄封装 `osc.link` + 非 TTY 降级
- `renderNodeToOutput.ts:173`、`bridgeStatusUtil.ts:150` 删除 `wrapWithOsc8Link`，改 import `createHyperlink`
- `TerminalSetup.tsx:80` 删除局部实现，改 import（保留 `supportsHyperlinks` 检测逻辑，复用 `osc.supportsOsc8()`）
- `completionCache.ts:57` 删除 `isTTY` 判断，改 import `createHyperlink`（内部已含能力检测）
- `terminal-ui/hyperlink.ts:23` 标记废弃，指向 `utils/hyperlink.ts`

**验收**：在不支持 OSC 8 的终端（`TERM=dumb`、老 tmux）运行 CLI，无乱码；支持的终端正常显示可点击链接。

**测试要求**：
- `hyperlink.test.ts` 新建：TTY/非 TTY、支持/不支持 OSC 8 的四象限输出
- `renderNodeToOutput.test.ts`、`bridgeStatusUtil.test.ts`：mock `createHyperlink` 验证调用
- `completionCache.test.ts`：不再自行判断 `isTTY`

---

## 🟡 P2：代码膨胀、维护负担

### 7. OpenAI `countTokens` 提取共享
**新建**：`src/services/api/shared/countTokens.ts`
```ts
export async function countTokensWithAdapter(
  adapter: OpenAICompatibleAdapter,
  model: string,
  messages: Message[]
): Promise<number | null> { … }
```
- 三个 adapter（`openAIProviderAdapter.ts:126`、`openAIResponsesProviderAdapter.ts:121`、`openAICodexResponsesProviderAdapter.ts:237`）删除实现，改 import
- `verifyApiKey` 的 catch 正则：Codex 版多 `accountId` 保留为可选参数传入

**测试要求**：
- `countTokens.test.ts` 新建：三种 adapter 同一输入产出一致
- 各 adapter 测试：mock 共享函数验证参数透传

---

### 8. `isUsingOAuth` 统一
**权威**：`src/services/auth/auth.ts`（新增导出）  
**动作**：
- `settings-sync/index.ts:196`、`team-memory-sync/teamMemorySyncShared.ts:52` 删除实现，改 import
- 若 team-memory 确实需要额外 `ZY_CODE_PROFILE_SCOPE`，在 auth 版加可选参数 `extraScopes?: string[]`

**测试要求**：
- `auth.test.ts` 新增：`isUsingOAuth` 对各 provider/endpoint/scope 组合的判断表
- 两调用方测试：mock 验证参数透传

---

### 9. keybindings 解析核心共享
**新建**：`src/keybindings/parseKeybindingsCore.ts` 导出纯函数：
- `extractBindings(raw)` → `Keybinding[]`
- `validateBlockArray(arr)` → `ValidationError[]`
- `formatWarnings(errors)` → `string[]`
- async/sync 两版均调用核心函数，仅差异在文件读取方式

**测试要求**：
- `parseKeybindingsCore.test.ts`：各纯函数独立测试
- `loadUserBindings.test.ts`：async/sync 两版对同一输入产出相同 bindings + warnings

---

## 🟢 P3：细微差异 / 规范清理

| 项 | 动作 | 备注 |
|---|---|---|
| pad 三处 | 统一到 `utils/truncate.ts:padVisual`（导出），`costTracker.ts` 改 import，删除 `markdown.ts` 与 `StatuslineConfigDialog.tsx` 局部版 | `padToWidth` 超宽补 1 空格的行为废弃 |
| truncate 按 code point | `copy.tsx:107` 删除 `truncateLine`，改用 `utils/truncate.ts:truncateToWidth`（已按 grapheme） | |
| wrapText 四实现 | 保留 `ink/wrapText.ts`（`wrapAnsi` + `wordWrap`），其他三处改 import | `MarkdownTable.tsx`、`terminal-ui/terminal.ts`、`utils/truncate.ts:171` |
| 重试骨架四份 | 新建 `utils/retry.ts` 导出 `retryWithBackoff(fn, opts?)`，四处改 import | 退避计算复用现有 `withRetry.getRetryDelay` |
| `anthropic-version` | 新建 `constants/api.ts` 导出 `ANTHROPIC_VERSION = '2023-06-01'`，三处硬编码改 import | `filesApi.ts:29` 已是常量，保留并 re-export |
| 兼容 re-export | `bridgeStatusUtil.ts:22` 删除 `export { truncateToWidth as truncatePrompt }` | 规范禁止 |
| 时间戳四处 | 新建 `utils/formatTimestamp.ts` 导出 `formatTimestamp(date?, opts?)`，四处改 import | 统一格式 `HH:mm:ss.SSS` |
| `COMMON_HELP_ARGS` | `effort.tsx:23`、`effortLocal.ts:11` 删除局部定义，改 `import { COMMON_HELP_ARGS } from '../../constants/xml'` | |

---

## 🔧 实施顺序建议

### PR #1（P0 + P1 核心，~6h）
1. `/model` 双入口
2. `isNodeError` 守卫
3. `apiKeyResponses.approved` 统一
4. token 粗估单轨
5. 认证头统一导出
6. OSC 8 超链接单一实现

### PR #2（P1 剩余 + P2，~5h）
7. OpenAI `countTokens` 共享
8. `isUsingOAuth` 统一
9. keybindings 解析核心共享

### PR #3（P3 全部，~4h）
10-16 批量小清理，可合并为一个“代码卫生” PR

---

## ✅ 验收清单（每 PR 合并前必须通过）
- `bun run format` 无变更
- `bun tsc --noEmit` 0 错误
- `bun test` 全绿（含新增单测覆盖收敛点）
- 手工冒烟：`zy /model view`、`zy -p "/model view"`、`zy auth login`、链接渲染、token 统计输出
- **循环导入检查**：`bunx madge --circular src/` 无新增循环；新建模块不被上游反向依赖

---

## 📝 变更记录

| 日期 | PR | 完成项 | 备注 |
|------|-----|--------|------|
| 2026-09-01 | PR #1 | 1. `/model` 命令双入口收敛 | `performModelChange.ts` 为权威实现，`model.tsx` 引用；新增 `performModelChange.test.ts` 18 个测试覆盖收敛点 |
| 2026-09-01 | PR #1 | 2. `isNodeError` 守卫修复 | `policy-limits/index.ts` 导出修正后的实现，`teamMemorySyncShared.ts` / `teamMemorySyncLocal.ts` 改 import；`bun tsc --noEmit` 通过，构建成功 |
| 2026-09-01 | PR #1 | 3. `apiKeyResponses.approved` 统一写入路径 | `config.ts` 新增 `withApprovedFingerprint`/`withRejectedFingerprint` 纯函数 + `approveApiKeyFingerprint`/`rejectApiKeyFingerprint` 包装；`auth.saveApiKey`、`ApproveApiKey`、`ApiKeySetup`、`Settings/Config` 全部委托共享函数；删除死代码 `isApiKeyApproved`；新增 `apiKeyResponses.test.ts` 12 个测试。行为改进：批准/拒绝幂等化 + approved/rejected 互斥（双向迁移，与 Config.tsx 原最严谨实现对齐） |
| 2026-09-01 | PR #1 | 4. token 粗估单轨化 | `microCompact.ts` 删除 `calculateToolResultTokens` 与 `estimateMessageTokens` 遍历逻辑，收敛为 `roughTokenCountEstimationForMessages` × 4/3 薄包装；导出 `roughTokenCountEstimationForBlock` 供 time-based MC 复用；删除过时伪回退 `countTokensViaHaikuFallback`，`analyzeContext.countTokensWithFallback` 改为直接重试 `countMessagesTokensWithAPI`；新增 `tokenEstimation.test.ts` 14 个测试。行为变化：tool_result 数组子块递归计数（原只计 text/image/document）、attachment 消息纳入计数（原被跳过）——均为 tokenEstimation 权威实现的完整语义 |
| 2026-09-01 | PR #1 | 5. 认证头构造统一导出 | 新建 `http/authHeaders.ts` 导出 `buildAuthHeaders({apiKey, oauthToken, userAgent, includeBetaHeader, errorMessage})`；`policy-limits`、`remote-managed-settings`（双分支）、`settings-sync`、`team-memory-sync`（仅 OAuth）四处收敛为调用共享函数，各自的 error 文案作为参数保留；新增 `authHeaders.test.ts` 8 个测试。**计划调整**：`http.ts:67` 的 `getAuthHeaders`（按 model provider 构造模型推理认证头）未重命名——8 个调用方且与辅助服务的"服务认证头"语义不同，不构成重复；共享函数命名 `buildAuthHeaders` 避免冲突 |
| 2026-09-01 | PR #1 | 6. OSC 8 超链接单一实现 | 新建 `utils/hyperlink.ts` 导出 `wrapWithOsc8Link`（纯序列构造）与 `createHyperlink`（能力检测 + 回退，无颜色）；`renderNodeToOutput`、`bridgeStatusUtil`（→ bridgeUI 改 import 源）、`TerminalSetup`、`completionCache` 四处收敛为共享实现（completionCache 的能力检测由 `isTTY` 升级为 `supportsHyperlinks`）；`terminal-ui/hyperlink.ts` 保留蓝色样式语义但序列构造复用共享函数；新增 `hyperlink.test.ts` 7 个测试。**计划修正**：`termio/osc.ts link()` 未作为权威收敛点——`;;` 空参数（ansi-tokenize 兼容，渲染层）与 `id=` 分组（直接终端输出）是两个场景的正确实现，不构成分叉；`utils/hyperlink.ts` 收敛渲染层场景 |
| 2026-09-01 | PR #2 | 7. OpenAI `countTokens` 共享 | 新建 `services/api/shared/countTokens.ts` 导出 `countTokensWithAdapter(messages, tools, logError?)`；三个 OpenAI adapter（chat、responses、codex）均改用共享函数，`logError` 回调保留各自的 debug 标签；删除 `countTokensViaHaikuFallback` 过时伪回退，`analyzeContext.countTokensWithFallback` 改为重试 `countMessagesTokensWithAPI`；新增 `countTokens.test.ts` 4 个测试。**计划修正**：`countTokensWithAdapter` 内用显式 `await` 而非直接 `return promise`，修复 async 函数中 `return promise` 的 rejection 无法被 try/catch 捕获的隐患（原 adapter 代码同存此隐患，因真实 tokenizer 同步所以未触发） |
| 2026-09-01 | PR #2 | 8. `isUsingOAuth` 统一 | `auth.ts` 新增纯函数 `isUsingOAuthTokens(tokens, extraScopes?)` 与封装 `isUsingOAuthForService(extraScopes?)`；`settings-sync` 调用 `isUsingOAuthForService()`（只查 inference，注释说明 CCR token 仅含 inference scope），`team-memory-sync` 调用 `isUsingOAuthForService([ZY_CODE_PROFILE_SCOPE])`；新增 `isUsingOAuth.test.ts` 10 个测试。核心 scope 逻辑提取为纯函数便于测试，provider/endpoint 判断保留在封装层 |
| 2026-09-01 | PR #2 | 9. keybindings 解析核心共享 | 新建 `keybindings/parseKeybindingsCore.ts` 导出 `parseKeybindingsContent(content)` 纯函数；`loadKeybindings`（async）与 `loadKeybindingsSyncWithWarnings`（sync）均委托共享核心进行 bindings 提取、结构校验与错误文案生成；消除约 60 行重复（提取、isKeybindingBlockArray 校验、错误文案三种分支、catch 处理）；async 版 catch 改用 `getSyncLoadErrorWarnings` 统一文案 |
| 2026-09-02 | PR #3 | 10. pad 三处统一 | `utils/truncate.ts` 新增 `padVisual(content, displayWidth, targetWidth, align?)`（支持 left/center/right，等价原 `markdown.ts:padAligned`）；`markdown.ts` 删除 `padAligned` 改为 re-export `padVisual`（`MarkdownTable.tsx` 改 import 源）；`costTracker.ts` 的 `padToWidth`（超宽强制补 1 空格）与 `StatuslineConfigDialog.tsx` 局部 `padVisual` 删除，改用共享实现——**行为修正**：costTracker 超宽标签不再强制补 1 空格 |
| 2026-09-02 | PR #3 | 11. truncate 按 code point 修正 | `copy.tsx` 的 `truncateLine`（按 code point 迭代，ZWJ emoji 会被拆断）删除，改用 `utils/truncate.ts:truncateToWidth`（按 grapheme） |
| 2026-09-02 | PR #3 | 12. `COMMON_HELP_ARGS` 统一 | `effort.tsx` / `effortLocal.ts` 删除局部定义，改 import `constants/xml.js` |
| 2026-09-02 | PR #3 | 13. `anthropic-version` 常量收敛 | 新建 `constants/api.ts` 导出 `ANTHROPIC_VERSION = '2023-06-01'`；实际发现 **17 处**硬编码/局部常量（超出计划预估的 3 处）：`filesApi`、`remoteBridgeCore`、`codeSessionApi`、`workSecret`、`replBridge`（2 处）、`sseTransport`（2 处）、`ccrClient`（2 处）、`bridgeApi`、`sessionsWebSocket`、`RemoteTriggerTool`、`zyai`、`teleport/api` 全部收敛 |
| 2026-09-02 | PR #3 | 14. 兼容 re-export 删除 | `bridgeStatusUtil.ts:22` 删除 `export { truncateToWidth as truncatePrompt }`，`bridgeUI.ts` 改从 `utils/truncate.js` 直接 import。**范围说明**：`utils/format.ts:504-511` 还有一批 truncate/wrapText 兼容 re-export（约 30 个消费方），超出本计划单项范围，未处理——建议后续独立 PR 统一迁移后删除 |
| 2026-09-02 | PR #3 | 15. 时间戳格式化四处收敛 | 新建 `utils/formatTimestamp.ts` 导出 `formatTimestamp`（HH:mm:ss）/`formatLocalISODate`（YYYY-MM-DD）/`formatFileTimestamp`（文件名安全）/`formatTimestamp12h`（h:mm:ssam/pm）；`bridgeStatusUtil.timestamp`、`export.tsx`、`SandboxViolationExpandedView`、`constants/common.getLocalISODate` 四处委托共享实现（保留各自的导出名与 override 逻辑） |
| 2026-09-02 | PR #3 | 16. 重试骨架收敛 | 新建 `services/http/retryLoop.ts` 导出 `retryWithBackoffLoop({maxRetries, fetchOnce, onRetry})`，语义与三处原实现逐字对齐（成功/skipRetry 立即返回、耗尽 fail-open 返回最后结果、退避复用 `withRetry.getRetryDelay`）；`policy-limits`、`remote-managed-settings`、`settings-sync` 三处 for 循环删除。**计划修正**：`filesApi.retryWithBackoff` 未纳入——语义不同（抛错而非 fail-open、无 skipRetry、自带 i18n 错误文案），强行统一会改变行为 |
| 2026-09-02 | PR #3 | 17. wrapText 四实现 | **不收敛，判定为场景差异**：`ink/wrapText.ts`（ANSI 感知 + truncate 模式，返回 string）、`MarkdownTable.tsx`（wordWrap + 过滤空行，返回 string[]）、`terminal-ui/terminal.ts`（首屏折叠 + 剩余行数）、`utils/truncate.ts:wrapText`（grapheme 硬切）四者返回类型与换行语义均不同，共用底层原语（wrapAnsi/sliceAnsi）但服务不同布局；强行统一需参数化巨型函数或改调用方行为，收益低于风险 |
| 2026-09-02 | 收尾 | 18. `utils/format.ts` 兼容 re-export 删除 | 43 个消费方经一次性脚本迁移为从 `utils/truncate.js` 直接 import（迁移脚本用后即删），`format.ts` 删除 `export { truncate, truncatePathMiddle, truncateStartToWidth, truncateToWidth, truncateToWidthNoEllipsis, wrapText } from './truncate.js'` 兼容出口 |
| 2026-09-02 | 收尾 | 19. `aliases.test.ts` 预存失败修复 | **根因是测试 mock 泄漏而非实现 bug**：`performModelChange.test.ts` 将 `isKnownModelAlias` mock 为 `['sonnet','opus','haiku']` 列表，bun 全量并行复用 worker 时 vi.mock 跨文件泄漏污染 `aliases.test.ts`（单独运行该测试本就通过）。mock 实现改为与真实行为一致（lowercase+trim 后匹配 advanced/standard/compact）后全量 **1895 pass / 0 fail** |

> 文档位置：`docs/refactor/duplicate-elimination-plan.md`  
> 后续每完成一项，在此表追加记录。