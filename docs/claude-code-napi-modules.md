# Claude Code 原生 N-API 模块调研

> 基于本机已安装的 Claude Code CLI `v2.1.150`
> 二进制路径：`/Users/zy979/.nvm/versions/node/v24.14.1/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`（203 MB）
> 方法：用 `grep -aob` + `dd` 从单二进制里反查字符串与 JS 实现，比对 `2.1.88` 泄漏事件中提及的 napi 包名

---

## 背景

2026 年 3 月底，Anthropic 发布的 Claude Code `0.2.88` / `2.1.88` 版本因误打包 59.8 MB source map，反推出约 51.2 万行 TypeScript 源码。源码中引用了几个 npm 上并不存在的原生 N-API 模块名：

- `color-diff-napi`
- `modifiers-napi`
- `image-processor-napi`
- `url-handler-napi`

攻击者迅速以同名抢注（注册人 `wolffiex` / `packy-anthropic`），目前是 `module.exports = {}` 空 stub —— 典型的供应链投毒占坑剧本（squat → 等人照抄泄漏源码本地编译 → 后续版本投递 payload）。

**npm 同名包禁止安装。** Anthropic 的真品并未通过 npm 分发。

---

## 总览：当前版本 2.1.150 的原生模块格局

打包方式不是 esbuild，而是 **Bun 的 single-executable（`bun build --compile`）**。原生 `.node` 文件被嵌进 cli.exe 的虚拟文件系统，运行时挂载到 `/$bunfs/root/`。

二进制里实际嵌入的 `.node` 资源：

```
/$bunfs/root/modifiers.node
/$bunfs/root/image-processor.node
/$bunfs/root/url-handler.node
/$bunfs/root/audio-capture.node          ← 2.1.88 之后新增
/$bunfs/root/computer-use-input.node     ← 2.1.88 之后新增
/$bunfs/root/computer-use-swift.node     ← 2.1.88 之后新增
```

`color-diff-napi` 在 2.1.150 中**已无任何字符串残留** —— 推测改名或下沉为纯 JS 实现。

源码结构线索：`vendor/modifiers-napi-src/` 与 `vendor/audio-capture/` 路径仍嵌在二进制里，证明 Anthropic 内部用 `vendor/<name>-napi-src/` 这套约定组织自家 napi 模块。

---

## ① `modifiers-napi` — macOS 终端修饰键状态查询

### 关键源码（已 deminify）

```js
var mj8 = {};
P_(mj8, {
  prewarm: () => Kz5,
  isModifierPressed: () => qz5,
  getModifiers: () => _z5
});

function uj8() {                                  // 单例加载
  if (tY_) return tY_;
  try {
    if (process.env.MODIFIERS_NODE_PATH)          // 允许环境变量覆盖路径
      tY_ = require(process.env.MODIFIERS_NODE_PATH);
    else {
      let H = path.join(
        path.dirname(url.fileURLToPath(
          "file:///home/runner/work/claude-cli-internal/claude-cli-internal/"
          + "vendor/modifiers-napi-src/index.ts"
        )),
        "..", "modifiers-napi", "arm64-darwin", "modifiers.node"  // 只编了 arm64-darwin
      );
      tY_ = createRequire(...)(H);
    }
    return tY_;
  } catch {
    return null;                                  // 拿不到就 null，整模块降级
  }
}

function _z5()  { let H = uj8(); if (!H) return [];    return H.getModifiers() }
function qz5(H) { let _ = uj8(); if (!_) return false; return _.isModifierPressed(H) }
function Kz5()  { uj8() }                          // prewarm（仅 dlopen 一次）
```

### 触发点

```js
if (F8.terminal === "Apple_Terminal") gi9();      // 只在 macOS Terminal.app 里预热
```

### 作用

