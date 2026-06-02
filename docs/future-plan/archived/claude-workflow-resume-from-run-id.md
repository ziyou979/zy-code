# Claude Code `resumeFromRunId` 实现机制

> 来源：从 Claude Code v2.x 二进制（`@anthropic-ai/claude-code`）中逆向提取。
> `resumeFromRunId` 是 `Workflow`（注册名 `RunWorkflow`）这个内置工具的"断点续跑"参数。

## 1. 入参 schema（`qL3`）

```js
resumeFromRunId: h.string()
  .regex(/^wf_[a-z0-9-]{6,}$/)
  .optional()
  .describe(`Run ID of a prior Workflow invocation to resume from. Completed agent() calls with unchanged (prompt, opts) return their cached results instantly; only edited or new calls re-run. Same-session only. Stop the prior run first (TaskStop) before resuming.`)
```

返回值（`KL3`）里同样有：

```js
runId: h.string().optional().describe(
  "Local workflow run identifier for resumeFromRunId. Absent for remote_launched (the CCR session URL is the resume handle there) ..."
)
```

约束：`wf_` + 6 位以上 `[a-z0-9-]`，仅作用于"本会话"。

## 2. 准入校验（`validateInput`）

如果旧 run 还在跑，拒绝 resume，必须先停掉：

```js
if (H.resumeFromRunId) {
  for (let [O, T] of Object.entries(_.taskRegistry.all()))
    if (T.type === "local_workflow"
        && T.status === "running"
        && T.workflowRunId === H.resumeFromRunId)
      return {
        result: !1,
        message: `Workflow ${H.resumeFromRunId} is still running (task ${O}). Stop it first with TaskStop({taskId: "${O}"}) before resuming.`,
        errorCode: 3
      }
}
```

另外内联脚本会被静态扫描，**禁止 `Date.now()` / `Math.random()` / `new Date()`**（errorCode 4），原因写得很直白：`breaks resume`——这些非确定性源会让缓存键漂移。

## 3. `call()` 入口的 runId 分配

```js
let w = H.resumeFromRunId ?? `wf_${i1K.randomUUID().slice(0, 12)}`
let X = ZeH(w)                       // transcript / journal 目录
let P = Y ?? Qg9(M, w, $)            // 持久化脚本路径

// 续跑：把上一次留在 taskRegistry 里的"已结束"条目清掉，避免 UI 串号
if (H.resumeFromRunId != null) {
  EH("task_local_workflow_resume")
  for (let [y, S] of Object.entries(_.taskRegistry.all()))
    if (S.type === "local_workflow"
        && S.workflowRunId === H.resumeFromRunId
        && S.status !== "running")
      _.taskRegistry.remove(y)
}
```

注意：传入的 `resumeFromRunId` **直接被复用作新的 `workflowRunId`**——这就是为什么"resume"实际上是"以同一 runId 重跑脚本，复用旧产物"。

## 4. 持久化目录（`ZeH`）

```js
function ZeH(H) {
  let _ = BS() ?? IA(A8())
  return kEH.join(_, v_(), "subagents", "workflows", H)
}
```

最终路径：`<projectDir>/<sessionShard>/subagents/workflows/<runId>/journal.jsonl`

## 5. Journal — 真正的"缓存"载体（`EU8`）

append-only JSONL，两种条目：`started` 和 `result`。

```js
class EU8 {
  path; dirReady = !1
  constructor(H) {
    this.path = TW6.join(ZeH(H), "journal.jsonl")
  }
  async load() {
    let H
    try { H = await GeH.readFile(this.path, "utf8") }
    catch (q) { if (P6(q)) return n4K([]); throw q }   // 文件不存在 → 空
    let _ = []
    for (let q of H.split("\n")) {
      if (!q) continue
      try { _.push(JSON.parse(q)) }
      catch (K) { N(`LocalFileJournal: skipping unparseable line ...`) }
    }
    return n4K(_)
  }
  async append(H) {
    if (!this.dirReady) {
      await GeH.mkdir(TW6.dirname(this.path), { recursive: !0 })
      this.dirReady = !0
    }
    await GeH.appendFile(this.path, `${JSON.stringify(H)}\n`, "utf8")
  }
}
```

加载时分类成索引：

```js
function n4K(H) {
  let _ = new Map, q = new Map
  for (let K of H) {
    if (K.type === "result") _.set(K.key, K)
    else if (K.type === "started") {
      let O = q.get(K.key)
      if (O) O.push(K); else q.set(K.key, [K])
    }
  }
  return { results: _, started: q }
}
```

- `results` map：`key → {agentId, result}`，命中即直接复用
- `started` map：`key → [start 记录...]`，用于统计"启动过但没收到结果"的失败重试（埋点 `tengu_workflow_journal_started_hit_respawn`）

## 6. 缓存键（`r4K` / `KR3`）

