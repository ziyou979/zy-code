# 为 zy-code 实现可视化 Effort 选择器

基于 Claude Code 2.1.204 的可视化档位滑块 UI，结合 zy-code 现有 effort 基础设施，制定渐进式实现计划。

---

## 一、现状分析

### zy-code 已有的 effort 基础设施

| 模块 | 文件 | 内容 |
|------|------|------|
| 档位定义 | `src/utils/effortTypes.ts` | `PERSISTABLE_EFFORT_LEVELS = [off,on,quick,light,balanced,thorough,extreme,ultra]`、`EffortLevel` 类型 |
| 档位排序 | `src/utils/effort.ts` | `EFFORT_LEVEL_RANK` (0~7)、`EFFORT_LEVEL_ORDER` |
| 模型级映射 | `src/utils/effort.ts` | `getModelEffortLevels(model)` → `EffortLevel[]`、`clampEffort()`、`resolveEffortForModel()` |
| Provider 映射 | `src/utils/effort.ts` | `mapEffortToProvider(effort, provider, model)` → `"low"|"medium"|"high"|"max"` |
| API 参数构建 | `src/services/api/apiHelpers.ts` | `configureEffortParams()` → `outputConfig.effort` + beta header |
| Thinking 集成 | `src/utils/thinking.ts` + `llmOrchestrator.ts` | `ThinkingConfig`(adaptive/enabled/disabled)、`reasoningEffort` |
| 状态管理 | `src/state/AppStateStore.ts` | `effortValue?: EffortLevel`、`thinkingEnabled?: boolean` |
| 设置持久化 | `src/utils/settings/types.ts` | `effortLevel` schema 字段 |
| Slash 命令(交互) | `src/commands/effort/effort.tsx` | `type: 'local-jsx'`，当前仅显示状态文本，无可视化选择器 |
| Slash 命令(非交互) | `src/commands/effort/effortLocal.ts` | `type: 'local'`，纯文本参数处理 |
| 命令注册 | `src/commands/effort/index.ts` | 两个变体注册 |
| 图标 | `src/constants/figures.ts` | `EFFORT_OFF`~`EFFORT_ULTRA` 每个档位有独立 Unicode 符号 |
| i18n | `src/i18n/locales/zh-CN/misc.ts` | 各档位名称与描述的中文翻译 |
| 状态栏 | `src/components/BuiltInStatusBar.tsx` | 显示当前 effort 值 |
| CLI | `src/cli/options/modelOptions.ts` | `--effort <level>` 选项 |

### Claude Code 中有、zy-code 中缺失的

| 特性 | CC 实现 | 优先级 |
|------|---------|--------|
| **视觉滑块 UI** — `─▲─` 轨道 + ▲ 指示器 + 标签行 | `Ow_` 组件 via Ink | **P0** |
| **键盘操控** — ←/→ 调节、Enter 确认、Esc 取消 | `onKeyDown` 事件处理 | **P0** |
| **模型感知裁剪** — 只显示模型支持的档位 | `f_p()`/`ww_()` 动态计算 | **P0** |
| **档位描述行** — 悬停时显示档位详细说明 | `gw_` 对象映射 | **P1** |
| **Faster/Smarter 极标签** — 轨道两端暗示 | `"Faster"`/`"Smarter"` 文字 | **P1** |
| **彩虹动画** — max 档位颜色扫光 | `era` 组件逐字变色 | **P2** |
| **波纹涟漪** — 全屏模式轨道字符动效 | `$re` + ripple 计算 | **P2** |
| **确认对话框** — 切换高 effort 时二次确认 | `C6e` 组件 | **P1** |
| **组织级别上限** — org 级 cap 提示 | `Hw_` 字符串 + `k8l()` 检查 | **P3** |

---

## 二、架构设计

### 文件变更计划

```
src/commands/effort/
├── index.ts           # 命令注册（无改动）
├── effort.tsx         # 改造：无参时渲染 PickerUI，有参时走现有逻辑
├── effortLocal.ts     # 无改动（非交互保持纯文本）
├── effortPicker.tsx   # 【NEW】可视化选择器主组件
├── effortPickerData.ts # 【NEW】选择器数据结构计算（f_p/ww_ 等价）
└── effortPickerUtils.ts # 【NEW】工具函数（颜色、渐变、动画）
```

