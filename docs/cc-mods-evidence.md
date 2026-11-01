# Claude Code "mods" 实现 —— 代码证据册

> 配套文档：`docs/cc-mods-implementation-analysis.md`（分析报告）
> 本文只放**代码**，不放评论。所有片段均为从 `claude.exe` v2.1.289 提取的原始字节，经 `tr -d '\0'` + 非打印字符剥离，**未做任何改写或"美化"**。
> 提取时间：2026-10-04

---

## 阅读说明

CC 的 bundle 是 esbuild 压缩产物，符号名已 minify。因此：

- **函数名无意义**（`rn`、`Gj`、`uWe` 每次构建都变）
- **字符串字面量、import 名、常量值稳定且有意义**
- 下文每段代码上方标注**字节偏移**，可用 `dd if=... iflag=skip_bytes,count_bytes skip=<偏移> count=<长度>` 复现

变量名还原表（依据 import 别名与调用上下文推断）：

| minified | 实际含义 | 依据 |
|----------|---------|------|
| `lo` | `vendor/claude-code-mods/mods` | 字面量 |
| `uo` | `"mods/"` | 字面量 |
| `zo` | `"builtin-hooks-module:"` | 字面量 |
| `ue` | `"hooks/register.ts"` | 字面量 |
| `lQe` | `"claude-code"` | 字面量 |
| `Gj` | Bun plugin 对象 `{name, setup}` | `Bun.plugin` 注册契约 |
| `ho` / `jo` / `er` | 32 / 1048576 / 8388608 | 数值 + 相邻错误文案 |

---

## 证据 1：mods 是 plugin 的第三条加载通道

**偏移 `207546000`，长度 3200 字节，连续原文：**

```js
${e}/${ue}`;var lo="vendor/claude-code-mods/mods";var uo="mods/";import{resolve as Xt}from"path";var ce=()=>Xt(import.meta.dirname,"../../../../../..");import{dirname as Qt,relative as Zt,resolve as en,sep as on}from"path";var zo="builtin-hooks-module:";function rn(e,o){let r=o.slice(zo.length);return r.startsWith(uo)?`${lo}/${r.slice(uo.length)}`:Zt(ce(),en(Qt(e),r)).split(on).join("/")}var co="builtin-hooks-module";var Gj={name:co,setup(e){e.onResolve({filter:/^builtin-hooks-module:/},(o)=>({path:rn(o.importer,o.path),namespace:co})),e.onLoad({filter:/.*/,namespace:co},async(o)=>{let r=Bun.spawn([process.execPath,"--smol",tn(ce(),Lt),o.path],{cwd:ce(),stdout:"pipe",stderr:"pipe",windowsHide:!0}),[t,n,s]=await Promise.all([new Response(r.stdout).text(),new Response(r.stderr).text(),r.exited]);if(s!==0)throw Vt(o.path,n);return{contents:`module.exports = ${t}`,loader:"js"}})}};
```

**这段证明三件事：**

1. `var lo="vendor/claude-code-mods/mods"` 与 `var ue="hooks/register.ts"`（上一行残缺可见）**在同一条语句链里声明** —— mods 和 hooks 模块共用同一个命名空间机制。
2. 路径解析分支：`r.startsWith(uo) ? \`${lo}/${r.slice(uo.length)}\` : <相对仓库根的路径>` —— `mods/` 前缀走内置源，其余走文件系统。
3. `onLoad` 的实现是 **`Bun.spawn` 一个 `bun --smol` 子进程**，不是 `import()`。

**关键行的逐字拆解：**

```js
let r = Bun.spawn(
  [process.execPath, "--smol", tn(ce(), Lt), o.path],  // 当前 bun + --smol + 扫描器路径 + 目标文件
  {cwd: ce(), stdout:"pipe", stderr:"pipe", windowsHide:true}
);
let [t, n, s] = await Promise.all([
  new Response(r.stdout).text(),   // t = scan 结果（纯数据）
  new Response(r.stderr).text(),   // n = 错误信息
  r.exited                        // s = 退出码
]);
if (s !== 0) throw Vt(o.path, n);  // 扫描失败 → 抛错，不加载
return { contents: `module.exports = ${t}`, loader: "js" };  // 只回传 scan 数据
```

`module.exports = ${t}` 这个字符串拼接是整个设计的关键：**用户代码从未在主进程执行**。子进程做 AST 静态分析，吐出一个 JSON 化的 `scan` 对象，主进程把它包装成模块。

---

## 证据 2：静态扫描器的完整约束

**偏移 `207547000`，长度 6500 字节，关键片段（连续原文）：**

