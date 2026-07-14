# AGENTS.md

## 必须遵守

- 注释用中文、标识符用英文；非显然逻辑需说明意图和取舍。
- 用户可见文本必须走 i18n，英文和中文翻译同步添加。
- 相对导入必须带 `.js`；禁止滥用 `as any`。
- 共享状态进入 `AppStateStore`；运行时能力通过 `bootstrap/runtime/runtimeContext.ts` 注入。
- `src/utils/` 只放无业务语义、无 IO 的纯函数；新模块不得放在 `src/` 根目录。
- 正式实现只能有一处；禁止新增兼容 re-export、空占位文件或未登记删除计划的兼容入口。
- 不引入未评估依赖，不手改 `dist/`，不修改 `build.ts` 的 `define` 宏值。
- 修改代码后必须运行 `bun run format` 和 `bun tsc --noEmit`；相关测试用 `bun test`。

## 按需阅读

涉及目录、命名、Tool、LLM 类型、测试或 feature 宏时，先读
[开发规范](docs/development-guidelines.md)。

架构、功能开关和配置分别参考：

- [架构](docs/architecture.md)
- [Feature Flags](FEATURE_FLAGS.md)
- [配置参考](docs/configuration.md)

## 常用命令

```bash
bun run build
bun run dev
bun run format
bun tsc --noEmit
bun test
```