### 数据流

```
用户输入 /effort（无参数）
  → effort.tsx call() 检测 args 为空
  → 渲染 <EffortPicker onDone={onDone} />
    → effortPickerData.ts 计算选择器结构
      → getModelEffortLevels(model) 获取模型支持档位
      → computePickerLayout(levels, model) 计算轨道参数
    → EffortPicker 组件
      → 渲染轨道条、▲、标签、键盘提示
      → ←/→ 选择 → Enter 确认 → Esc 取消
      → 确认后复用 executeEffort() + setAppState
```

---

## 三、分阶段实现

### Phase 1: 选择器数据层（effortPickerData.ts）

**目标**：将 CC 的 `f_p()` / `ww_()` 逻辑移植到 zy-code，计算可视化布局参数。

```typescript
// 输出类型
interface PickerLayout {
  levels: PickerLevel[]           // 显示的档位列表
  width: number                   // 轨道总宽度（字符数）
  trianglePositions: number[]     // 各档位 ▲ 所在的列索引
  spacers: number[]               // 档位标签间间隔
  labelStarts: number[]           // 各标签起始列
  trackLength: number             // 轨道字符总长度
  hasOrchestrate: boolean         // 是否显示 orchestrate 标记
  sublabel?: {                    // 副标签（orchestrate 时显示）
    text: string
    start: number
  }
  capNote?: string                // 能力上限提示
}

// 输入
function computePickerLayout(
  model: string,
  currentEffort: EffortLevel | undefined,
): PickerLayout
```

**实现要点**：
- 使用 `getModelEffortLevels(model)` 获取支持档位 → 裁剪为最多 6 个（off, quick, light, balanced, extreme, ultra）
- 修复语义：当前模型不支持 effort 时返回空选择器并提示
- 计算 `trianglePositions` 和 `spacers` 使标签均衡分布
- 将 CC 的 "xhigh + workflows" 改为 zy-code 的 "orchestrate"
- `trackLength = width`，使用 `─`（U+2500）填充轨道
- 当模型支持 orchestrate 时，轨道尾部追加 `┆──` 分隔线

### Phase 2: 选择器 UI 组件（effortPicker.tsx）

**目标**：实现完整的 Ink 可视化选择器。

```tsx
function EffortPicker({ onDone }: { onDone: LocalJSXCommandOnDone }) {
  // 1. 获取当前模型 & AppState
  // 2. computePickerLayout
  // 3. useState 管理当前选中索引
  // 4. onKeyDown 处理 ←/→/Enter/Esc

  // 渲染结构：
  return (
    <Box flexDirection="column">
      {/* 标题行: Effort */}
      <Text bold>Effort</Text>
      <Box height={1} />

      {/* 轨道区域 */}
      <Box flexDirection="column" alignItems="center" width="100%">
        {/* Faster/Smarter 标签行 */}
        <Box>
          <Text>Faster</Text>
          <Text>{spacer}</Text>
          <Text>Smarter</Text>
        </Box>

        {/* 轨道条 + ▲ */}
        <Box>
          <Text dimColor>{trackLeft}</Text>
          <Text bold backgroundColor={accentColor} color="white">▲</Text>
          <Text dimColor>{trackRight}</Text>
        </Box>

        {/* 档位标签行 */}
        <Box>
          {levels.map((level, i) => (
            <Fragment key={level.value}>
              {i > 0 && <Text>{spacer}</Text>}
              <LevelLabel level={level} selected={i === selectedIndex} />
            </Fragment>
          ))}
        </Box>

        {/* 副标签 */}
        {sublabel && <Text dimColor>{sublabel.text}</Text>}

        {/* max/ultra 能力提示 */}
        {capNote && <Text dimColor>{capNote}</Text>}
      </Box>

      <Box height={1} />

      {/* 键盘操作提示 */}
      <KeyboardHint />
    </Box>
  )
}
```

**关键实现细节**：

1. **颜色映射**（参考 CC + zy-code 现有设计系统）：
   - `off` → `dim`/`gray`
   - `quick`/`light` → `yellow`/`warning`
   - `balanced` → `green`/`success`
   - `thorough` → `blue`/`permission`
   - `extreme` → `magenta`/`autoAccept-shimmer`
   - `ultra` → `rainbow-animated` 或 `violet`