```js
function KR3(H) {
  if (!H) return "{}"
  let _ = {}, q = ["schema", "model", "isolation", "agentType"]
  for (let O of q) {
    let T = H[O]
    if (T === void 0 || typeof T === "function") continue
    _[O] = T
  }
  // 递归排序 key，保证稳定 stringify
  let K = (O) => {
    if (Array.isArray(O)) return O.map(K)
    if (O && typeof O === "object") {
      let T = {}
      for (let $ of Object.keys(O).sort()) T[$] = K(O[$])
      return T
    }
    return O
  }
  return JSON.stringify(K(_))
}

function r4K(H, _, q) {
  let K = i4K.createHash("sha256")
    .update(q).update("\x00")        // q = 链式盐(上一次的 key)
    .update(H).update("\x00")        // H = prompt
    .update(KR3(_))                  // _ = opts 白名单(schema/model/isolation/agentType)
    .digest("hex")
  return `v2:${K}`
}
```

要点：

- **opts 只取白名单 4 个字段**：`schema`, `model`, `isolation`, `agentType`——其它字段（如 logger、回调）变化不影响命中
- **链式盐 `j`**：每次 `agent()` 调用后 `j = KH`（本次 key），**所以同一句 prompt 在脚本前后位置不同会得到不同 key**——保证缓存按"调用序列前缀"识别身份
- 版本前缀 `v2:`——以后改算法直接换前缀即可让旧 journal 失效

## 7. agent() 钩子里的命中逻辑（`H1K` 内）

```js
if (z) {                              // z = journal
  KH = r4K(o, a, j)                   // 算键
  j = KH                              // 推进链式盐
  let wH = J ? void 0 : Y?.results.get(KH)   // J 是"miss 已发生"标记
  if (wH !== void 0)
    return q({ type: "progress", toolUseID: `workflow_agent_${r}_cached`, data: {
      type: "workflow_agent", index: r, label: HH,
      phaseIndex: e, phaseTitle: t,
      agentId: wH.agentId, model: a?.model ?? E.options.mainLoopModel,
      state: "done", startedAt: Date.now(), lastProgressAt: Date.now(),
      cached: !0,
      resultPreview: VEH(wH.result),
      promptPreview: OH
    }}), wP(wH.result)
  J = !0                              // ★ 关键：一旦 miss，后续全部回到执行路径
  let JH = Y?.started.get(KH)
  if (JH && JH.length > 0)
    d("tengu_workflow_journal_started_hit_respawn", { attempts: JH.length })
}
```

`J = !0` 这行是续跑语义的灵魂：**第一次 miss 之后所有缓存条目都作废**——避免脚本中间一步改了之后，后续仍然吐出"基于旧上游"的过时结果。

实际执行时同步追加：

```js
let zH = (wH) => {
  TH = !0; qH = wH
  if (!z) return
  z.append({ type: "started", key: KH, agentId: wH })
   .catch((JH) => N(`workflow journal started-append failed: ${JH}`, { level: "warn" }))
}
let _H = async (wH) => {
  if (z && KH && wH !== null)
    await z.append({ type: "result", key: KH, agentId: qH ?? "", result: wH })
           .catch((JH) => N(`workflow journal result-append failed: ${JH}`, { level: "warn" }))
  return wH
}
```

## 8. 调用方（`f1K`）把 journal 注入

```js
async function f1K(H, _, q, K = {}) {
  ...
  let z = K.journal ? await K.journal.load() : void 0   // 启动时一次性 load
  let Y = M1K(_, q, $, K.workflowRunId, K.onAgentController, K.args,
              K.seedPhaseTitles, K.tokenBudget, K.journal, z)
  ...
}
```

而 `WorkflowTool.call()` 始终注入：`journal: new EU8(w)`——不管是不是 resume，每次都开 journal；`resumeFromRunId` 只是让它指向**已有的目录**，从而 `load()` 拿到非空索引。

## 9. 工具结果里给用户的恢复指令

```
Run ID: <runId>
To resume after editing the script:
  Workflow({scriptPath: "<path>", resumeFromRunId: "<runId>"})
  — completed agents return cached results.
```

## 10. 埋点

| 事件 | 触发时机 |
|---|---|
| `tengu_workflow_launched` | 启动；含 `is_resume: H.resumeFromRunId != null` |
| `task_local_workflow_resume` | 真正进入 resume 分支 |
| `tengu_workflow_journal_started_hit_respawn` | 命中"started 但无 result"——表示历史中断的 agent 重跑 |

## 总结一图

```
用户传入 resumeFromRunId=wf_xxx
        │
        ▼
validateInput  ── 旧 run 还在跑？拒绝
        │
        ▼
call(): w = resumeFromRunId               (复用 runId 即复用目录)
        │
        ├── ZeH(w) → .../subagents/workflows/wf_xxx/
        │
        ├── 清理 taskRegistry 里旧的已完成条目
        │
        └── new EU8(w) → 打开 journal.jsonl
                │
                ▼
           f1K → journal.load() → {results, started}
                │
                ▼
   脚本里每次 agent(prompt, opts):
       key = sha256(prevKey ‖ prompt ‖ opts白名单)
       if results.has(key) && !已 miss: 直接返回缓存结果
       else: 真跑 → append {started}/{result}; 设置"已 miss"
```

## 一句话总结

`resumeFromRunId` 不是真正的"恢复执行点"，而是把 runId 当作 journal 目录键 → 重跑整段脚本 → 在 `agent()` 调用粒度按 `(链式前缀, prompt, 白名单 opts)` 哈希命中旧产物。脚本必须确定性（禁 `Date.now/Math.random/new Date`）才能让哈希稳定，第一次 miss 之后整条链路全部回到真实执行路径。
