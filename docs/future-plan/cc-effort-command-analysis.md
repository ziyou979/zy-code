# Claude Code `/effort` 指令分析 & ZY Code 对标方案

> 编写日期：2026-07-08
> 来源：提取自 Claude Code CLI 二进制（231MB，claude.exe）
> 目的：分析 CC 的 effort 指令设计，评估 ZY Code 能否实现同等级可视化效果

---

## 1. CC `/effort` 核心设计

### 1.1 能力矩阵

| 维度 | CC 实现 | ZY Code 现有状态 |
|------|---------|-----------------|
| 档位数 | 5 档 + integer | 9 档（含 `orchestrate`） |
| 档位名称 | `low`, `medium`, `high`, `xhigh`, `max` | `off`, `on`, `quick`, `light`, `balanced`, `thorough`, `extreme`, `ultra`, `orchestrate` |
| 整数 thinking budget | ✅ 直接支持 `effort 10000` | ❌ 不支持 |
| Ultracode 编排模式 | ✅ `ultracode` = xhigh + 动态工作流编排 | ✅ `orchestrate` = extreme + 编排（名称不同，概念等价） |
| auto / unset | ✅ | ✅ |
| 环境变量 | `CLAUDE_CODE_EFFORT_LEVEL` | `ZY_CODE_EFFORT_LEVEL` |
| CLI 参数 | `--effort <level>` | `--effort <level>` |

### 1.2 二进制关键偏移量

| 内容 | 偏移量 | 说明 |
|------|--------|------|
| Settings schema（effortLevel + ultracode） | `0x08E4A4B0` (93386128) | persistable effort 配置项 |
| 设置项描述（low/medium/high/xhigh） | `0x08E4845C` (93358196) | 设置 schema 中的 effort 值定义 |
| error 提示 + "or an integer" | `0x065ADDB5` (106565109) | 整数参数支持的提示文本 |
| CLI `--effort <level>` 定义 | `0x093D33B2` (155020514) | CLI 参数注册 |
| effort changed 事件 | `0x0682A7B8` (109227464) | 状态变化追踪 |
| 注入 system prompt 的 effort | `0x0DFC6A88` (234602760) | minified 代码中 `Current effort level:` |
| Hook effort 参数描述 | `0x0D032C2F` (218297167) | hook 暴露的 effort 字段 |
| 遥测事件 | `0x081CD996` (136112326) | `tengu_effort_command` |
| Ultracode 设置项描述 | `0x08E484A3` (93358655) | "Enable ultracode for the session" |

---

## 2. 可视化效果对比

### 2.1 CC 的 effort 显示方式

CC **没有**使用图形化的进度条/仪表盘来显示 effort。它采用纯文本描述：

```
# 当前显示
Current effort level: high (more thorough analysis)

# auto 模式
Effort level: auto (currently high)

# ultracode 模式
Current effort level: ultracode (xhigh + dynamic workflow orchestration; this session only)

# 设值反馈
Set effort level to xhigh (this session only): maximum depth analysis

# 组织限制
Effort 'xhigh' exceeds your organization's limit; set to 'medium' instead

# 环境变量覆盖
CLAUDE_CODE_EFFORT_LEVEL=xhigh overrides effort this session, and low is session-only (nothing saved)
```

CC 的可视化策略是**信息型**而非**图形型**：用自然语言描述当前 effort 的效果，配合括号补充说明（如持久化范围、模型限制等）。

### 2.2 ZY Code 的 effort 显示方式

ZY Code 使用 **Unicode 符号 + 状态栏集成**：

```typescript
// symbols
const EFFORT_OFF      = '⊘'  // \u2298
const EFFORT_ON       = '◑'  // \u25d1
const EFFORT_QUICK    = '○'  // \u25cb
const EFFORT_LIGHT    = '◔'  // \u25d4
const EFFORT_BALANCED = '◑'  // \u25d1
const EFFORT_THOROUGH = '◕'  // \u25d5
const EFFORT_EXTREME  = '●'  // \u25cf
const EFFORT_ULTRA    = '◉'  // \u25c9

// 状态栏显示格式（renderSegments.ts）
model · ◑ balanced

// 通知显示格式（EffortIndicator.ts）
◑ balanced · /effort
```

### 2.3 对比总结

