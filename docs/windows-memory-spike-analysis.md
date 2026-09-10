# Windows 下内存飙升至 4GB 的原因深度分析报告

## 一、现象概述

- **用户反馈**：在 macOS 环境下运行长会话或密集任务时，内存占用通常平稳（约 200MB ~ 600MB），波动不明显；但在 Windows 环境下，进程内存有时会异常飙升至 **3GB ~ 4GB**，严重占用系统资源甚至导致卡顿或 OOM 崩溃。
- **项目技术栈**：基于 **Bun (v1.3+)** + **JavaScriptCore (JSC)** + **React 19 (Ink)** + **TypeScript** 的终端 CLI 工具。

---

## 二、为什么是 4GB？（4GB 的特殊含义）

在当前技术架构下，**4GB（$2^{32}$ 字节）**具有非常清晰的技术界限与系统意义：

1. **JavaScriptCore 的 Gigacage 虚拟保护区**：
   Bun 底层采用 WebKit 的 JavaScriptCore 引擎。在 64 位系统上，JSC 默认使用大小为 **4GB 的 Gigacage** 连续虚拟地址段来约束与保护 JSObject、TypedArray 和 String 缓冲区。当分配量触碰或逼近该区域时，极易产生地址空间耗尽与严重停顿。
2. **V8 / Node.js 兼容上限**：
   若处于 Node.js 兼容运行环境，64 位系统上默认的 `max_old_space_size` 正是 **4096MB（4GB）**。在项目已有代码中（如 `src/commands/mem/mem.ts`），明确设置了 `heapLimit > 4 * GB` 的预警线。
3. **Windows 内存管理与虚拟提交极限**：
   在 Windows 操作系统中，若单一进程提交的虚拟页面（Commit Charge）累积至 4GB 附近，通常已达到底层单向棘轮与堆外小对象碎片化的累积临界点。

---

## 三、根本成因分析（五大层级）

经过对代码库实现、系统差异与底层分配器的排查，结合实测基准，内存飙升是由**底层分配器特性**与**上层平台差异路径**共同引发的复合问题：

### 1. 底层 Allocator 差异：mimalloc 在 Windows 下的“内存单向棘轮效应”（核心根因）

这是造成 **“Mac 不明显、Windows 飙升”** 最根本的系统级差异。

- **macOS (Darwin) 的内存管理**：
  - Darwin 内核原生具备高效的全局内存压缩器（`vm_compressor`）。
  - 当 JavaScriptCore 发生 GC 并释放内存时，macOS 分配器通过 `madvise(MADV_FREE)` 或 `madvise(MADV_DONTNEED)` 标记页面。macOS 内核会迅速释放或压缩这些背后的物理内存页。
  - 进程向系统汇报的真实物理常驻（RSS / `phys_footprint`）会**平稳回落**。
- **Windows (NT) 的内存管理与 Bun mimalloc 行为**：
  - Windows 采用严格的 `VirtualAlloc` 提交（`MEM_COMMIT`）与释放（`MEM_DECOMMIT`）模型。
  - Bun 在 Windows 上的核心内存分配器是 `mimalloc`。在 Windows 上调用 `VirtualFree(..., MEM_DECOMMIT)` 属于重量级内核系统调用（需要修改页表并刷新 TLB），因此 `mimalloc` 默认将释放的内存块保留在其内部的 Arena 和 Segment Cache 中，**几乎从不主动调用 decommit 归还给 Windows**。
  - **实测验证**（在 Windows 本机通过 Bun 执行垃圾回收验证）：
    ```text
    测试：分配 500 万个临时 JS 对象（生成约 400MB 堆）后全部置空并触发 5 轮完整 GC：
    - GC 之后 JSC Heap Size: 0.2 MB （JS 堆已彻底清空至 200KB）
    - 此时 Process RSS: 728.0 MB （物理常驻完全未降！）
    - 此时 Commit Current: 919.6 MB （系统提交量完全未降！）
    - mimalloc stats: purges: 0, purge_calls: 0 （释放给 OS 的调用次数为 0！）
    ```
  - **结论**：在 Windows 上，**进程的物理内存占用呈现单向递增的“棘轮（Ratchet）”特性**。哪怕只是短时间内产生了一次大内存分配（例如大文件搜索、大量消息索引、Markdown 渲染），高水位线一旦建立，就会永久留在进程的 Working Set 和 Commit 内存中。后续操作只要发生波动，就会在原有高水位基础上继续推升，直至 **4GB** 触顶。