在 macOS 系统 Terminal.app 下查询当前 Shift / Ctrl / Alt / Cmd 是否被按住。Terminal.app 不支持 Kitty keyboard protocol / CSI u 模式，无法通过 stdin 区分 Shift+Enter、Option+Enter、Cmd+键等组合 —— 所以走原生层直接读 Cocoa `NSEvent.modifierFlags` 或 `CGEventSourceFlagsState`，再回填给 TUI 的按键事件路由。

### JS 回退

| API | 没有 .node 时的返回 |
|---|---|
| `getModifiers()` | `[]` |
| `isModifierPressed(name)` | `false` |
| `prewarm()` | no-op |

**在非 macOS 或非 Apple Terminal 上整个模块是 dead code**，按键解析回退到普通 ANSI 序列。

---

## ② `image-processor-napi` — `sharp` 的原生替代实现

### 关键源码

```js
P_(V66, {
  sharp: () => fc9,
  getNativeModule: () => Mc9,
  default: () => t45
});

function Mc9() {                                   // lazy 加载，单例
  if (Dc9) return k66;
  Dc9 = true;
  try { k66 = fKq() }                              // fKq() ≡ require image-processor.node
  catch { k66 = null }
  return k66;
}

function fc9(H) {                                  // sharp(input) 等价入口
  let _ = [];
  async function q(O) {
    let T = Mc9();
    if (!T) throw Error("Native image processor module not available");  // 无 fallback
    let z = await T.processImage(H);               // 原生方法：buffer/path → image handle
    if (O) for (let $ of _) $(z);
    return z;
  }
  let K = {
    async metadata()      { ... O.metadata() ... },         // EXIF / 宽高 / 通道
    resize(w, h, opts)    { _.push($ => $.resize(w, h, opts)); return K },
    jpeg(o)               { _.push(T => T.jpeg(o?.quality)); return K },
    png(o)                { _.push(T => T.png(o));            return K },
    webp(o)               { _.push(T => T.webp(o?.quality));  return K },
    async toBuffer()      { ... O.toBuffer() ... }
  };
  return K;
}
```

### 身份认定

紧跟其后的代码段含有：

```
Copyright 2013 Lovell Fuller and others.
SPDX-License-Identifier: Apache-2.0
```

