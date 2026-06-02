# zy-code Auto Mode 与 Claude Code 对齐分析

> 触发问题：zy-code 文件编辑弹窗给出的是
> "是 / 是允许本次会话中的所有编辑 / 否" 三选项，
> 而 Claude Code 中"已经是 auto mode"——这个差异在哪里处理？
>
> 验证方式：对 Claude CLI 二进制（`@anthropic-ai/claude-code/bin/claude.exe`）进行 `grep -aob` + `dd` 提取，与 zy-code 源码逐项对照。

---

## 1. 结论速览

| 处理点 | zy-code | Claude Code |
|---|---|---|
| 弹窗 3 个选项的字面字符串 | `accept-once / accept-session(yes-session) / reject` | **完全相同** |
| 合法 `defaultMode` 集合 | `default / acceptEdits / plan` | `default / acceptEdits / plan / **auto**` |
| Shift+Tab 是否可循环到 `auto` | 仅 `isInternalBuild()` 才允许 | 一般用户也允许（gate 由 policy / circuit breaker 控制） |
| `auto` 模式代码 | 已写好骨架（`isAutoModeAvailable`、`canCycleToAuto`、classifier fast-path），但默认锁死 | 默认开放 |

**关键判断**：用户感受到的"Claude Code 已经是 auto mode"**不是来自弹窗 UI 替换**，而是来自两条路径——

1. Claude Code 的 Shift+Tab 循环把 `auto` 作为一等公民模式，普通用户也能进入；
2. 进入 `auto` / `acceptEdits` 后，无风险写操作走 fast-path **直接放行**，根本不弹对话框。

---

## 2. 二进制证据

### 2.1 弹窗选项字符串（偏移 `126,950,000` 附近）

```text
input  Yes  yes  ... accept-once
read  q
?Yes, and allow Claude to edit its own settings for this session
  yes-claude-folder  accept-session  global-claude-folder  claude-folder
Yes, during this session
(Yes, allow all edits during this session
this directory  Yes, allow reading from /  during this session
Yes, allow all edits in / during this session   yes-session
No  no  ... reject
```

与 zy-code [`getFilePermissionOptions`](../../src/components/permissions/FilePermissionDialog/permissionOptions.tsx) 字段一一对应——**没有第 4 个 "auto mode" 选项**。

### 2.2 Mode 枚举字符串（偏移 `87,023,500` 附近）

```text
acceptEdits  plan  default  auto
settings defaultMode "..." is not supported in CLAUDE_CODE_REMOTE
  only acceptEdits, plan, default, and auto are allowed
tengu_settings_auto_mode_untrusted_source_ignored
agent frontmatter requested auto mode but circuit breaker active falling through
```

Claude Code 的合法 mode 有 4 个，且在 `CLAUDE_CODE_REMOTE` 也被允许；agent frontmatter / circuit breaker 都有专门治理逻辑。

---

## 3. zy-code 现状梳理

### 3.1 弹窗选项构造

