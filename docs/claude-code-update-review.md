# Claude Code 更新对照（2026-09-08）

最新光标跟进：焦点返回和 stdin 空闲恢复现在会将原生光标样式标记为待恢复，在下一帧补发一次闪烁竖线，即使内容及插入位置没有变化。该标记与光标可见性分开管理，普通方向键移动仍不重设样式。83 项相关测试、格式化和类型检查通过；ConPTY 焦点切换测试正常退出，捕获到初始化及焦点返回各一次 `CSI 5 SP q`。尚未直接操控 JetBrains Reworked 验证最终绘制效果。

本次查询的[官方更新记录](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)顶部版本为 2.1.263，截图版本为 2.1.227。下面区分已落实的行为与后续候选；不表示完整移植 Claude Code。

| 方向 | 本次处理 |
| --- | --- |
| 原生输入光标 | zycode 原有能力仅默认覆盖 Windows JetBrains；现在现代终端默认启用，设置终端原生闪烁竖线样式，退出恢复默认。保留环境变量回退。修正空输入提示被行尾清除擦掉的问题。 |
| 减少无变化的渲染工作 | 输入框按文本、宽度和插入位置缓存 Cursor，避免状态栏及流式输出触发重复测量。保留渲染器无变化时零终端写入的快速路径并增加回归断言。此为对应方向的本地优化，没有宣称性能提升百分比。 |
| WebFetch 过期内存释放 | 官方记录提到过期网页滞留整个会话的问题。zycode 的 LRU 也只有惰性 TTL 清理；启用主动清理，保留 15 分钟 TTL 和 50MB 上限。 |
| 全屏及长会话优化 | [官方全屏文档](https://code.claude.com/docs/en/fullscreen)说明 alternate screen、可见消息渲染、鼠标选择和滚动。本项目已有 alternate screen、差量渲染和选择基础设施，本次没有替换整个渲染器，也没有宣称长会话内存恒定。 |
| 输出容量设置 | 最新记录包含 `bashOutputMaxChars`、`taskOutputMaxChars`，允许提高内联输出上限。暂不照搬数值：需结合 zycode 的多模型上下文预算评估。 |

X 搜索定位到 [Boris Cherny 的 NO_FLICKER 发布帖](https://x.com/bcherny/status/2039421575422980329)，但直读返回 403；该帖仅作为检索线索，技术结论以可读取的官方文档为依据。

## JetBrains Reworked 光标跟进

用户确认使用 `bun run dev` 和 Reworked，排除旧构建。本机命令解析出的 Claude Code 2.1.263 二进制为 `D:/nvm/nvm4w/nodejs/node_global/node_modules/@anthropic-ai/claude-code/bin/claude.exe`。

| 二进制字节偏移 | 分析结果 |
| --- | --- |
| 192956679 附近 | 原生光标能力缓存，与无障碍、屏幕阅读器、feature flag 和 DECSTBM 路径选择关联。 |
| 193912645 附近 | 输入组件声明相对节点的光标坐标及可见性。 |
| 192933350–192934526 | 渲染器在内容更新后停靠光标，再处理显示/隐藏；无变化时跳过写入。 |

这些是提取代码的行为分析，没有发现可直接复用的 JetBrains 专用竖线绘制分支。

本地修正：原生光标或不支持 DECSTBM 的终端不再初始化 VtPlusPlus，避免其 setup 隐藏光标和忽略光标声明；首次显示及终端重置后声明闪烁竖线样式，避免外部编辑器恢复后沿用方块，同时不在每次移动时重置闪烁；JetBrains 标识优先于通用 `TERM=dumb` 回退。提示符改为固定两列、右侧一列 padding，取消文本末尾的不换行空格。

跟进验证：格式化、类型检查、82 项相关测试通过，布局测试改为使用正式提示符组件。独立 ConPTY 测试加载实际 TextInput、完成输入/左移/插入并正常退出；原始输出包含 `CSI 5 SP q`，空输入停靠坐标为第 2 行第 3 列。该测试设置 JetBrains 环境标识，但没有运行 Reworked 本体，不能代替 IDE 内视觉验证。临时探针为 `.tmp/cursor-smoke.tsx`。

验证：`bun run format`、`bun tsc --noEmit`，以及 Ink、输入布局、输入导航、粘贴和选区相关的 81 项测试通过。Windows ConPTY 的 PowerShell 自检通过，但 `bun run dev` 仅输出终端初始化序列后启动超时，未进入设置菜单；不能据此宣称真实终端视觉验证通过。捕获文件位于 `.tmp/zycode-tui-test/zycode-cursor.raw.log` 和 `.tmp/zycode-tui-test/zycode-cursor.clean.log`。
