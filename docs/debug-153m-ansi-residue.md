## 终端渲染 `153m` 残留问题排查与修复

### 问题现象

AI 助手输出中，文件路径引用（如 `src/commands.ts:738-742`）前方出现裸文本 `153m`：

```
153msrc/commands.ts:738-742
```

`153m` 出现在**换行符之后的行首**，不是正常的 ANSI 序列显示。

---

### 排查过程

#### 第一阶段：排除 diff 序列化层

**假设**：`terminal.ts` 的 `writeDiffToTerminal` 中，`styleStr`（如 `\x1b[38;5;153m`）与光标移动 CSI 序列交错，导致终端丢弃前半段 CSI 后 `153m` 变成明文。

**验证**：查看 `log-update.ts` 的 diff 生成逻辑发现，`styleStr` 始终作为**完整的单个 patch** 存在（来自 `StylePool.transition()`），不可能在序列化时被拆开。

**结论**：❌ 问题不在 diff 序列化阶段。

---

#### 第二阶段：排除 tokenize / Screen buffer 层

**假设**：`@alcalzone/ansi-tokenize` 的 `tokenize()` 函数在解析不完整 ANSI 序列时将 `153m` 当作普通文本。

**验证**：

```typescript
// tokenize 能正确处理各种 ANSI 序列
tokenize('\x1b[38;5;153m')     // → [{ type: 'ansi', code: '\x1b[38;5;153m' }]
tokenize('\x1b[38;5;')         // → [{ type: 'ansi', code: '\x1b[38;5;' }]
tokenize('\x1b[38;5;153')      // → [{ type: 'ansi', code: '\x1b[38;5;153' }]
```

**结论**：❌ `tokenize` 能正确识别各种 ANSI 序列（完整的、截断的都行）。

---

#### 第三阶段：排除 wrapAnsi 层

**假设**：`Bun.wrapAnsi` 在文本换行时从 ANSI 序列中间插入 `\n`。

**验证**：

```typescript
Bun.wrapAnsi('\x1b[38;5;153msrc/commands.ts:738-742\x1b[0m', 5, { hard: true })
// → "\x1b[38;5;153msrc\n/comm\nands.\nts:73\n8-742\x1b[0m"
// ANSI 序列完整保留，换行只发生在可见文本中间
```

**结论**：❌ `Bun.wrapAnsi` 不会在 ANSI 序列中间截断。

---

#### 第四阶段：排除 Ink 渲染管道

排查了以下模块，均未发现问题：
- `output.ts` 的 `writeLineToScreen` — 正确调用 `tokenize`
- `render-node-to-output.ts` 的 `applyStylesToWrappedText` — 正确处理多 segment 换行
- `colorize.ts` 的 `applyTextStyles` — 使用 chalk 生成完整 ANSI 序列

**结论**：❌ Ink 渲染管道本身没有问题。

---

#### 第五阶段：定位根因 ✅

**假设**：`renderContentWithFileLinks` 函数在含 ANSI 序列的文本上直接做正则匹配，正则误匹配了 ANSI 序列参数。

**验证**：

```typescript
const FILE_PATH_RE = /((?:(?:\.\.\/|\.\/|\/)?(?:[\w.-]+\/)*)[\w.-]+\.\w{1,10}):(\d+)(?:-(\d+))?/g
const content = '\x1b[38;5;153msrc/commands.ts:738-742\x1b[0m'

FILE_PATH_RE.exec(content)
// match[0] = "153msrc/commands.ts:738-742"  ← 误匹配！
// match[1] = "153msrc/commands.ts"          ← 把 153m 当路径前缀
// match.index = 7                            ← 从 \x1b[38;5; 之后开始
```

**根因**：`FILE_PATH_RE` 中的 `[\w.-]+` 包含 `\w`（含数字），因此 `153msrc/commands.ts` 整体被匹配为文件路径。导致：
1. `before` 切片 = `\x1b[38;5;`（不完整的 ANSI 序列）
2. `display` = `153msrc/commands.ts:738-742`（`153m` 变成可见文本）