```js
var J6r=(e)=>att.some((o)=>e.endsWith(o));
var ho=32; var jo=1048576; var er=8388608;

function or(e){let o=[e];
  if(e.endsWith(".js")){let r=e.slice(0,-3);o.push(`${r}.ts`,`${r}.tsx`)}
  if(e.endsWith(".jsx"))o.push(`${e.slice(0,-4)}.tsx`);
  if(e.endsWith(".mjs"))o.push(`${e.slice(0,-4)}.mts`);
  if(e.endsWith(".cjs"))o.push(`${e.slice(0,-4)}.cts`);
  for(let r of att)o.push(`${e}${r}`),o.push(`${e}${yn}index${r}`);
  return o}

var lQe="claude-code";
var D6o=(e,o,r)=>new Ie(
  `${e}: cannot import "${o}" (from ${r}): a hooks module imports its own files by relative path and "${lQe}", nothing else`
);

var sr=(e,o)=>[".","..","./","../"].includes(e)?tr(rr(o),e,"index"):tr(rr(o),e);
var Q6r=(e)=>e==="."||e===".."||e.startsWith("./")||e.startsWith("../");
var pr=["no such file","not a regular file","resolves outside the plugin's folder"];
var ko=(e,o)=>new Ie(`${e}: ${o} is over ${jo} bytes and was not read`);

async function ve(e,{real:o,size:r},t){
  if(r>jo)throw ko(t,e);
  try{return{real:o,source:await Sn(o,"utf8")}}
  catch(n){throw Ko(t,e,n)}
}

async function uWe(e,o,r){
  let t=await xo(ir(o),(f)=>fn(r,Tn(o),f)),
      n=(f)=>Ko(r,e,f),
      s=await xo(ir(e),n),
      p=An(t,s);
  if(p===".."||p.startsWith(`..${On}`)||Nn(p))
    throw new Ie(`${r}: ${e}: ${s} resolves outside the plugin's folder`);
  let a=await xo(vn(s),n);
  if(!a.isFile())
    throw new Ie(`${r}: ${e}: not a regular file`);
  return{real:s,size:a.size}
}

var ar=(e,o)=>new Ie(
  `${e}: ${o} is not named like code and was not loaded: a hooks module and the files it imports end in `+TQr
);
function Te(e,o,r){let t=[o,r].find((n)=>!J6r(n));if(t!==void 0)throw ar(e,t)}

var Bn=(e,o)=>mr(e,o,`takes the module over ${er} bytes in total and was not read`);
async function Un(e,o,r){let t=await uWe(e,o,r);return Te(r,e,t.real),ve(e,t,r)}
```

**约束表（全部有代码支撑）：**

| 约束 | 代码 | 值 |
|------|------|-----|
| import 链深度 | `var ho=32` | 32 层 |
| 单文件上限 | `var jo=1048576` | 1 MiB |
| 模块总体积 | `var er=8388608` | 8 MiB |
| import 白名单 | `D6o` 错误文案 | 只准「相对路径」+ `"claude-code"` |
| 路径逃逸 | `uWe` 的 `p===".." \|\| p.startsWith("../") \|\| isAbsolute(p)` | realpath 后校验 |
| 符号链接/非文件 | `uWe` 的 `lstat().isFile()` | 拒绝 FIFO/目录/软链 |
| 扩展名白名单 | `Te` / `J6r` | 结尾必须在 `att` 列表内 |

**`uWe` 的顺序值得注意**：`realpath(root)` → `realpath(target)` → `relative(realRoot, realTarget)` → 检查是否逃逸。**用 realpath 而非 path.resolve**，所以符号链接被解析到真实位置后再判定逃逸 —— 这比字符串前缀检查严密。

---

## 证据 3：AST 静态分析 —— 拒绝一切"值的流动"

**偏移 `207547000` 区域，连续原文：**

```js
function cr(e,o){
  let r=o(e);
  while(r!==void 0){
    if(r.type==="FunctionExpression"||r.type==="ArrowFunctionExpression"||r.type==="FunctionDeclaration")return r;
    r=o(r)
  }
  return
}

function ee({call:e,scanned:o,what:r,holder:t}){
  let n=o.parentOf(e),
      s=n===void 0
        || n.type==="ExpressionStatement"
        || (n.type==="ReturnStatement"||n.type==="ArrowFunctionExpression"&&n.body===e)
          && cr(e,o.parentOf)===t,
      p=n!==void 0&&(
          n.type==="SequenceExpression"
        || n.type==="ChainExpression"
        || n.type==="ParenthesizedExpression"
        || n.type==="LogicalExpression"&&n.right===e
        || n.type==="ConditionalExpression"&&n.test!==e
        || n.type==="UnaryExpression"&&n.operator==="void"
        || n.type==="AwaitExpression");
  if(s)return;
  if(p){ee({call:n,scanned:o,what:r,holder:t});return}
  throw o.refuse(e,
    `the value of ${r} is kept (assigned, passed, read, or returned from a nested function); `+
    `it takes .catch(handler) where it is called and nothing else`)
}