---

### 2. 堆外内存放大效应：小对象碎片对 Windows Working Set 的放大（3.8x 放大）

在 Windows 的内存分配模型下，密集的微小对象（如 Map、Set、小字符串）会造成严重的堆外碎片化。

- **实测基准对照**（`scripts/bench-memory-retention.ts`，3000 行历史消息索引构建）：
  - **JS 堆增量（Heap Delta）**：`893.86 MB`
  - **Windows 进程实际 RSS**：**`3415.87 MB`（约 3.42 GB）**
  - **放大系数**：**高达 3.82 倍！**
- 在 macOS 上，由于 Darwin 内核的页合并与物理页回收，同样 900MB 的 JS 堆负载，其实际物理 RSS 通常仅为 1.1GB ~ 1.3GB。
- **这意味着：在 Windows 上，只要应用层产生约 900MB ~ 1GB 的瞬时堆压力，就会被系统直接放大成近 4GB 的系统级物理占用！**

---

### 3. 文件建议与 ripgrep 回退机制陷阱 (`src/hooks/fileSuggestions.ts`)

这是最容易引发“突发式”内存飙升的应用层触发点：

1. **Windows 下 `git ls-files` 超时**：
   - Windows 创建进程（`CreateProcessW`）开销比 POSIX `fork/exec` 慢数十倍。
   - `getFilesUsingGit` 设置了硬性 `timeout: 5000`（5 秒）。在大型仓库、包含 submodules 或处于 Windows Defender 实时扫描拦截的环境下，`git.exe` 极易超过 5 秒而失败返回 `null`。
2. **回退至 `ripgrep --follow` 遭遇 NTFS 连接点（Junction Points）膨胀**：
   - 当 git 超时或在非 git 仓库运行时，会回退到：
     ```ts
     const rgArgs = ['--files', '--follow', '--hidden', '!.git/', ...]
     ```
   - **`--follow` 在 Windows 上的致命隐患**：Windows NTFS 文件系统广泛存在目录连接点（Junction Points，例如 `AppData\Local\Application Data` 指向父目录形成递归），或用户在根目录下运行。开启 `--follow` 会导致 ripgrep 穿透符号链接，扫描出数十万甚至上百万个文件路径（直至达到 20MB 的 stdout 限制）。
3. **5 秒轮询无休止重建死循环**：
   - 检查 `startBackgroundCacheRefresh()`：当用户在非 git 目录中启动时，`getGitIndexMtime()` 始终返回 `null`，导致 `gitStateChanged` 永远为 `false`。
   - 代码会落入 `Date.now() - lastRefreshMs >= 5000` 条件：**每 5 秒在后台无条件重新触发一次全盘扫描与 FileIndex 重建**。
   - 每次重建都会对几十万条路径进行字符串切分（`getDirectoryNamesAsync`）并创建 `FileIndex`（包含 `paths`、`lowerPaths`、`charBits: Int32Array`、`pathLens: Uint16Array`）。
   - 结合前述的**单向棘轮效应**，仅此一项在数分钟内即可在 Windows 上吃掉数个 GB 内存。而在 Mac 上，`git ls-files` 耗时 <50ms，且无 Junction 循环问题，几乎不会发生此问题。

---

### 4. 历史消息与工具索引的 $O(n^2)$ 引用累积（未裁剪前或未重启的历史会话）

- 在前序排查（`docs/memory-retention-review-2026-09-09.md`）中确认：
  - `Messages.tsx` 原先在渲染历史消息行时，将完整的 `lookups` 传入每个 `MessageRow`。
  - 由于 React 的 `OffscreenFreeze` 和 `React.memo` 跳过了旧行的更新，每一个历史消息行都强持有了对应那一轮的历史全量工具索引 Map/Set。
  - 随着对话轮次增加，累积的历史索引条目达到 $O(n^2)$。
- 在我们的实测中，3000 行历史消息在未裁剪状态下保留了 **450 万个工具索引条目**，单次占用即推升 **3.4GB RSS**。
- 若用户运行在未引入 `scopeMessageLookups` 的旧构建、未重启的旧进程、或者在子代理（Subagent）与 Transcript 视图等未裁剪的代码路径上，长会话必然会直接冲破 4GB。