`\x1b[38;5;` 被 `<Ansi>` 组件解析为一个不完整的样式序列（设置前景色但缺少颜色值），而 `153m` 则作为 `<FilePathLink>` 的可见文本内容渲染出来。

---

### 修复方案

**文件**：`src/components/FilePathLink.tsx`

**策略**：在纯文本上做正则匹配，避免 ANSI 转义序列参数被误匹配。

**核心改动**：

1. **新增 `buildPlainToOriginalMap` 函数**：遍历原始文本跳过 ANSI 转义序列，构建「纯文本索引 → 原始文本索引」的映射表。

2. **修改 `renderContentWithFileLinks`**：
   - **快速路径**：无 ANSI 序列时走 `matchFileLinksSimple`（零额外开销）
   - **ANSI 路径**：
     1. 调用 `buildPlainToOriginalMap` 得到纯文本 + 映射表
     2. 在纯文本上执行 `FILE_PATH_RE` 匹配（不会误匹配 `153m`）
     3. 通过映射表将匹配位置转换回原始文本中的索引
     4. 用原始文本索引切片，保留 ANSI 着色信息
     5. 超链接内用 `<Ansi>` 包裹，保持着色效果

**效果**：
- ✅ `153m` 不再被误匹配为文件路径前缀
- ✅ 带 ANSI 着色的文件路径仍能被识别并生成超链接
- ✅ 无 ANSI 的普通文本走快速路径，零额外开销

---

#### 后续修复：超链接嵌套 `<Ansi>` 导致换行和路径不完整

**问题**：初版修复中，ANSI 分支的超链接渲染使用了：

```tsx
<FilePathLink filePath={filePath}>
  <Ansi dimColor={dimColor}>{display}</Ansi>
</FilePathLink>
```

导致：
- `<FilePathLink>` → `<Link>` → `<Text><ink-link>...</ink-link></Text>`
- 内部 `<Ansi>` 也生成 `<Text>`，形成 `<Text>` 嵌套 `<Text>`
- Ink 将嵌套 `<Text>` 视为独立块级元素 → 超链接前后出现换行
- `display` 使用 `content.slice(originalStart, originalEnd)` 包含尾部 `\x1b[0m` → 路径显示不完整

**修复**：超链接 display 直接使用纯文本 `match[0]`（正则匹配结果，不含 ANSI），避免嵌套 `<Text>`：

```tsx
const display = match[0]  // 纯文本，如 "src/commands.ts:738-742"
parts.push(
  <FilePathLink key={parts.length} filePath={filePath}>
    {display}
  </FilePathLink>,
)
```

前后文本仍通过 `<Ansi>` 渲染保留原始着色，超链接本身在终端中已有下划线/颜色标识，无需额外 ANSI 着色。

---

### 关键教训

1. **不要在含 ANSI 转义序列的原始文本上直接做业务正则匹配**。ANSI 序列的参数部分（如 `38;5;153`）包含数字和分号，很容易被 `\w`、`\d` 等通用字符类误匹配。

2. **正确做法**：先剥离 ANSI 序列得到纯文本，在纯文本上匹配，再通过索引映射回原始位置。

3. **排查终端渲染问题时的分层思路**：
   ```
   源文本生成 → wrapAnsi 换行 → tokenize 解析 → Screen buffer → diff 比对 → 序列化 → stdout
   ```
   从最下游（stdout）开始排除，逐层向上游追溯，直到找到问题首次出现的层。

---

### 相关文件

| 文件 | 角色 |
|------|------|
| `src/components/FilePathLink.tsx` | 问题根因 + 修复位置 |
| `src/ink/terminal.ts` | diff → stdout 序列化（此处的正则修复是针对另一类交错问题） |
| `src/ink/output.ts` | Screen buffer 写入（`writeLineToScreen`） |
| `src/ink/log-update.ts` | Screen diff 生成 |
| `node_modules/@alcalzone/ansi-tokenize/` | ANSI 序列 tokenizer |
| `src/ink/wrapAnsi.ts` | ANSI 感知的文本换行 |