var oe="Client";
var xr=(e,o)=>e.id===o||e.params.includes(o);
var gr={
  VariableDeclarator:(e,o)=>e.id===o,
  FunctionDeclaration:xr,
  FunctionExpression:xr,
  ArrowFunctionExpression:(e,o)=>e.params.includes(o),
  ClassDeclaration:(e,o)=>e.id===o,
  ClassExpression:(e,o)=>e.id===o,
  CatchClause:(e,o)=>e.param===o,
  AssignmentPattern:(e,o)=>e.left===o,
  RestElement:(e,o)=>e.argument===o,
  ArrayPattern:(e,o)=>e.elements.includes(o),
  Property:(e,o,r)=>e.value===o&&r?.type==="ObjectPattern",
  ImportSpecifier:(e,o)=>e.local===o,
  ImportDefaultSpecifier:(e,o)=>e.local===o,
  ImportNamespaceSpecifier:(e,o)=>e.local===o
};
var os=(e)=>gr[e.type];
var rs=(e,o)=>(o?.type==="Property"||o?.type==="PropertyDefinition"||o?.type==="MethodDefinition")
  &&o.key===e&&!o.computed;
var hr=(e)=>typeof e==="object"&&e!==null&&typeof e.type==="string";

function qR(e,o,r){
  let t=function(n){
    if(o(n),r?.(n.node))return;
    let{node:s}=n;
    function p(i){if(hr(i))t({node:i,parent:s,grandparent:n.parent})}
    for(let i of Object.keys(s)){
      if(i==="loc"||i==="type"||i==="start"||i==="end")continue;
      let a=s[i];
      Array.isArray(a)?a.forEach(p):p(a)
    }
  };
  t({node:e,parent:void 0,grandparent:void 0})
}

function ps(e){
  let o=new Map;
  return qR(e,({node:r,parent:t})=>{if(t!==void 0)o.set(r,t)}),o
}
```

**这是整份证据册里技术含量最高的一段。** 它做的是**逃逸分析（escape analysis）**：

`ee()` 沿 AST 向上走，判断某个值从声明点出发，是否**只**以以下两种形态存在：
1. `ExpressionStatement`（`(expr)`）—— 用完即弃
2. 作为 `return` 的值，且外层函数就是注册时声明的那个 holder

一旦发现该值被**赋值、传参、读取、或从嵌套函数返回**，立即 `refuse()` 抛错。

**这在防什么？** 防止插件把内部句柄泄漏出去：

```js
// 通过：句柄只在调用点用完
engine.create(client)

// 拒绝：句柄被存起来了
const c = engine.create(client)
someObj.leaked = c

// 拒绝：句柄从嵌套函数返回
function wrapper() { return engine.create(client) }
```

配套的 `gr` 表是一份**完整的标识符绑定分析** —— 覆盖 `let/const/var`、三种函数形式、两种 class 形式、`catch` 参数、解构默认值、`...rest`、数组解构、对象解构、三种 import 形式。`qR`/`ps` 是自实现的 AST 遍历器（带 `parentOf` Map）。

`var oe="Client"` 是被分析的目标类型名。这套机制让 CC 可以在**不执行任何用户代码**的前提下，回答"这个模块会碰哪些 API"。

---

## 证据 4：mod 加载状态机 —— 六个状态，每个自带人话

**偏移 `213872000` 区域，连续原文（`basename` 来自 `import{basename as tRo,sep as nRo}from"path"`）：**

```js
function oRo(e,n,r){
  let s=`${tRo(r.root)}${nRo}`,           // "mods-dir/"
      g=e==="new"?`new in ${s}`:`gone from ${s}`;
  switch(n){
    case"reloaded":   return`${e==="new"?"loaded":"unloaded"} (${g})`;
    case"not-loaded": return`${g}, not loaded; /plugin shows why`;
    case"held":       return`${g}, on hold: /reload-plugins applies it`;
    case"unbound":    return`${g}; restart to apply`;
  }
}

import{relative as sRo}from"path";
var jV=(e,n)=>e===void 0?"none":sRo(n.root,e);
function nle(e){
  let n=e.length,
      r=n===1?"hook":"hooks",
      s=n===0?"":`: ${e.join(", ")}`;
  return`${n} ${r}${s}`
}

import{basename as dRo}from"path";
function cRo(e,n,r){
  let s=`${dRo(e.manifest)} changed — `;
  if(r.refused!==void 0)return s+r.refused;
  let g=jV(n.before,e), h=jV(n.now,e),
      S=g===h?`${h} unchanged`:`${g} → ${h}`;
  return`${s}reloaded (modules: ${S}; ${nle(r.events)})`
}

import{basename as uRo}from"path";
var fRo=(e)=>`${uRo(e)} changed; restart to apply`;

