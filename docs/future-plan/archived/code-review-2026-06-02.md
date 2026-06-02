# Code Review: 本地改动（2026-06-02）

## 📊 Overview

**406 files changed**: 3,440 additions, 11,018 deletions

本次改动是一次大规模重构，主要包含：

1. **Effort 体系重构** — 从 provider-specific 档位（minimal/low/medium/high/max）迁移到语义化档位（quick/light/balanced/thorough/extreme/orchestrate）
2. **Auto Mode 全面启用** — 移除 `TRANSCRIPT_CLASSIFIER` feature flag，Auto Mode 成为默认功能
3. **Workflow Tool 完整实现** — 从 stub 变为可执行的工作流编排工具
4. **Feature Flag 清理** — 移除多个已固化的 feature flag
5. **Reasoning Content 协议扩展** — 支持 DeepSeek/DashScope/Kimi 三家
6. **Gemini Provider 新增** — 添加 Google Gemini 支持
7. **文档整理** — 删除 11 个历史文档（-7,000+ 行）

---

## 🚨 Critical Issues

### 1. TypeScript 编译失败 — 37 个类型错误

> ❌ 违反 AGENTS.md 规范："改代码后必须 `bun tsc --noEmit` 通过"

**主要错误：**

- **`src/cli/headless/controlLoop.ts`** — 34 个错误
  - WireControlRequest handler 返回类型不匹配（`void` vs `"break" | Promise<"break">`）
  - 所有 case handler 需要返回明确的 `"break"` 值或 Promise

- **`src/native-ts/file-index/index.ts`** — 5 个错误
  - `readyCount` 属性不存在于 `FileIndex` 类型

- **`src/services/telemetry/bigqueryExporter.ts`** — 2 个错误
  - `endpoint` 属性不存在于 `BigQueryMetricsExporter` 类型

- **`src/utils/generators.ts`** — 1 个错误
  - `QueuedGenerator<A>` 类型中 `value` 字段的 `void | A` 不兼容

**影响**: 构建会失败，代码无法部署

---

### 2. Dead Code — 不可达的 return 语句

**文件**: `src/utils/settings/settings.ts:823-824`

```typescript
export function hasAutoModeOptIn(): boolean {
  // ... 函数体 ...
  logForDebugging(...)
  return result
  return false  // ❌ 永远不会执行
}
```

**文件**: `src/utils/settings/settings.ts:839-840`

```typescript
export function getUseAutoModeDuringPlan(): boolean {
  // ... 函数体 ...
  return (...)
  return true  // ❌ 永远不会执行
}
```

**原因**: 移除 `if (feature('TRANSCRIPT_CLASSIFIER'))` 条件时，忘记删除 else 分支的 return 语句

**修复**: 删除这两处不可达的 return 语句

---

### 3. Feature Flag 硬编码为 `true`

**文件**: `src/utils/settings/settings.ts:517, 855, 1002`

```typescript
// Before
...(feature('TRANSCRIPT_CLASSIFIER') ? ['disableAutoMode'] : [])

// After
...(true ? ['disableAutoMode'] : [])  // ❌ 永远为真，三元运算符无意义
```

**建议**: 直接移除三元运算符

```typescript
// Better
['disableAutoMode']
```

---

## ⚠️ Code Quality Issues

### 4. Effort 迁移的向后兼容风险

**文件**: `src/utils/effort.ts`

#### 问题 1: 类型收窄过度

```typescript
// Before
export type EffortValue = EffortLevel | number

// After
export type EffortValue = EffortLevel  // ❌ 移除了数值类型
```

**影响**:
- `resolveAppliedEffort` 返回类型从 `EffortValue | undefined` 变为 `EffortLevel | undefined`
- 内部构建可能依赖数值 effort（如 `effort_override: 85`）

**建议**: 确认所有调用方已适配，或保留数值类型支持

#### 问题 2: 迁移映射表不完整

```typescript
const LEGACY_EFFORT_MAP: Record<string, EffortLevel> = {
  minimal: 'quick',
  low: 'light',
  medium: 'balanced',
  high: 'thorough',
  xhigh: 'extreme',
  max: 'extreme',
  ultracode: 'orchestrate',
}
```

**缺失**:
- `max` 在 external build 中是会话级（不持久化），但迁移表将其映射为 `extreme`（可持久化）
- 可能导致用户意外持久化原本的会话级设置

**建议**: 在 `migrateLegacyEffort` 中添加 `isInternalBuild()` 检查

---

### 5. i18n 键重复定义

**文件**: `src/i18n/locales/en/misc.ts`, `src/i18n/locales/zh-CN/misc.ts`

```typescript
// 新旧键并存
'effort.quick': 'Quick',        // ✅ 新
'effort.light': 'Light',        // ✅ 新
'effort.balanced': 'Balanced',  // ✅ 新
'effort.thorough': 'Thorough',  // ✅ 新
'effort.extreme': 'Extreme',    // ✅ 新
'effort.high': 'High',          // ⚠️ 旧（应删除）
'effort.low': 'Low',            // ⚠️ 旧（应删除）
'effort.medium': 'Medium',      // ⚠️ 旧（应删除）
'effort.minimal': 'Minimal',    // ⚠️ 旧（应删除）
```

**影响**:
- 旧键仍被引用（`effort.high` 在 `getEffortLevelDescription` 中未使用，但可能在其他地方）
- 增加翻译维护负担

**建议**: 全局搜索并删除所有旧 effort 键的引用

---

### 6. WorkflowTool 的同步文件操作

**文件**: `src/tools/WorkflowTool/WorkflowTool.ts:48-56`