—— Lovell Fuller 是 [`sharp`](https://sharp.pixelplumbing.com/) 库作者。`image-processor-napi` 是 **`sharp` 的接口克隆 + 原生实现**（很可能直接链 libvips，或换成更小的依赖）。

### 用途

- **Read 工具读取 PNG/JPEG/WEBP/GIF 图片**时的解码与缩放
- 终端贴图 / 截图压缩到模型可接受的尺寸（一般 ≤ 1568 px、≤ 1 MB）
- 处理剪贴板里的图像（二进制中相关字符串：`image-in-clipboard`、`image-paste`）

### JS 回退

**无。** 原生模块缺失直接 `throw Error("Native image processor module not available")` —— Read 图片会失败、贴图功能不可用。

---

## ③ `url-handler-napi` — 系统级 `claude://` 协议处理器

这个比另外两个特殊：**它不是单纯的 napi 模块，而是一个独立的伴生子程序 + 一个 .node**。

### 字符串证据

```
com.anthropic.claude-code-url-handler         ← macOS bundle id
Claude Code URL Handler                        ← 应用名
Claude Code URL Handler.app                    ← macOS .app bundle
claude-code-url-handler.desktop                ← Linux .desktop entry
--handle-uri                                   ← 子程序 CLI flag
main_function_start
main_warning_handler_initialized
main_client_type_determined
main_before_run
main_after_run
```

### JS 侧接口（在 main.ts 入口附近）

```
waitForUrlEvent
handleUrlSchemeLaunch
handleDeepLinkUri
```

### 机制（综合推断）

| 平台 | 注册方式 |
|---|---|
| macOS  | `LSRegisterURL` + Info.plist 注册 `Claude Code URL Handler.app` 为 `claude://` scheme 的默认 handler |
| Linux  | 装 `claude-code-url-handler.desktop` + 调 `xdg-mime` |
| Windows | 写注册表 `HKCU\Software\Classes\claude\shell\open\command` |

调用流：浏览器点 `claude://...` → 启动 handler app → handler 以 `--handle-uri` 把 URL 转发给主 cli 进程（IPC / unix socket）→ 主进程 JS 侧通过 `waitForUrlEvent` / `handleDeepLinkUri` 接收事件。

### 用途

- **OAuth 登录回调**（浏览器 → CLI）
- **Teleport / Ultraplan 工作流**：浏览器编辑完计划后用 `claude://teleport?id=...` 回到 CLI
- claude.ai 网页上的"Open in Claude Code"按钮

### JS 回退

未观察到独立 fallback —— url-handler 未安装时相关深链 no-op，OAuth 回退到设备代码 / 手动复制粘贴模式。

---

## 与泄漏事件 (`0.2.88` / `2.1.88`) 的对照

| 包名 | 2.1.88 泄漏中提及 | 2.1.150 字符串残留 | 当前形态 |
|---|---|---|---|
| `color-diff-napi` | ✓ | **✗ 已消失** | 推测下沉为 JS / 改名 |
| `modifiers-napi` | ✓ | ✓ 5 处 | 仍是 napi，仅 macOS Apple Terminal 启用 |
| `image-processor-napi` | ✓ | ✓ 6 处（`image-processor.node`）| 仍是 napi，sharp 兼容接口 |
| `url-handler-napi` | ✓ | ✓ 6 处（`url-handler.node`）| napi + 独立子程序 / .app bundle |
| `audio-capture-napi` | — | ✓ 10+ 处 | **新增**（语音输入 / 录音）|
| `computer-use-input-napi` | — | ✓ 多处 | **新增**（鼠标键盘事件注入）|
| `computer-use-swift-napi` | — | ✓ 多处 | **新增**（macOS Swift 系 Computer Use 桥）|

---

## 结论

1. 泄漏后 Anthropic **没有移除**这些原生模块，反而扩展了原生模块矩阵（新增 audio / computer-use 三个）。
2. 真正的实现以 **Bun single-executable** 形式直接嵌进官方 cli 二进制，**不通过 npm 分发**：用户不会误装到占坑包，攻击者也无法靠 npm 抢注影响官方安装路径。
3. 三个原模块的真实职责并非 npm 上的空 stub，而是：

   | 模块 | 一句话职责 |
   |---|---|
   | `modifiers-napi`      | macOS Apple Terminal 下查询键盘修饰键状态，弥补该终端不支持 CSI u 的缺陷 |
   | `image-processor-napi` | `sharp` 接口克隆 + 原生图像解码 / 缩放 / 编码，供 Read 图片与剪贴板贴图使用 |
   | `url-handler-napi`    | 系统级 `claude://` URL scheme handler，承载 OAuth 回调与 Web ↔ CLI 跳转 |

4. **任何人都不应该 `npm install` 这些名字的包** —— 真品在 cli.exe 里，npm 上的是占坑空壳，未来随时可能被注入恶意 payload。

---

## 复现方法

```bash
CLAUDE_BIN="$(readlink -f "$(which claude)")"
case "$CLAUDE_BIN" in
  *.exe) ;;
  *) CLAUDE_BIN="$(dirname "$CLAUDE_BIN")/claude.exe" ;;
esac

# 检查 .node 资源
LC_ALL=C grep -aoE '[a-z][a-z0-9-]+\.node' "$CLAUDE_BIN" | sort -u

# 定位字符串字节偏移
grep -aob 'modifiers-napi'       "$CLAUDE_BIN" | head
grep -aob 'image-processor.node' "$CLAUDE_BIN" | head
grep -aob 'url-handler.node'     "$CLAUDE_BIN" | head

# 提取附近 JS 代码块
LC_ALL=C dd if="$CLAUDE_BIN" bs=1 skip=<offset> count=5000 2>/dev/null \
  | LC_ALL=C tr -d '\0' > /tmp/chunk.txt
```
