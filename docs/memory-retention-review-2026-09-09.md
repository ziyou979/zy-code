# 长会话内存保留排查（2026-09-09）

## 已确认的区别

Claude Code 官方发布记录的 2.1.246 条目明确说明：全屏和 Ctrl+O 转录视图中的消息行不再保留整份会话工具索引。
来源：https://platform.claude.com/docs/en/release-notes/claude-code

本机 Claude Code 2.1.263 二进制也存在对应实现：在字节偏移约 204926400 的 JavaScript 中，行级索引投影只选取本行工具的结果、进度及 hook；同级工具只补入完成状态。其投影缓存用 WeakMap，源索引用 WeakRef，不用历史快照作为强引用缓存键。偏移仅适用于本次检查的二进制。

zycode 原先在 Messages 中直接将完整 lookups 传入 MessageRow。MessageRow 的 React.memo 比较器会跳过已完成行，Message 和 OffscreenFreeze 也会保留静态子树，因此每个历史行能钉住不同版本的整份 Map/Set。若每轮追加工具行，历史索引条目累积为 n(n+1)/2。共享工具内容虽然没有深拷贝，但索引容器、分组 Set 和旧消息引用仍不能回收。大量输出与历史消息内容会进一步放大影响。这是可解释 GB 级增长的路径，但未对用户当时的进程采集堆快照，不能断言它是唯一原因。

## 实现

- 在进入 MessageRow 之前调用 scopeMessageLookups，只传入本行工具数据；同级工具只保留完成状态，保留 hook、错误、组合行和 sourceToolUseID 的查询语义。投影没有指向原始完整 lookups 的引用或闭包，不引入额外全局缓存。
- 字素缓存原先允许 16384 行，每行展开为每字符一个对象；仅按行数限制无法限制长行占用。改用已有 lru-cache，容量预算 8 MiB，单条 256 KiB，插入时立即淘汰，保留原有条数上限。
- 行宽缓存原先允许 4096 个任意长度字符串，流式长行的历史版本可能累计驻留。增加 1 MiB 容量预算、16 KiB 单条上限，超大行照常测量但不保留。

容量是保守的载荷估算，不是 JS 引擎内存或 RSS 的硬上限。会话正文、屏幕缓冲区、子进程以及一次大输出的临时分配仍需内存；此次没有通过删除历史消息来降低占用。

## 可复现实验

在两个新 Bun 进程中运行：

```powershell
bun scripts/bench-memory-retention.ts full 1500
bun scripts/bench-memory-retention.ts scoped 1500
```

脚本模拟静态行保留挂载时的索引，不发送模型请求，不执行工具，也不启动完整 TUI。两种模式均使用同一 buildMessageLookups，区别仅是进入保留数组前是否裁剪。GC 后读取 process.memoryUsage，RSS 包含运行时与分配器保留空间。

| 路径 | 历史行 | 保留的工具索引条目 | JS 堆增量 | 进程 RSS | 构建及 GC 用时 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 原全量索引 | 1500 | 1125750 | 251.6 MiB | 1181.6 MiB | 534.6 ms |
| 行级投影 | 1500 | 1500 | 23.6 MiB | 349.5 MiB | 326.2 ms |

这是单次本机定向实验，不是产品启动/首 token 延迟基准，也不是 Claude Code 与 zycode 全应用 RSS 对比。不能把这些数值作为长期运行的固定上限。

回归测试覆盖：本行工具与同级状态、无关数据排除、hook 计数、纯文本与组合行、300 条历史快照的线性保留量、字素缓存容量淘汰、超大条目不驻留、淘汰后中文重绘、Unicode/ANSI 行宽。另运行 Ink、消息规范化与虚拟列表相关测试，以及项目格式化和 TypeScript 检查。

实际使用需重启 bun run dev 才能释放旧进程中已保留的历史对象。完整长时间真实工具会话的内存峰值仍需实际运行验证。


## 第二轮检查

继续发现并修复两处只限制 500 项的全局缓存：

- Markdown 的哈希键不保留完整源字符串，但 Token 的 raw/text 和嵌套节点依然保留内容。新增 8 MiB 估算容量与 512 KiB 单项上限；按解析树中的字符串、对象和字段引用估算，超限停止遍历并跳过缓存。
- 代码高亮缓存值为完整 ANSI 字符串，增加 8 MiB 估算容量和 512 KiB 单项上限。缓存命中仍复用结果，淘汰后可重新计算，超大结果照常返回。

两处正式实现分别移至 src/markdown/lexerCache.ts 和 src/services/terminal/highlightCache.ts，组件直接使用，不保留重复实现。模块有独立的缓存生命周期和测试接口；未引入新依赖。

另修复 Markdown 仅采样前 500 字符的检测：长正文后出现的代码围栏、列表现在会进入完整解析。此变更会让原先被错误跳过的 Markdown 正常执行解析，因此这类内容的首次渲染需要承担解析成本。

验证：13 项测试通过，覆盖缓存复用、容量驱逐、超大条目不驻留、尾部 Markdown、流式边界与实际组件换行；bun run format 与 bun tsc --noEmit 通过。此次未做完整应用的长期 RSS 对照，不据缓存预算推导进程内存上限。

抽查排除项：ShellCommand 的 abort 监听器已有显式清理；memoizeWithTTLAsync 当前生产调用点为无参数的 metrics 检查，只有一个缓存键。StructuredDiff 的 WeakMap 内部已限制每个 hunk 四个渲染变体。它们没有在本轮提供足以归因长期 GB 增长的证据，因此未作推测性修改。