```typescript
function getWorkflowsDir(): string {
  const sessionDir = join(getProjectDir(getOriginalCwd()), getSessionId())
  const dir = join(sessionDir, 'workflows')
  mkdirSync(dir, { recursive: true })  // ⚠️ 同步阻塞
  return dir
}

function persistScript(source: string, name: string): string {
  const dir = getWorkflowsDir()
  const filename = `${name}-${Date.now()}.js`
  const filepath = join(dir, filename)
  writeFileSync(filepath, source, 'utf-8')  // ⚠️ 同步阻塞
  return filepath
}
```

**问题**:
- `mkdirSync` / `writeFileSync` 在工具调用路径上同步执行
- 大脚本（512KB 限制）可能阻塞事件循环

**建议**: 使用 `fs/promises` 的异步 API

```typescript
async function persistScript(source: string, name: string): Promise<string> {
  const dir = await getWorkflowsDir()
  const filepath = join(dir, `${name}-${Date.now()}.js`)
  await writeFile(filepath, source, 'utf-8')
  return filepath
}
```

---

## ✅ Positive Changes

### 7. ShellSnapshot 的 Promise 包装改进

**文件**: `src/shell-eval/bash/ShellSnapshot.ts`

```typescript
// Before — Promise 包裹整个 async 函数体（反模式）
return new Promise(async (resolve) => {
  try {
    // ... async 操作 ...
  } catch (error) {
    resolve(undefined)
  }
})

// After — 正确的 async/await + Promise 组合
try {
  // ... async 准备 ...
  return new Promise<string | undefined>((resolve) => {
    execFile(...)
  })
} catch (error) {
  return undefined
}
```

✅ 修复了 `async` Promise 构造器反模式，错误处理更清晰

---

### 8. Reasoning Content 协议扩展

**文件**: `src/services/api/conversions/openai.ts:118-140`

```typescript
// Before — 仅 DeepSeek
function isDeepSeekReasoningModel(model: string | undefined): boolean {
  return model?.toLowerCase().includes('deepseek') && localModelHasCapability(model, 'thinking')
}

// After — 支持 DeepSeek/DashScope/Kimi
const REASONING_CONTENT_PROVIDERS = new Set(['deepseek', 'dashscope', 'kimi'])

function supportsReasoningContentField(model: string | undefined): boolean {
  if (!model) return false
  const provider = getAPIProvider()
  if (REASONING_CONTENT_PROVIDERS.has(provider)) return true
  if (model.toLowerCase().includes('deepseek')) {
    return localModelHasCapability(model, 'thinking')
  }
  return false
}
```

✅
- 解决了 DashScope 的 `</think>` 标签泄漏问题
- 基于 provider 而非模型名判断更健壮
- 保留 DeepSeek 模型名的 fallback 兼容性

---

## 🔒 Security Considerations

### 9. Workflow Tool 的沙箱隔离

**文件**: `src/tools/WorkflowTool/WorkflowTool.ts`

```typescript
async function executeWorkflowAsync(...) {
  // ...
  const result = await executeWorkflowScript({
    source,
    args,
    toolUseContext,  // ⚠️ 传递完整上下文，可能包含敏感信息
    // ...
  })
}
```

**风险**:
- Workflow 脚本可以访问 `toolUseContext`（包含会话 ID、API 密钥等）
- 512KB 的脚本大小限制可能被滥用

**建议**:
- 在 `executeWorkflowScript` 中实施权限沙箱
- 限制可访问的 `toolUseContext` 字段
- 添加脚本签名验证机制

---

### 10. Auto Mode 的 Opt-In 检查

**文件**: `src/utils/settings/settings.ts:813-823`

```typescript
export function hasAutoModeOptIn(): boolean {
  const user = getSettingsForSource('userSettings')?.skipAutoPermissionPrompt
  const local = getSettingsForSource('localSettings')?.skipAutoPermissionPrompt
  // ...
}
```

**问题**:
- `localSettings` 可能被项目 `.zy/settings.local.json` 控制
- 恶意项目可能诱导用户启用 Auto Mode

**建议**:
- 移除 `localSettings` 来源（仅保留 `userSettings` / `flagSettings` / `policySettings`）
- 或在文档中明确警告

---

## 📋 Summary

### ✅ Positive Changes

1. ShellSnapshot 的 Promise 反模式修复
2. Reasoning Content 协议扩展（DeepSeek/DashScope/Kimi）
3. Effort 体系的语义化设计（provider 无关）
4. Workflow Tool 的完整实现（支持 resume、journal、budget）
5. Gemini provider 新增
6. i18n 翻译补充（workflow 命令、effort 档位）

### ❌ Must Fix

1. **37 个 TypeScript 错误** — 阻塞构建
2. **2 处 dead code** — `return false` / `return true` 不可达
3. **3 处 `true ? ... : ...` 硬编码** — 应直接移除三元运算符

### ⚠️ Should Fix

4. Effort 迁移的数值类型移除（确认内部构建兼容性）
5. i18n 旧键清理（`effort.high` / `effort.low` 等）
6. WorkflowTool 的同步文件操作（改为异步）
7. Auto Mode 的 `localSettings` 来源安全性

### 📝 Recommendations

8. 添加 Effort 迁移的单元测试（验证旧值 → 新值映射）
9. 在 `docs/architecture.md` 中补充 Effort 体系说明
10. 为 Workflow Tool 添加沙箱隔离文档

---

## 🎯 Next Steps

```bash
# 1. 修复 TypeScript 错误
bun tsc --noEmit  # 查看完整错误列表

# 2. 删除 dead code
# Edit src/utils/settings/settings.ts:823-824, 839-840

# 3. 移除硬编码三元运算符
# Replace: ...(true ? ['disableAutoMode'] : [])
# With:    ['disableAutoMode']

# 4. 验证构建
bun run build

# 5. 运行测试（如有）
bun test
```