---

### 5. Windows 终端（ConPTY / JetBrains JediTerm）高频重绘与缓存暴涨

- **终端兼容层导致高频重绘**：
  - Windows Terminal 与 JetBrains Terminal（JediTerm）存在大量特殊的转义字符、光标控制和宽度测量问题（见 `src/ink/ink.tsx` 的 `usesJediTermLayoutQuirks`）。
  - 在大模型流式输出时，每一个 chunk 都会触发行宽、字素测量（`get-east-asian-width`、`bidi-js`）。
- **缓存占用随高水位滞留**：
  - 历史版本中字素缓存允许 16384 行展开对象，行宽缓存允许 4096 条无长度限制字符串，Markdown AST 和 ANSI 高亮缓存未加容量限制。
  - 在 Mac 上这些临时对象的缓存在淘汰后能被操作系统迅速回收；但在 Windows 下，这些短期分配触发的页提交被永久锁定在 mimalloc 缓存中，直接助推了 4GB 的上限。

---

## 四、Mac vs Windows 差异总结与归因矩阵

| 维度 | macOS (Darwin) | Windows (Win32 / NT) | 差异对内存的影响 |
| :--- | :--- | :--- | :--- |
| **内存释放给 OS** | 支持 `madvise(MADV_FREE)` 与内核内存压缩；GC 后物理常驻立即回落 | `mimalloc` 极少调用 `VirtualFree(MEM_DECOMMIT)`，`purged` 始终为 0 | **Windows 具有单向棘轮效应，内存高水位只升不降** |
| **堆外碎片放大比** | 通常在 1.2x ~ 1.5x 左右 | 实测高达 **3.8x**（893MB Heap → 3.4GB RSS） | 相同业务负载在 Windows 下被操作系统放大近 4 倍 |
| **Git 进程执行速度** | 基于 POSIX `fork/exec`，极快（<50ms） | 基于 Windows `CreateProcess`，开销大（常 >500ms ~ 5s） | Windows 下 `git ls-files` 极易超过 5s 超时回退到 ripgrep |
| **Ripgrep 遍历隐患** | Unix 软链接标准，极少递归死循环 | NTFS Junction（连接点）易引发目录嵌套死循环 | Windows 下 `--follow` 易扫出海量文件使 `FileIndex` 撑爆内存 |
| **文件建议刷新** | git 快照更新快速，几乎不空转 | 非 git 目录下 `getGitIndexMtime()` 恒空，每 5 秒全量重扫一次 | 在 Windows 下构成高频全量分配循环 |
| **文件监控实现** | Bun 原生 FSEvents，$O(1)$ fd，无死锁无额外轮询 | 为规避 Bun #27469 死锁，需走轮询模式（`usePolling`） | Windows 下轮询遍历消耗更多内存与句柄对象 |

---

## 五、后续优化建议（Actionable Improvements）

针对以上深层原因，后续可在项目中采取以下专项治理措施：

1. **治理 `src/hooks/fileSuggestions.ts`（收益最大、最紧迫）**：
   - **移除 Windows 下 ripgrep 的 `--follow` 选项**，或在 Windows 下默认禁用符号链接跟随，避免被 NTFS Junction 循环拖垮。
   - **优化非 Git 目录下的刷新节流**：当不在 Git 仓库内时，禁止每 5 秒自动全量扫描，改为仅在用户主动输入 `@` 触发文件补全时按需扫描。
   - **为 `FileIndex` 设置条目硬上限**（如最多保留 30,000 ~ 50,000 个文件），超过限制时截断并提示，防止超大目录把内存撑爆。
2. **长会话主动垃圾清理与内存压缩**：
   - 用户可运行 `/compact` 压缩上下文，或通过 `/clear` 清空缓存。
   - 探索在 Windows 平台上的空闲时刻（如每轮对话完成后），显式调用底层 JSC/GC 清理，必要时探索针对 mimalloc 的主动 purge 方案。
3. **保持依赖升级与关注 Bun 上游**：
   - 持续关注 Bun 官方关于 Windows 平台内存释放与 `mimalloc` 的优化进展（如 upstream issue oven-sh/bun#4933 等）。