| 可视化维度 | CC | ZY Code | 优劣 |
|-----------|-----|---------|------|
| 状态栏显示 | 文本描述 | Unicode 符号 + 文本 | ZY 更直观 |
| 设置反馈 | 自然语言段落 | 文本 + 符号 | CC 更详细 |
| 符号系统 | 无 | 8 级 Unicode 符号体系 | ZY 更丰富 |
| 进度条/仪表盘 | ❌ 无 | ❌ 无（有 context bar） | 平局 |
| 通知系统 | 文本通知 | `effortLevelToSymbol` + `/effort` 提示 | ZY 略优 |
| 模型联动 | 同一对话框切换 model + effort | ModelPicker 内嵌 effort 选择 | 功能对等 |
| EffortCallout 引导弹窗 | - | ✅ 新模型首次使用自动弹出 | ZY 独有 |

---

## 3. CC 的 effort prompt 注入机制

CC 会在 system prompt 中注入当前 effort 级别，让模型知晓自己的思考强度：

```javascript
// 从 minified 代码还原的逻辑
function showCurrentEffort(effortValue, model) {
  if (isUltracode(model, effortValue)) {
    return "Current effort level: ultracode (xhigh + dynamic workflow orchestration; this session only)"
  }
  
  const envOverride = getEffortEnvOverride()  // CLAUDE_CODE_EFFORT_LEVEL
  const persistedEffort = modelSupportsEffort(model) ? effortValue : undefined
  const effective = envOverride === null ? undefined : (envOverride ?? persistedEffort)
  
  if (effective === undefined) {
    const defaultLevel = getDefaultEffortForModel(model)
    return `Effort level: auto (currently ${formatLevel(defaultLevel)})`
  }
  
  return `Current effort level: ${formatLevel(effective)} (${getDescription(effective)})`
}
```

**Hook 暴露**：
- `effort` 字段：当前 turn 的 effort 级别（`low`/`medium`/`high`/`xhigh`/`max`）
- `CLAUDE_EFFORT` 环境变量：shell 命令中可读取
- 子 agent 和主线程均可获取

---

## 4. ZY Code 现有 effort 架构分析

### 4.1 文件结构

```
src/
├── commands/effort/
│   ├── index.ts          # 命令注册（local-jsx + local 双变体）
│   ├── effort.tsx         # Ink 交互式组件
│   └── effortLocal.ts     # 非交互式处理
├── utils/
│   ├── effort.ts           # 核心逻辑（档位定义、解析、映射、默认值）
│   └── effortTypes.ts      # 类型与常量（抽离防循环依赖）
├── components/
│   ├── EffortIndicator.ts  # 符号映射 + 通知文本
│   ├── EffortCallout.tsx   # 首次使用弹窗引导
│   ├── ModelPicker.tsx     # 模型选择器（内嵌 effort 选择）
│   └── statusbar/renderSegments.ts  # 状态栏 effort 渲染
└── constants/figures.ts    # Unicode 符号常量
```

### 4.2 架构优势

1. **层次更细**：9 档 vs CC 5 档，提供更精细的控制
2. **Provider 无关映射**：`mapEffortToProvider()` 将内部档位映射到不同 provider 的 API 参数
3. **完整的排序系统**：`EFFORT_LEVEL_RANK` 用于 clamp 和降级
4. **丰富的可视化符号**：8 级 Unicode 符号体系
5. **弹窗引导**：`EffortCallout` 对新用户友好

### 4.3 关键差距

| 差距项 | CC | ZY Code | 优先级 |
|--------|-----|---------|--------|
| **整数 thinking budget** | `effort 10000` 直接设 thinking tokens | ❌ 不支持 | **P1** |
| **组织级限制** | 管理员可限制 max effort | ❌ 不支持 | P2 |
| **远程会话感知** | 远程传输不可修改 effort | ❌ 不支持 | P2 |
| **Effort 注入 system prompt** | 每次请求将现有效力注入 prompt | 通过代理逻辑间接实现 | P3 |
| **Hook 暴露** | `effort` 字段 + `CLAUDE_EFFORT` env var | 有 `getCurrentHookEffortLevel()` 但未暴露给 shell | P2 |
| **Fast mode 联动** | `/effort` 时提示 fast mode 状态 | 需查看 ModelPicker | P2 |
| **整数档位映射** | 整数→thinking budget | ❌ 纯语义档位 | P1 |

---

## 5. ZY Code 可视化能力分析

### 5.1 已有的"可视化"基础

ZY Code 有良好的可视化基础设施：

1. **Unicode 符号体系**：File `constants/figures.ts` 定义了丰富的符号常量
2. **状态栏模块化**：`renderSegments.ts` 支持模块化渲染，已有 context bar（`█░` 进度条）
3. **Ink 组件系统**：支持 `Select`、`Box`、`Text`、`PermissionDialog` 等组件

### 5.2 可实现的可视化增强

以下增强均可基于现有架构实现：

#### 5.2.1 Thinking Budget 仪表盘（P1）