[`src/components/permissions/FilePermissionDialog/permissionOptions.tsx`](../../src/components/permissions/FilePermissionDialog/permissionOptions.tsx#L65-L187)

```ts
options.push({ label: tSync('permission.yes'), value: 'yes', option: { type: 'accept-once' } })
// ...
options.push({
  label: <Text>{tSync('permission.yesAllowEditsThisSession', { shortcut: modeCycleShortcut })}</Text>,
  value: 'yes-session',
  option: { type: 'accept-session' },
})
options.push({ label: tSync('permission.no'), value: 'no', option: { type: 'reject' } })
```

→ 三选项 UI 与 Claude binary 一致，**这块不需要改**。

### 3.2 Shift+Tab 模式循环

[`src/utils/permissions/getNextPermissionMode.ts`](../../src/utils/permissions/getNextPermissionMode.ts#L37-L76)

```ts
case 'default':
  if (isInternalBuild()) {                              // ← gate 1
    if (ctx.isBypassPermissionsModeAvailable) return 'bypassPermissions'
    if (canCycleToAuto(toolPermissionContext)) return 'auto'  // ← gate 2
    return 'default'
  }
  return 'acceptEdits'                                  // ← 普通用户走这里
```

普通构建：`default → acceptEdits → plan → default`，**永远不会切到 `auto`**。

### 3.3 settings.defaultMode 白名单

[`src/utils/permissions/permissionSetup.ts:707`](../../src/utils/permissions/permissionSetup.ts#L707)

```ts
!['acceptEdits', 'plan', 'default'].includes(settingsMode)
// 注释：CCR 仅支持 acceptEdits 和 plan — 忽略设置中的其他 defaultMode
```

→ 即便用户把 `settings.json` 的 `defaultMode` 设成 `"auto"`，也会被白名单丢弃。

### 3.4 acceptEdits Fast-Path（已实现）

[`src/utils/permissions/permissions.ts:543-600`](../../src/utils/permissions/permissions.ts#L543-L600)

```ts
// 在运行 auto 模式分类器之前，检查 acceptEdits 模式是否允许此操作。
const acceptEditsResult = await tool.checkPermissions(parsedInput, {
  ...,
  toolPermissionContext: { ...state.toolPermissionContext, mode: 'acceptEdits' as const },
})
if (acceptEditsResult.behavior === 'allow') {
  // 直接放行，不弹窗
  return { behavior: 'allow', updatedInput, decisionReason: { type: 'mode', mode: 'auto' } }
}
```

→ 这条路径已经存在，所以"选了一次 yes-session 后就不再弹"是 zy-code 也具备的能力。

### 3.5 auto mode 模块也已就位

[`src/utils/permissions/permissions.ts:481`](../../src/utils/permissions/permissions.ts#L481)

```ts
(autoModeStateModule?.isAutoModeActive() ?? false)
```

→ classifier、circuit breaker、`isAutoModeActive()` 等核心都在，但被 gate 锁住了。

---

## 4. 改造路径（如要让 zy-code 行为对齐 Claude）

### 4.1 放开 settings.defaultMode 白名单

**位置**：[`permissionSetup.ts:707`](../../src/utils/permissions/permissionSetup.ts#L707)

```diff
-!['acceptEdits', 'plan', 'default'].includes(settingsMode)
+!['acceptEdits', 'plan', 'default', 'auto'].includes(settingsMode)
```

同时同步 ZY_CODE_REMOTE 错误日志文案。

### 4.2 普通用户也能 Shift+Tab 切到 auto

**位置**：[`getNextPermissionMode.ts:38-49`](../../src/utils/permissions/getNextPermissionMode.ts#L38-L49)

把 `isInternalBuild()` 这道 gate 替换成 feature flag（或直接拿掉），让 `canCycleToAuto(ctx)` 单独决定。建议方案：

```ts
case 'default':
  if (ctx.isBypassPermissionsModeAvailable) return 'bypassPermissions'
  if (canCycleToAuto(toolPermissionContext)) return 'auto'
  return 'acceptEdits'  // auto 不可用时回退到原行为
```

### 4.3 校验 ZY_CODE_REMOTE 启动时 `isAutoModeAvailable` 的赋值

确认 `verifyAutoModeGateAccess` 在 CCR build 中会被调用，否则即便上面两步打开，`canCycleToAuto` 永远返回 false。

### 4.4（可选）UI 提示文案

`acceptEdits` / `auto` 模式下的状态条文案可以同步成 *"⏵⏵ auto-accept edits on (shift+tab to cycle)"* 之类，让用户能感知当前模式。

---

## 5. 风险与注意

- **安全检查必须保留**：[`pathValidation.ts:178-203`](../../src/utils/permissions/pathValidation.ts#L178-L203) 的 `checkPathSafetyForAutoEdit`、危险文件名/Windows pattern/Zy 配置文件等守卫不能被 auto mode 绕过。
- **Classifier API 成本**：auto mode 的兜底分类器是付费 API 调用，需要 `recordSuccess / circuit breaker` 控制爆发；zy-code 这边已经有相关代码，但要确认事件埋点（`zy_auto_mode_decision`）和限流参数。
- **policy / 不可信源**：Claude binary 中 `tengu_settings_auto_mode_untrusted_source_ignored` 提示——`projectSettings` 和 `localSettings` 不能授予 auto mode（防止 repo 投毒）。zy-code 放开时要照搬同样的来源信任级。

---

## 6. 验证用 grep 命令（可复现）

```bash
CLAUDE_BIN="$(dirname "$(readlink -f "$(which claude)")")/claude.exe"

# 弹窗字符串
grep -aob 'allow all edits during this session' "$CLAUDE_BIN" | head -5

# mode 枚举
grep -aob 'acceptEdits' "$CLAUDE_BIN" | head -5
grep -aob 'tengu_settings_auto_mode_untrusted_source_ignored' "$CLAUDE_BIN"

# 提取上下文
LC_ALL=C dd if="$CLAUDE_BIN" bs=1 skip=87023500 count=2000 2>/dev/null \
  | LC_ALL=C tr -d '\0'
```