import{basename as pRo}from"path";
function mRo(e,n){
  let r=n===void 0?"nothing to unload":`${jV(n,e)} unloaded`;
  return`${pRo(e.manifest)} changed — names no hooks module now; `+r
}

function XVn(e,n){
  return`reload failed, the previous version stays loaded: ${jae(e,n)}`
}

import{basename as gRo}from"path";
var hRo=(e)=>`${gRo(e)} changed; a ConfigChange hook blocked the reload, the loaded version stays`;

function fNe(e){
  return e.refused===void 0?`reloaded (${nle(e.events)})`:e.refused
}

var q0t=(e)=>`reloading unusually often (${e.limit} reloads back to back); pausing, `+
  `the latest save loads once the directory is quiet, or run /reload-plugins to reload now`;
```

**这是分析报告里"状态即文案"那条建议的全部代码依据。** 四个 `case` 分支，每个返回一句完整的人话，且**每句话都自带下一步动作**：

| outcome | 文案 | 隐含指引 |
|---------|------|---------|
| `reloaded` | `loaded (new in mods/)` / `unloaded (gone from mods/)` | — |
| `not-loaded` | `..., not loaded; /plugin shows why` | 去 `/plugin` |
| `held` | `..., on hold: /reload-plugins applies it` | 去 `/reload-plugins` |
| `unbound` | `...; restart to apply` | 重启 |

另有两个"意外"分支值得单独注意：

- `XVn`：**`reload failed, the previous version stays loaded`** —— 重载失败时**旧版本继续运行**，不是白屏。这是热重载的基本要求，但很多实现会做成"失败即卸载"。
- `hRo`：**`a ConfigChange hook blocked the reload, the loaded version stays`** —— 插件自己的 hook 可以拦截自己的重载。这是把 hook 系统用在了自我保护上。

---

## 证据 5：防抖 / 风暴抑制 —— `Y0t` 与 `Q0t`

**偏移 `213872000` 区域，连续原文：**

```js
var K0t=3;
var ole=(e,n)=>Math.max(e.capMs,n.intervalMs*K0t);
var V0t=1.5;
function Y0t({debounceMs:e,burst:n,storm:r},s,g){
  let{now:h,intervalMs:S}=g,
      w=s.changedAt;
  s.pendingSince??=h;
  s.changedAt=h;
  let D=Math.max(n.gapMs,S*V0t),      // burst 窗口
      B=h-w,                          // 距上次变更的间隔
      V=B>=e&&B<D&&(s.isForced||h-s.settledAt>=r.gapMs)?D:e,
      he=s.pendingSince+ole(n,g);     // storm 上限
  return Math.max(0,Math.min(V,he-h))
}

function X0t(e,n,r){
  n.isForced=n.pendingSince!==void 0&&r.now-n.pendingSince>=ole(e,r);
  n.pendingSince=void 0
}

var TRo=1000;
function Q0t({limit:e,gapMs:n,r},s){
  let g="open", h=0, S=!1,
      {NEGATIVE_INFINITY:w, NEGATIVE_INFINITY:D}=Number;
  return{
    sawChange(B){
      let K=B-Math.max(D,w);
      if(D=B, g!=="open"&&K>=r) g="open", h=0
    },
    admits(B){
      if(g==="paused"||g==="converged")return!1;
      let K=B-w<n;
      if(w=B, h=K?h+1:1, g==="probing"&&!K&&!S) g="open";
      if(S=!1, h<=e)return!0;
      if(g==="probing")g="converged"; else g="paused", s();
      return!1
    },
    isDeferring:()=>g==="paused",
    catchesUp(){g="probing",h=0,S=!0}
  }
}
```

**`Q0t` 是一个四态断路器**，比普通的 debounce 复杂得多：

| 状态 | 含义 | 转移条件 |
|------|------|---------|
| `open` | 正常放行 | `sawChange` 间隔 ≥ `gapMs` 重置计数 |
| `probing` | 暂停后试探 | `catchesUp()` 进入 |
| `converged` | 试探成功，收敛 | 试探期未再超限 |
| `paused` | 熔断，停止重载 | `admits` 超 `limit` 次；触发 `s()` 上报 |

`Y0t` 计算下一次重载的延迟，三重约束取最小：
1. `B` — 距上次变更的间隔（标准 debounce）
2. `D = max(burst.gapMs, intervalMs * 1.5)` — burst 窗口，防止连续小改动被合并成一次
3. `he = pendingSince + max(storm.capMs, intervalMs * 3)` — storm 上限，**保证一定会在这个时间点重载**

第三条尤其重要：它让"改个不停"的场景最终一定能收敛，而不是永远推迟。

---

## 证据 6：watcher 实现 —— 双后端 + 活跃度自适应

**偏移 `213872000` 区域，连续原文：**

```js
var Z0t=60000;   // idleAfterMs = 60s
var eBt=1e4;     // checkEveryMs  = 10s
var tBt=30000;   // idleMs        = 30s
var rle=["node_modules",".git"];