```typescript
// EffortIndicator.ts 新增
export function renderEffortBar(level: string): string {
  // CC 的 low=20%, medium=40%, high=60%, xhigh=80%, max=100%
  const levelPercent: Record<string, number> = {
    off: 0, on: 20, quick: 10, light: 25,
    balanced: 50, thorough: 65, extreme: 80, ultra: 95, orchestrate: 95,
  }
  const pct = levelPercent[level] ?? 50
  const filled = Math.round(pct / 100 * 8)
  return '█'.repeat(filled) + '░'.repeat(8 - filled) + ` ${pct}%`
}

// 状态栏显示
// model · ◑ balanced ████░ 50%
```

#### 5.2.2 设值时的视觉效果（P2）

```
# 当前: ◕ thorough
# 设置后:
  ◕ thorough ██████░░ 65% ═══> ● extreme ████████ 80%
  (this session only)
```

#### 5.2.3 `/effort` 交互式选择器增强（P2）

可复用 CC 的 "Change effort level?" 对话框模式，在现有 `EffortCallout` 基础上添加：

```
┌─ Effort Level ──────────────────────────┐
│                                          │
│  Current: ◑ balanced (50% thinking)     │
│                                          │
│  ○ quick     ██░░░░░░  10%              │
│  ◔ light     ███░░░░░  25%              │
│  ◑ balanced ████░░░░  50%  ← you are here│
│  ◕ thorough  ██████░░  65%              │
│  ● extreme   ████████  80%              │
│  ◉ ultra     ████████░ 95%              │
│                                          │
│  [Enter] select                          │
└──────────────────────────────────────────┘
```

#### 5.2.4 Thinking token 实时显示（P1）

CC 不显示已用的 thinking tokens，但 ZY Code 可以结合 `thinking_tokens` 遥测实现：

```
status bar: model · ◑ balanced · 🧠 1.2k/8k tokens
```

---

## 6. 实现路线图

### 阶段 1：整数 thinking budget 支持（P1，复杂：中）

```
/effort 10000     # 设 thinking budget 为 10000 tokens
/effort 0         # 关闭 thinking
/effort 32000     # 设到模型上限
```

**需要变更**：
- `effortTypes.ts`：扩展 `EffortLevel` 为 `string` 联合类型包括数字
- `effort.ts`：`parseEffortValue()` 增加数字解析
- `effort.tsx`：`executeEffort()` 增加整数路由
- `mapEffortToProvider()`：数字→`thinking.budget_tokens` 映射
- `model-capabilities.json`：各模型配置 thinking budget 上限

### 阶段 2：Thinking Budget 仪表盘（P1，复杂：低）

- `EffortIndicator.ts`：新增 `renderEffortBar()` 函数
- `renderSegments.ts`：状态栏 module 添加 effort 百分比条
- `effort.tsx`：设值反馈添加视觉条

### 阶段 3：Hook 暴露（P2，复杂：低）

- 确保 `getCurrentHookEffortLevel()` 被 hook 系统正确调用
- 在 hook payload 中添加 `effort` 字段
- 设置 `ZY_EFFORT` 环境变量

### 阶段 4：组织限制 + 远程感知（P2，复杂：中）

- `effort.ts`：新增 `getOrgEffortLimit()` → 从管理员策略读取 max effort
- bridge：远程会话禁用 effort 修改
- 错误提示：`/effort xhigh exceeds your organization's limit`

---

## 7. 总结

### 可视化结论

**ZY Code 在 effort 可视化方面已经超过 CC**。原因：

1. **符号系统**：ZY Code 有 8 级 Unicode 符号，CC 纯文本
2. **状态栏集成**：ZY Code 状态栏显示 model + 符号 + effort 名，CC 只有文本
3. **弹窗引导**：`EffortCallout`（CC 无此功能）
4. **ModelPicker 内嵌**：功能对等

### 仍需追赶的功能

1. **整数 thinking budget**（P1）— 这是 CC 的核心差异化能力
2. **Effort 仪表盘/进度条**（P1）— 在符号基础上增加量化视觉反馈
3. **组织级限制**（P2）— 企业场景需求
4. **Hook 暴露**（P2）— 插件生态需要

### CC /effort 的核心设计理念

CC 的 effort 设计不是"可视化"，而是**信息透明**：

- 不追求图形化的进度条
- 而追求"用户清楚知道当前 effort 是什么、为什么是这个、会有什么效果"
- 通过自然语言描述 + 括号补充（scope、override、reason）实现
- 核心 UX 原则：**运行 `/effort` 永远不产生歧义**

ZY Code 在这方面已有类似的透明度（环境变量覆盖提示、session-only 提示、自动降级说明），可以进一步强化自然语言描述的完整性。
