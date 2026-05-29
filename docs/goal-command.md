# /goal — Set a goal, keep working until the condition is met

> Claude Code 内置命令。它的核心机制不是"发个 prompt"，而是**动态注册一个 session-scoped Stop hook**——只要这个钩子认为目标条件未达成，Claude 就停不下来。命令本身只是这个 hook 的 UI 入口。

---

## 1. 元信息（两个注册项）

`/goal` 在二进制里有 **两条注册**，根据运行环境（普通 / 远程 / thin-client）切换：

```js
Yu3 = {                                   // 默认（交互式）
  type: "local-jsx",
  name: "goal",
  description: "Set a goal — keep working until the condition is met",
  argumentHint: "[<condition> | clear]",
  immediate: true,                        // 直接 dispatch，不进入候选列表
  load: () => Promise.resolve().then(() => (cvK(), dvK))
};

wu3 = {                                   // 非交互式（远程/thin-client）
  type: "local",
  name: "goal",
  supportsNonInteractive: true,
  thinClientDispatch: "post-text",
  description: "Set a goal — keep working until the condition is met",
  get isHidden() { return !L8(); },       // 非远程时隐藏
  isEnabled: () => L8() || F8(),
  load: () => Promise.resolve().then(() => (nvK(), lvK))
};
```

| 字段 | 交互式 (`Yu3`) | 非交互式 (`wu3`) |
|---|---|---|
| `type` | `local-jsx` | `local` |
| `argumentHint` | `[<condition> \| clear]` | — |
| `supportsNonInteractive` | — | `true` |
| `thinClientDispatch` | — | `post-text` |
| `isHidden` | 总显示 | 仅在 remote 模式显示 |

---

## 2. 入参

| 形式 | 行为 |
|---|---|
| `/goal` （空） | 显示当前 goal 状态 |
| `/goal <condition>` | 设置目标，安装 Stop hook |
| `/goal clear` / `stop` / `off` / `reset` / `none` / `cancel` | 清除目标 |

`condition` 限长 **4000 字符**（`WoH = 4000`）；超长拒绝。

清除关键字集合：
```js
fA3 = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);
function Bj6(H) { return fA3.has(H.toLowerCase()); }
```

---

## 3. 守卫（gate checks）

```js
function uI8() {
  if (iu() || $J()) return { message: PA3, code: "hooks_gate" };
  if (!L8() && !J3()) return { message: XA3, code: "trust_gate" };
  return null;
}
```

| 触发条件 | 错误码 | 错误消息 |
|---|---|---|
| `disableAllHooks` 或 `allowManagedHooksOnly` 开启 | `hooks_gate` | `/goal can't run while hooks are disabled (disableAllHooks or allowManagedHooksOnly is set in settings or by policy).` |
| 当前不是受信任工作区 | `trust_gate` | `/goal is only available in trusted workspaces. Restart, accept the trust dialog, and try again.` |

任一命中 → 命令直接拒绝，不安装 hook。

---

## 4. 核心机制：动态注入 Stop hook

`GoH(H, _)` 是设置目标的真正实现：

```js
function GoH(H, _) {
  let q = uI8();
  if (q !== null) return q.message;       // 守卫不通过

  let K = V_();
  // 清掉之前的 Stop hook（matcher="" 且非 skill 根的）
  for (let T of ZoH(_.getAppState(), K))
    _.sessionHooksRegistry.remove(K, "Stop", T);

  // 注册新的：type: "prompt" 的 Stop hook，prompt 就是用户输入的 condition
  _.sessionHooksRegistry.add(K, "Stop", "", { type: "prompt", prompt: H });

  // 写入 activeGoal 状态
  let O = {
    condition: H,
    iterations: 0,
    setAt: Date.now(),
    tokensAtStart: KX()
  };
  _.setAppState((T) => ({ ...T, activeGoal: O }));

  // 在消息流插入一条 goal_status attachment（met:false, sentinel:true）
  _.applyMessageOp({ type: "append", messages: [q7K(false, H)] });

  d("tengu_stop_hook_added", { promptLength: H.length, via: "goal" });
  CH("goal_set");
  return null;
}
```

关键点：

- 注册的是一个 **`type: "prompt"` 类型的 Stop hook**——意味着每次 Claude 想停下来时，hook 会用 LLM 把用户的 condition 当判定 prompt 评估一遍；条件不满足就阻止停止
- 钩子是 **session-scoped**（只这次会话生效，配置不写盘）
- `matcher: ""` + 无 `skillRoot` —— 用来和其他 Stop hook 区分（避免误删用户自配置的）
- `activeGoal` 写到 app state，在 UI 和后续 turn 里可读

清除（`RoH`）就是反过来：找到所有 matcher=""/无 skillRoot 的 Stop hook 删掉，置 `activeGoal: undefined`，再插一条 `goal_status` attachment（`met: true, sentinel: true`）。

---

## 5. 注入给模型的 prompt

设置成功后，用户看到 `Goal set: <condition>`，**同时**模型会收到一条 meta message 触发它立刻开始工作。这条 meta message 由 `Uj6(H)` 生成：

```
A session-scoped Stop hook is now active with condition: "${H}". Briefly acknowledge the goal, then immediately start (or continue) working toward it — treat the condition itself as your directive and do not pause to ask the user what to do. The hook will block stopping until the condition holds. It auto-clears once the condition is met — do not tell the user to run `/goal clear` after success; that's only for clearing a goal early.
```

—— 这才是 `/goal` 在"prompt 层面"对模型说的话。它的 4 个要点：