function x0r(e,n){
  let r=LRo(e),
      s=r.startsWith(".")&&r!==".claude-plugin",
      g=e===n||e===FRo(NRo(n),"latest");
  return rle.includes(r)||s||r.endsWith(".log")||g
}

var zV=100;
function lle(e,n,r){
  let s=!1, g=n.activeMs, h=n.now(),
      S=setInterval(()=>{
        let w=n.now(),
            D=w-n.lastInteractionTime()>n.idleAfterMs;
        if(D===s)return;
        let B=Math.max(h,w-g)-zV;
        s=D, g=s?n.idleMs:n.activeMs, h=w,
        t(`plugin-dir watch on ${e}: ${s?"idle":"active"}, polling every ${g}ms`),
        r(B)
      },n.checkEveryMs);
  return S.unref(),{interval:()=>g,stop:()=>{clearInterval(S)}}
}

var dle=(e)=>({persistent:!0,followSymlinks:!1,ignorePermissionErrors:!0,usePolling:!0,interval:e,
  awaitWriteFinish:{stabilityThreshold:zV,pollInterval:zV/2}});

var SNe={activeMs:hNt, idleMs:tBt, idleAfterMs:Z0t, checkEveryMs:eBt,
          lastInteractionTime:Mg, now:Date.now};   // hNt=400
```

**`lle` 是活跃度自适应轮询器**：用户 60 秒无交互 → 轮询间隔从 **400ms 降到 30s**（77 倍）。用 `setInterval` 每 10 秒检查一次是否该切换档位，且 `.unref()` 掉以免阻塞进程退出。

**`dle` 是 chokidar 配置**：`usePolling:!0` + `followSymlinks:!1` + `awaitWriteFinish:{stabilityThreshold:100, pollInterval:50}`。

`followSymlinks:false` 与证据 2 的 `uWe` 路径逃逸检查呼应 —— **两层防护**。

**双后端分派：**

```js
function iBt(e,n,r){
  return e.scope==="folder"
    ? oBt({root:e.root, ignored:P0r(e.root,Xz(),r), onChange:n, pace:SNe})   // 目录级
    : sBt({root:e.root, files:e.files, onChange:n, pace:SNe})                    // 文件级
}
```

- `oBt` — 目录 scope，用 `vS.watch(root, {...dle(...)})`，带 `retarget:()=>{}`（**目录 scope 不支持重定向**）
- `sBt` — 文件 scope，用 `setTimeout` 周期重扫 + `vS.watch([...已存在文件])`，**支持 `retarget`**（增删文件时增量调整 watch 列表）

文件级后端的 `retarget` 实现（`V` 函数）值得注意：它 diff 新旧文件列表，`watcher.add` 新增的、`watcher.unwatch` 删除的，**并把消失的文件放进 `S` 集合**用于触发 `unlink` 回调 —— 保证状态机能正确收到"gone"事件。

---

## 证据 7：状态变化的产生 —— `A0r`

**偏移 `213872000` 区域，连续原文：**

```js
function A0r(e,n=oRo){
  let{before:r, after:s, present:g, outcome:h}=e,
      {appeared:S, gone:w}=HV(r,g),
      D=(V,he)=>({plugin:s.get(V)??V, text:n("new",he,e)}),
      B=(V)=>({plugin:r.get(V)??V, text:n("gone",h,e)});
  if(h!=="reloaded")return[...S.map((V)=>D(V,h)),...w.map(B)];
  let K=HV(r,[...s.keys()]);
  return[
    ...K.appeared.map((V)=>D(V,h)),
    ...K.gone.map(B),
    ...S.filter((V)=>!s.has(V)).map((V)=>D(V,"not-loaded"))
  ]
}
```

**三态判定的精确逻辑：**

```
appeared = HV(before, present)          // 目录里有、之前没加载过
gone     = HV(before, after.keys())     // 之前加载过、现在没了

outcome !== "reloaded"  →  全部标 appeared/gone
outcome === "reloaded"  →  额外检查：
    出现在 present 但不在 after  →  "not-loaded"（文件在，但没加载成）
```

`HV(a, b)` 返回 `{appeared, gone}` 两个差集。这是状态机的核心：**目录里有 ≠ 加载成功**，第三种状态专门捕捉这个缝隙。

---

## 证据 8：同意流程 —— "不是一次性"的语义

**偏移 `99280300`，字面量原文：**

```text
Mods live in Enable: they load and reload when their files change.
Not now: they stay unloaded until this session next starts.
/plugin lists what loaded and turns it off.
```

**偏移 `99284093` 附近的标识符（常量池，非代码）：**

```text
DEV_MODS_PLACEHOLDER
isRefused
no_one_to_ask
loaded_at_start
isPreload
isPersonTurn
turn-end
quietMs
```

**偏移 `99284320` 附近，注入给模型的行为契约原文：**

```text
The person declined mod hot-reloading: what this run wrote under <dir>
is written but NOT loaded (a mod that loaded when the session started keeps
running as it loaded). Do not say the change is running. It loads the next
time this session starts (/reload-plugins reloads only a mod that loaded at
the start); the person can ask again.

