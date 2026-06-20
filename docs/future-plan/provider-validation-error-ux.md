# Provider 配置错误提示体验优化计划

## 背景

当用户在 `settings.json` 或 `.zy/settings.local.json` 中配置了一个不存在的 `provider` 时，当前行为不够友好：

- **交互模式**：会弹出 `InvalidSettingsDialog`，但提示是 Zod 默认的 `Invalid value. Expected one of: ...`，对普通用户不够直观。
- **非交互/headless 模式**：直接跳过弹窗，错误只进入 debug log 和内部通知，命令行用户完全感知不到，造成“没有提示”的体验。

## 目标

1. 让 `provider` 校验失败的提示更明确、更可操作。
2. 非交互模式下至少把 settings 校验错误输出到 stderr，避免静默失败。

## 改动点

### 1. 给 `provider` 字段增加专属校验提示

- **文案**：新增 i18n key `settings.validation.provider.invalid`。
  - 中文：`provider 不是已注册的 AI 平台。请检查拼写，或运行 /config provider 查看可用平台。`
  - 英文：`Provider is not a registered AI platform. Check the spelling or run /config provider to see available platforms.`
- **文件**：
  - `src/i18n/locales/zh-CN/settings.ts`
  - `src/i18n/locales/en/settings.ts`
- **匹配逻辑**：在 `src/utils/settings/validationTips.ts` 新增 `TipMatcher`：
  - 匹配条件：`path === 'provider' && code === 'invalid_value'`
  - 返回上述 i18n 提示，并附带 `https://code.zy.com/docs/en/settings` 文档链接。

### 2. 非交互模式下输出 settings 校验错误

- **位置**：`src/cli/commands/root.ts`，在交互模式弹窗分支之后增加 `else` 分支。
- **逻辑**：
  - 调用 `getSettingsWithErrors()`；
  - 过滤掉 `mcpErrorMetadata` 相关的 MCP 错误（与交互模式保持一致）；
  - 如果还有错误，用 `writeToStderr` 输出：
    ```
    Settings validation errors:
      <file>: <path>: <message>
    ```
  - **不退出进程**，继续运行，避免破坏现有脚本。

### 3. 验证

- `bun tsc --noEmit` 无类型错误。
- `bun run format` 格式化通过。
- 手动验证：
  - 将 `provider` 设为一个不存在值，交互模式下弹窗应出现更明确的提示。
  - 使用 `--print` 等非交互参数启动，stderr 应出现错误信息。

## 受影响的文件

- `src/i18n/locales/zh-CN/settings.ts`
- `src/i18n/locales/en/settings.ts`
- `src/utils/settings/validationTips.ts`
- `src/cli/commands/root.ts`

## 注意事项

- 保持向后兼容：非交互模式仅输出警告，不强制退出。
- 所有新增用户可见文案必须同步加入中英文 i18n。
- 不要在 `utils/` 里新增文件，settings 相关逻辑保持在 `src/utils/settings/` 和 `src/cli/commands/`。