2. **键盘事件**：
   - `←`/`→`：增减选中索引（钳制在 [0, levels.length-1]）
   - `Enter`：确认选择 → `executeEffort(selectedLevel)` → `setAppState` → `onDone(message)`
   - `Esc`：取消 → `onDone("Cancelled")`

3. **当前档位高亮**：初始选中索引使用 `resolveEffortForModel()` 定位

### Phase 3: 集成到现有命令（修改 effort.tsx）

**目标**：在 `call()` 入口分发到选择器。

```typescript
export async function call(onDone, _context, args?) {
  args = (args?.trim() || '').toLowerCase()

  if (COMMON_HELP_ARGS.includes(args)) {
    // 保持现有帮助文本
    onDone(helpText)
    return
  }

  if (!args || args === 'current' || args === 'status') {
    // 交互模式：渲染可视化选择器
    return <EffortPicker onDone={onDone} />
  }

  // 有参数：走现有 executeEffort 逻辑
  const model = getMainLoopModel() ?? ''
  const result = executeEffort(args, model)
  return <ApplyEffortAndClose result={result} onDone={onDone} />
}
```

### Phase 4: 增强功能

**4.1 档位描述行** — 选中某个档位时，在底部显示其描述：
- 从 `gw_` 等效映射获取（利用 i18n key `effort.description.{level}`）
- 在回车键提示行上方显示

**4.2 二次确认对话框** — 当切入 `ultra`/`orchestrate` 等高强度时弹出确认：
- 复用或参考 `src/components/design-system/Dialog.tsx`
- 结构：`"Set effort to {level}?"` + `[Confirm] [Cancel]`

**4.3 全屏模式波纹动效** — 终端全屏时轨道字符产生动画波纹：
- 参考 CC 的 `tra`/`rra` 函数：计算字符距 ▲ 的距离 → 应用渐变色
- 用 `useEffect` + `requestAnimationFrame` 实现时间驱动

**4.4 彩虹动画** — `ultra` 档位标签颜色循环扫光：
- 利用 CC 的 `era` 组件思路：逐字着色，颜色随时间变化
- 使用 zy-code 已有的 `usePreviewTheme` 或独立时间循环

---

## 四、具体实现任务

### 任务 1：创建 `effortPickerData.ts`

```typescript
// 常量
const PICKER_MIN_WIDTH = 30          // 最小轨道宽度
const PICKER_FULL_WIDTH = 42         // 完整 6 档宽度（参考 CC: Sw_ = 42）
const LEVEL_SPACERS = [5, 5, 5, 6]   // 档位间距（参考 CC: Aw_）
const TRIANGLE_POSITIONS = [1, 10, 20, 30, 40] // ▲ 位置（参考 CC: vw_）

// 核心函数
function computePickerLayout(
  model: string,
  currentEffort: EffortLevel | undefined,
): PickerLayout

// 辅助函数
function cropLevels(levels: EffortLevel[], maxCount: number): EffortLevel[]
function computeLabelStarts(levels: PickerLevel[], spacers: number[]): number[]
function getPickerWidth(levelCount: number): number
function getTrianglePositions(levelCount: number): number[]
function getEffortCapNote(model: string): string | undefined
```

### 任务 2：创建 `effortPicker.tsx`

组件树：
```
<EffortPicker>                    ← 顶层容器，autoFocus + onKeyDown
  ├─ <Text>Effort</Text>          ← 标题
  ├─ <Spacer />                   ← 空行
  ├─ <Box flexDirection="column" alignItems="center">
  │  ├─ <TrackLabelBar />         ← "Faster" / "Smarter"
  │  ├─ <TrackBar />              ← ──▲──
  │  ├─ <LevelLabels />           ← quick light balanced extreme ultra
  │  ├─ <SubLabel />              ← 可选副标签
  │  └─ <CapNote />               ← 可选上限提示
  ├─ <Spacer />
  └─ <KeyboardHintBar />          ← ←/→ · Enter · Esc
```