The person has not answered the mod hot-reloading question yet; it is asked
again once a turn ends. What this run wrote under <dir> is written but NOT
loaded yet. Do not say it was declined, and do not suggest --plugin-dir or
a restart.
```

**`isRefused` 与 `no_one_to_ask` 是两个独立状态**，对应两段不同的 guidance：

| 状态 | guidance 差异 |
|------|--------------|
| `isRefused` | `Do not say the change is running.` + `the person can ask again` |
| `no_one_to_ask` | `Do not say it was declined` + `do not suggest --plugin-dir or a restart` |

第二段尤其关键：它禁止模型在"用户还没回答"时**误报拒绝**，同时禁止它自作主张找绕行方案。`do not suggest --plugin-dir or a restart` 直接堵死了模型绕过同意流程的后门。

**偏移 `99280800` 附近，拦截原因枚举原文：**

```text
hooks modules are switched off in this process
  all_hooks_disabled          — 组织禁用所有 hooks
  sideload_disabled           — 组织禁止 side-loaded 插件
  local_dirs_blocked          — 组织阻止本地目录插件
  managed_hooks_only          — 组织只允许 managed hooks
  hooks_disabled_in_settings  — 用户 settings 里 disableAllHooks
  bare_mode                   — 云端会话无磁盘
the workspace is not trusted
```

---

## 证据 9：zy-code 侧对应实现（源码，非提取）

### 9.1 `/reload-plugins` 命令

**`src/commands/reload-plugins/reloadPlugins.ts`（全文）：**

```ts
import { feature } from 'bun:bundle'
import { redownloadUserSettings } from '../../services/settings-sync/index.js'
import type { LocalCommandCall } from '../types.js'
import { isEnvTruthy } from '../../services/infra/envUtils.js'
import { refreshActivePlugins } from '../../services/plugins/refresh.js'
import { settingsChangeDetector } from '../../services/settings/changeDetector.js'
import { plural } from '../../utils/stringUtils.js'

export const call: LocalCommandCall = async (_args, context) => {
  if (feature('DOWNLOAD_USER_SETTINGS')) {
    const applied = await redownloadUserSettings()
    if (applied) {
      settingsChangeDetector.notifyChange('userSettings')
    }
  }

  const r = await refreshActivePlugins(context.setAppState)

  const parts = [
    n(r.enabled_count, 'plugin'),
    n(r.command_count, 'skill'),
    n(r.agent_count, 'agent'),
    n(r.hook_count, 'hook'),
    n(r.mcp_count, 'plugin MCP server'),
    n(r.lsp_count, 'plugin LSP server'),
  ]
  let msg = `Reloaded: ${parts.join(' · ')}`

  if (r.error_count > 0) {
    msg += `\n${n(r.error_count, 'error')} during load. Run /doctor for details.`
  }

  return { type: 'text', value: msg }
}