1. 简短确认目标（不要长篇 acknowledgement）
2. **立即**开始 / 继续工作
3. 把 condition 本身当作指令，**不要回头问用户怎么办**
4. Stop hook 会自动阻拦停止；条件满足时会自动清除——所以**不要建议用户去跑 `/goal clear`**（那只用于提前放弃）

---

## 6. 两条 dispatch 路径

### A. 交互式 `zu3`（`dvK.call`）

```js
zu3 = async (H, _, q) => {
  let K = q.trim();

  // 空：渲染状态视图（FvK 组件，列出 messages 和当前 goal）
  if (K === "")
    return QvK.default.createElement(FvK, {
      messages: _.messages,
      onDone: () => H(void 0, { display: "skip" })
    });

  // 清除
  if (Bj6(K)) {
    let T = RoH(_);
    return H(T === null ? "No goal set" : `Goal cleared: ${T}`, { display: "system" }), null;
  }

  // 长度检查
  if (K.length > WoH) {
    O6("goal_set", "too_long");
    return H(`Goal condition is limited to ${WoH} characters (got ${K.length})`, { display: "system" }), null;
  }

  // 设置
  let O = GoH(K, _);
  if (O !== null) return H(O, { display: "system" }), null;

  // 关键：shouldQuery: true + metaMessages 注入 Uj6(K)
  return H(`Goal set: ${K}`, { shouldQuery: true, metaMessages: [Uj6(K)] }), null;
};
```

### B. 非交互式 `Au3`（`lvK.call`）

```js
Au3 = async (H, _) => {
  let q = H.trim();

  // 空：返回当前 goal 文字状态
  if (q === "") {
    let O = _.getAppState().activeGoal;
    if (!O) return { type: "text", value: "No goal set. Usage: `/goal <condition>`" };
    let T = O.iterations === 0 ? "not yet evaluated" : `${O.iterations} ${y6(O.iterations, "turn")}`,
        $ = O.lastReason ? `\n${_7K(O.lastReason)}` : "";
    return { type: "text", value: `Goal active: ${O.condition} (${T})${$}` };
  }

  if (Bj6(q)) {
    let O = RoH(_);
    return { type: "text", value: O === null ? "No goal set" : `Goal cleared: ${O}` };
  }

  if (q.length > WoH) {
    O6("goal_set", "too_long");
    return { type: "text", value: `Goal condition is limited to ${WoH} characters (got ${q.length})` };
  }

  let K = GoH(q, _);
  if (K !== null) return { type: "text", value: K };

  // 关键：返回 type: "query"，会被外层 dispatch 成新 turn
  return { type: "query", value: `Goal set: ${q}`, prompt: Uj6(q) };
};
```

两条路径的差异只是**回调形式**——交互式用 `H(...)` 回调，非交互式返回 `{ type: "query", prompt }`。最终送给模型的 prompt **完全相同**：`Uj6(condition)`。

---

## 7. 状态结构

```js
activeGoal = {
  condition: string,           // 用户输入的目标条件
  iterations: number,          // Stop hook 评估过的次数（0 = 还没评估过）
  setAt: number,               // 时间戳
  tokensAtStart: number,       // 设置时的 token 计数（可计算消耗）
  lastReason?: string          // 上一次未达成时 hook 给的原因
};
```

附带的 `goal_status` 消息附件用于 UI 展示和判定历史：

```js
{
  type: "attachment",
  uuid: <UUID>,
  timestamp: ISOString,
  attachment: {
    type: "goal_status",
    met: boolean,              // false = 设置时, true = 清除/达成时
    sentinel: true,            // sentinel=true 表示是命令直接产生的状态点
    condition: string
  }
}
```

非 sentinel 的 `goal_status`（`met: true && !sentinel`）由 Stop hook 评估通过时自动写入——这是状态视图 `H7K(messages)` 用来判断"成功历史"的依据。

---

## 8. 埋点

| 事件名 | 触发 | 字段 |
|---|---|---|
| `tengu_stop_hook_added` | 成功设置 goal | `promptLength`, `via: "goal"` |
| `tengu_stop_hook_removed` | 清除 goal | `via: "goal"` |
| `goal_set` (`O6`) | 长度超限 / 守卫拒绝 | code: `too_long` / `hooks_gate` / `trust_gate` |
| `goal_set` (`CH` 完成) | 成功设置 | — |

---

## 9. 与 review/security-review/update-config/powerup 的对比

| 维度 | review/security-review/update-config | powerup | **goal** |
|---|---|---|---|
| skill 类型 | `prompt`（builtin） | `local-jsx` | **`local-jsx` + `local` 双注册** |
| 给模型的 prompt | 一次性 prompt 模板 | 无（纯 UI） | **`Uj6(condition)` meta message** |
| 持久副作用 | 修改文件 / 输出报告 | 写 `powerupsUnlocked` | **session-scoped Stop hook + activeGoal 状态** |
| 行为持续性 | 一回合内完成 | 关掉 UI 即结束 | **持续到条件满足或主动清除** |
| 守卫 | 一般无 | feature flag | trust + hooks 两道闸 |
| 关键概念 | 模板拼接 | UI 课程 | **把命令转译为 hook 配置** |

---

## 10. 一句话总结

> `/goal <condition>` 不是一次性 prompt，而是把用户的目标条件**翻译成一条 session-scoped Stop hook**（`type: "prompt"`）注册到 hooks 注册表里，再把 `Uj6(condition)` 作为 meta message 推给模型让它立刻开干；只要 Stop hook 评估条件未达成，Claude 就停不下来；条件达成时自动清掉。