子组件：
- `TrackLabelBar` — 左右极标签
- `TrackBar` — 轨道字符 + ▲ 指示器
- `LevelLabel` — 单个档位标签（选中/未选中样式）
- `KeyboardHintBar` — 键盘操作提示

### 任务 3：修改 `effort.tsx`

- `call()` 函数增加无参分支 → 渲染 `<EffortPicker>`
- 保留所有现有参数处理逻辑

### 任务 4：i18n 补全

确保以下翻译 key 存在：
- `effort.picker.title` — "Effort"
- `effort.picker.faster` — "Faster"
- `effort.picker.smarter` — "Smarter"
- `effort.picker.adjust` — "{keys} to adjust"
- `effort.picker.confirm` — "{keys} to confirm"
- `effort.picker.cancel` — "{keys} to cancel"
- `effort.picker.cancelled` — "Cancelled"
- `effort.orchestrate.sublabel` — "orchestrate" 副标签
- `effort.maxCapNote` — 能力上限提示

### 任务 5：状态栏联动（可选增强）

在 `BuiltInStatusBar.tsx` 的 effort 段添加切换提示：
- 选中状态时加粗/变色显示
- 与 Picker 保持一致的颜色方案

---

## 五、与现有系统的集成点

| 系统 | 集成方式 |
|------|---------|
| AppState | `effortValue` 获取 + 设置 |
| Settings | `updateSettingsForSource('userSettings', { effortLevel })` |
| Model 能力 | `getModelEffortLevels(model)` 裁剪可选档位 |
| i18n | `tSync('effort.{level}')` 获取显示名 |
| 遥测 | `logEvent('zy_effort_command', { effort })` |
| Design System | `Box`/`Text`/`color` 等 Ink 组件 |
| Dialog | 可复用 `src/components/design-system/Dialog.tsx` 做二次确认 |

---

## 六、验收标准

1. **基本功能**：`/effort` 无参数打开可视化选择器，←/→ 选择，Enter 确认，Esc 取消
2. **模型感知**：选择器只显示当前模型支持的档位（如不支持 effort 的模型不显示选择器）
3. **状态同步**：确认后 effort 持久化到 settings + AppState，状态栏实时更新
4. **键盘完整**：左右方向键正常轮转，回车确认正常，取消不应用
5. **降级**：非 TTY 环境自动走非交互路径（现有逻辑，无需改动）
6. **类型安全**：`bun tsc --noEmit` 无错误
7. **i18n**：所有用户可见文本走 `tSync()`

---

## 七、工作量估算

| Phase | 任务 | 文件 | 预估行数 | 复杂度 |
|-------|------|------|---------|--------|
| 1 | 数据层 | `effortPickerData.ts` | ~120 | 中 |
| 2 | UI 主组件 | `effortPicker.tsx` | ~250 | 高 |
| 2 | 子组件 | `effortPicker.tsx`(内联) | ~100 | 中 |
| 3 | 集成 | `effort.tsx` | ~30 | 低 |
| 4.1 | 描述行 | `effortPicker.tsx` | ~30 | 低 |
| 4.2 | 确认对话框 | `effortPicker.tsx` | ~50 | 中 |
| 4.3 | 波纹动效 | `effortPicker.tsx` | ~60 | 中 |
| 4.4 | 彩虹动画 | `effortPicker.tsx` | ~50 | 中 |
| — | i18n | 翻译文件 | ~20 | 低 |

**总计**：~710 行新增/修改，核心文件 3 个（effortPickerData.ts + effortPicker.tsx + effort.tsx 修改）

---

## 八、预览效果示意

```
               Effort

     Faster                       Smarter
  ────────────────▲─────────────────────
  quick   light   balanced   extreme   ultra
              orchestrate + workflows

  ←/→ to adjust · Enter to confirm · Esc to cancel
```

```
               Effort                                          ← 标题

     Faster                       Smarter                      ← 极标签
  ────────────────▲─────────────────────                       ← 轨道 + ▲
  quick   light   balanced   extreme   ultra                   ← 档位标签
              orchestrate + workflows                          ← 副标签(可选)
  Maximum capability with deepest reasoning                    ← 上限提示

  ←/→ to adjust · Enter to confirm · Esc to cancel            ← 键盘提示
```