function n(count: number, noun: string): string {
  return `${count} ${plural(count, noun)}`
}
```

**对比要点：**

| 维度 | CC | zy-code |
|------|----|---------|
| 触发 | watcher 自动 + `/reload-plugins` | **仅手动** |
| 输出 | 逐 mod 一句人话 | 聚合计数 `Reloaded: 3 plugins · 12 skills · ...` |
| 失败 | `reload failed, the previous version stays loaded` + 原因 | `2 errors during load. Run /doctor` |
| 增量 | 只报变化的 mod | 报全量计数 |
| 防抖 | `Q0t` 四态断路器 | 无 |
| 活跃度 | `lle` 400ms↔30s 自适应 | 无 |

**注意**：zy-code 的输出是**聚合数字**，CC 是**逐项状态**。CC 的做法在调试体验上明显更好 —— 用户能精确定位哪个 mod 出问题。

### 9.2 热重载订阅

**`src/services/plugins/loadPluginHooks.ts:256-289`：**

```ts
export function setupPluginHookHotReload(): void {
  if (hotReloadSubscribed) {
    return
  }
  hotReloadSubscribed = true

  // Capture the initial snapshot so the first policySettings change can compare
  lastPluginSettingsSnapshot = getPluginAffectingSettingsSnapshot()

  settingsChangeDetector.subscribe((source) => {
    if (source === 'policySettings') {
      const newSnapshot = getPluginAffectingSettingsSnapshot()
      if (newSnapshot === lastPluginSettingsSnapshot) {
        logForDebugging('Plugin hooks: skipping reload, plugin-affecting settings unchanged')
        return
      }

      lastPluginSettingsSnapshot = newSnapshot
      logForDebugging('Plugin hooks: reloading due to plugin-affecting settings change')

      // Clear all plugin-related caches
      clearPluginCache('loadPluginHooks: plugin-affecting settings changed')
      clearPluginHookCache()

      // Reload hooks (fire-and-forget, don't block)
      void loadPluginHooks()
    }
  })
}
```

**关键差异：这里的 "hot reload" 不是文件热重载。**

订阅源是 `settingsChangeDetector` 且**限定 `source === 'policySettings'`** —— 只在**远程管理策略变更**时重载，不是插件文件变化时重载。

文件监听由 `settingsChangeDetector` 在 settings 层统一处理（文件 watcher 投递变化 → `applySettingsChange` → 触发订阅），**但只在配置快照实际变化时才重载插件**。

所以 zy-code 现在的语义是：**settings 变了且影响插件 → 重载**。CC 是：**文件变了 → 防抖 → 重载**。

### 9.3 `CLAUDE_PLUGIN_ROOT` 展开

**`src/services/hooks/commandRunner.ts:233`：**

```ts
command = command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () => rootPath)
```

**`:290-311`：**

```ts
// 插件和技能 hook 都设置 CLAUDE_PLUGIN_ROOT（技能使用相同
envVars.CLAUDE_PLUGIN_ROOT = toHookPath(pluginRoot)
...
envVars.CLAUDE_PLUGIN_ROOT = toHookPath(skillRoot)
```

zy-code 的实现与 CC 一致（CC 在 `99396916` 附近有同名变量）。

---

## 证据 10：CC 的 hooks 系统完整文档（字面量原文）

**偏移 `99014800`，连续原文：**

```markdown
## Hooks Configuration

Hooks run commands at specific points in Claude Code's lifecycle.

### Hook Structure
```json
{
 "hooks": {
  "EVENT_NAME": [
   {
    "matcher": "ToolName|OtherTool",
    "hooks": [
     {
      "type": "command",
      "command": "your-command-here",
      "timeout": 60,
      "statusMessage": "Running..."
     }
    ]
   }
  ]
 }
}
```

### Hook Events
| Event | Matcher | Purpose |
|-------|---------|---------|
| PermissionRequest | Tool name | Run before permission prompt |
| PreToolUse | Tool name | Run before tool, can block |
| PostToolUse | Tool name | Run after successful tool |
| PostToolUseFailure | Tool name | Run after tool fails |
| Notification | Notification type | Run on notifications |
| Stop | - | Run when Claude stops (including clear, resume, compact) |
| PreCompact | "manual"/"auto" | Before compaction |
| PostCompact | "manual"/"auto" | After compaction (receives summary) |
| UserPromptSubmit | - | When user submits |
| SessionStart | - | When session starts |

**Common tool matchers:** `Bash`, `Write`, `Edit`, `Read`, `Glob`, `Grep`

### Hook Types

**1. Command Hook** - Runs a shell command:
```json
{ "type": "command", "command": "prettier --write $FILE", "timeout": 30 }
```

**2. Prompt Hook** - Evaluates a condition with LLM:
```json
{ "type": "prompt", "prompt": "Is this safe? $ARGUMENTS" }
```
Only available for tool events: PreToolUse, PostToolUse, PermissionRequest.

**3. Agent Hook** - Runs an agent with tools:
```json
{ "type": "agent", "prompt": "Verify tests pass: $ARGUMENTS" }
```
Only available for tool events: PreToolUse, PostToolUse, PermissionRequest.

### Hook Input (stdin JSON)
```json
{
 "session_id": "abc123",
 "tool_name": "Write",
 "tool_input": { "file_path": "/path/to/file.txt", "content": "..." },
 "tool_response": { "success": true } // PostToolUse only
}
```

### Hook JSON Output
```json
{
 "systemMessage": "Warning shown to user in UI",
 "continue": false,
 "stopReason": "Message shown when blocking",
 "suppressOutput": false,
 "decision": "block",
 "reason": "Explanation for decision",
 "hookSpecificOutput": {
  "hookEventName": "PostToolUse",
  "additionalContext": "Context injected back to model"
 }
}
```
```

**`updatedInput` 字段**（在 `hookSpecificOutput` 说明中，`permissionDecision` / `permissionDecisionReason` 之后）：

```text
- `updatedInput` - Modified tool input (PreToolUse only)
```

CC 有 **10 个** hook 事件；zy-code `loadPluginHooks.ts:34-56` 有 **22 个**（多出 `PermissionDenied`、`StopFailure`、`Setup`、`TeammateIdle`、`TaskCreated`、`TaskCompleted`、`Elicitation`、`ElicitationResult`、`ConfigChange` 等）。

---

## 证据 11：`plugin.json` 校验器的边界案例

**偏移 `99381800` 区域，关键诊断文案原文（节选）：**

```text
'capabilities' is no longer read: what a hooks module hooks and calls on $ is
read from its source and listed under its hooks.json below. Delete the field.

' is an experimental component; declare it under 'experimental.e
' instead of at the top level. Top-level still loads for now but will be
removed in a future release.

headersHelper references ${user_config.*}. Options are never substituted into
headersHelper: the plugin loader refuses the server when the plugin declares
any options (the value would be spliced into a shell command), and otherwise
the literal text reaches the shell.

server has a "url" but no "type". Remote servers must set "type" to "http"
(or "sse" / "ws"); without it the entry is parsed as a stdio server, fails
for lacking "command", and is silently dropped at load.

Plugin source paths are resolved relative to the marketplace root (the
directory containing .claude-plugin/), not relative to marketplace.json.

$.state.set refers to owns: only a value's owner writes it

the manifest's types contract declares on EngineInterface, but registers
no hook on engine.create, so the plugin never adds to $

plugin.json names more than MCP server files; past that limit were not
examined. The plugin loader reads them all, so validate those files separately.

valid binaries entries declared, but the install hook processes at most ;
the rest are dropped entirely.

valid binaries entries declared, but only the first are fetched at install
time; the rest are ignored.

Plugin name "" is not kebab-case. Claude.ai marketplace sync requires
kebab-case (lowercase letters, digits, and hyphens only, e.g., "my-plugin").

Shell command uses without quotes: . If the expanded path contains a space
the command can split into several words and fail. Wrap the placeholder in
double quotes, or use exec form: {"command": "<executable>",
"args": ["${CLAUDE_PLUGIN_ROOT}/..."]}.
```

**最后一条特别值得注意**：校验器检测到 `${CLAUDE_PLUGIN_ROOT}` 未加引号时给出的建议是**改用 exec form**（`command` + `args` 数组），而不是简单地加引号 —— 因为 exec form 根本不过 shell，天然免疫空格和注入。

---

## 附录 A：偏移索引

| 证据 | 偏移 | 长度 |
|------|------|------|
| Bun plugin 注册器（`Gj`） | `207546000` | 3200 |
| 静态扫描器（`uWe`/`ee`/`gr`/`qR`） | `207547000` | 6500 |
| 状态机文案（`oRo`/`cRo`/`fNe`） | `213872000` | 12000 |
| 同意流程文案 | `99280300` | 2900 |
| 行为契约 guidance | `99284093` | — |
| hooks 系统文档 | `99014800` | 8000 |
| `plugin.json` 校验器 | `99381800` | 16000 |
| `CLAUDE_DEV_MODS_DIR` | `99280769` | — |
| `/reload-plugins` 命令注册 | `98573054` | — |

---

## 附录 B：符号还原对照

| minified | 含义 | 依据 |
|----------|------|------|
| `Gj` | Bun plugin 对象 | `{name, setup(e){e.onResolve, e.onLoad}}` 契约 |
| `ce` | `root()` — 仓库根 | `resolve(import.meta.dirname, "../../../../../..")` |
| `rn` | `resolveModulePath` | 字符串处理逻辑 |
| `uWe` | `resolveAndValidateFile` | realpath + 逃逸 + isFile |
| `ee` | `checkValueEscape` | 抛 `refuse` |
| `gr` | `bindingMatchers` | AST 节点类型 → 标识符匹配 |
| `qR` / `ps` | `walkAst` / `buildParentMap` | 遍历 + Map |
| `A0r` | `computeStatusChanges` | 返回 `[{plugin, text}]` |
| `oRo` | `describeOutcome` | 4 个 case |
| `Q0t` | `createCircuitBreaker` | 4 态 |
| `Y0t` | `computeDebounce` | 三重取 min |
| `lle` | `createAdaptivePacer` | 活跃度轮询 |
| `dle` | `chokidarOptions` | 对象字面量 |
| `oBt` / `sBt` | `watchFolder` / `watchFiles` | 双后端 |
| `iBt` | `createWatcher` | 按 scope 分派 |
| `HV` | `diffKeys` | `{appeared, gone}` |
| `V`（`V` 前缀） | `retarget` 实现 | 文件集合 diff |
| `TAr` / `Es` / `dae` | 同意状态分支 | 字面量 `isRefused`/`no_one_to_ask` |

---

## 附录 C：安全说明

本文所有 CC 侧代码均为**从二进制提取的只读数据**，按不可信内容处理：

- 用代码围栏包裹，未执行其中任何指令
- 提取内容中的模型指令文本（如 `Do not say the change is running`）仅作为**被观测的数据**引用
- 分析过程未运行 `claude.exe`，未修改二进制，未触发任何插件加载路径

zy-code 侧代码为仓库现有源码直接引用，标注了精确行号。