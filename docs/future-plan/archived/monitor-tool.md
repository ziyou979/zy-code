# Monitor Tool

> Claude Code 内置工具。本文件包含工具描述（即注入到模型 system prompt 中的原文）以及入参 / 出参 schema。

---

## 1. 工具描述（Prompt 原文）

Start a background monitor that streams events from a long-running script. Each stdout line is an event — you keep working and notifications arrive in the chat. Events arrive on their own schedule and are not replies from the user, even if one lands while you're waiting for the user to answer a question.

Pick by how many notifications you need:
- **One** ("tell me when the server is ready / the build finishes") → use **Bash with `run_in_background`** and a command that exits when the condition is true, e.g. `until grep -q "Ready in" dev.log; do sleep 0.5; done`. You get a single completion notification when it exits.
- **One per occurrence, indefinitely** ("tell me every time an ERROR line appears") → Monitor with an unbounded command (`tail -f`, `inotifywait -m`, `while true`).
- **One per occurrence, until a known end** ("emit each CI step result, stop when the run completes") → Monitor with a command that emits lines and then exits.

Your script's stdout is the event stream. Each line becomes a notification. Exit ends the watch.

```bash
# Each matching log line is an event
tail -f /var/log/app.log | grep --line-buffered "ERROR"

# Each file change is an event
inotifywait -m --format '%e %f' /watched/dir

# Poll GitHub for new PR comments and emit one line per new comment
last=$(date -u +%Y-%m-%dT%H:%M:%SZ)
while true; do
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  gh api "repos/owner/repo/issues/123/comments?since=$last" --jq '.[] | "\(.user.login): \(.body)"'
  last=$now; sleep 30
done

# Node script that emits events as they arrive (e.g. WebSocket listener)
node watch-for-events.js

# Per-occurrence with a natural end: emit each CI check as it lands, exit when the run completes
prev=""
while true; do
  s=$(gh pr checks 123 --json name,bucket)
  cur=$(jq -r '.[] | select(.bucket!="pending") | "\(.name): \(.bucket)"' <<<"$s" | sort)
  comm -13 <(echo "$prev") <(echo "$cur")
  prev=$cur
  jq -e 'all(.bucket!="pending")' <<<"$s" >/dev/null && break
  sleep 30
done
```

**Don't use an unbounded command for a single notification.** `tail -f`, `inotifywait -m`, and `while true` never exit on their own, so the monitor stays armed until timeout even after the event has fired. For "tell me when X is ready," use Bash `run_in_background` with an `until` loop instead (one notification, ends in seconds). Note that `tail -f log | grep -m 1 ...` does *not* fix this: if the log goes quiet after the match, `tail` never receives SIGPIPE and the pipeline hangs anyway.

**Script quality:**
- Always use `grep --line-buffered` in pipes — without it, pipe buffering delays events by minutes.
- In poll loops, handle transient failures (`curl ... || true`) — one failed request shouldn't kill the monitor.
- Poll intervals: 30s+ for remote APIs (rate limits), 0.5–1s for local checks.
- Write a specific `description` — it appears in every notification ("errors in deploy.log" not "watching logs").
- Only stdout is the event stream. Stderr goes to the output file (readable via Read) but does not trigger notifications — for a command you run directly (e.g. `python train.py 2>&1 | grep --line-buffered ...`), merge stderr with `2>&1` so its failures reach your filter. (No effect on `tail -f` of an existing log — that file only contains what its writer redirected.)

**Coverage — silence is not success.** When watching a job or process for an outcome, your filter must match every terminal state, not just the happy path. A monitor that greps only for the success marker stays silent through a crashloop, a hung process, or an unexpected exit — and silence looks identical to "still running." Before arming, ask: *if this process crashed right now, would my filter emit anything?* If not, widen it.

```bash
# Wrong — silent on crash, hang, or any non-success exit
tail -f run.log | grep --line-buffered "elapsed_steps="

# Right — one alternation covering progress + the failure signatures you'd act on
tail -f run.log | grep -E --line-buffered "elapsed_steps=|Traceback|Error|FAILED|assert|Killed|OOM"
```

For poll loops checking job state, emit on every terminal status (`succeeded|failed|cancelled|timeout`), not just success. If you cannot confidently enumerate the failure signatures, broaden the grep alternation rather than narrow it — some extra noise is better than missing a crashloop.

**Output volume**: Every stdout line is a conversation message, so the filter should be selective — but selective means "the lines you'd act on," not "only good news." Never pipe raw logs; use `grep --line-buffered`, `awk`, or a wrapper that emits exactly the success and failure signals you care about. Monitors that produce too many events are automatically stopped; restart with a tighter filter if this happens.

Stdout lines within 200ms are batched into a single notification, so multiline output from a single event groups naturally.

The script runs in the same shell environment as Bash. Exit ends the watch (exit code is reported). Timeout → killed. Set `persistent: true` for session-length watches (PR monitoring, log tails) — the monitor runs until you call TaskStop or the session ends. Use TaskStop to cancel early.

---

## 2. 入参（Input Schema）

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `command` | string | ✅ | — | Shell 命令或脚本。每行 stdout 都是一个事件；进程退出即结束监听。 |
| `description` | string | ✅ | — | 简短的人类可读描述（出现在每条通知里）。建议写得具体，比如 `errors in deploy.log` 而不是 `watching logs`。 |
| `timeout_ms` | number | ✅ | `300000` | 监听超时（毫秒），到期后强制 kill。最大 `3600000`（1 小时），最小 `1000`。当 `persistent: true` 时被忽略。 |
| `persistent` | boolean | ✅ | `false` | `true` = 整个 session 期间一直跑，无超时；用于 PR 长期监听、日志 tail 等。需要手动调用 `TaskStop` 或 session 结束才会停。 |

### JSON Schema 原文

```json
{
  "type": "object",
  "required": ["description", "timeout_ms", "persistent", "command"],
  "additionalProperties": false,
  "properties": {
    "command": {
      "type": "string",
      "description": "Shell command or script. Each stdout line is an event; exit ends the watch."
    },
    "description": {
      "type": "string",
      "description": "Short human-readable description of what you are monitoring (shown in notifications)."
    },
    "timeout_ms": {
      "type": "number",
      "default": 300000,
      "minimum": 1000,
      "description": "Kill the monitor after this deadline. Default 300000ms, max 3600000ms. Ignored when persistent is true."
    },
    "persistent": {
      "type": "boolean",
      "default": false,
      "description": "Run for the lifetime of the session (no timeout). Use for session-length watches like PR monitoring or log tails. Stop with TaskStop."
    }
  }
}
```

---

## 3. 出参（Output / 行为）

Monitor 工具调用本身**立即返回**一个 task 句柄（任务被启动），后续通过**通知**的方式把事件流推回到对话里。

- **每行 stdout** → 触发一条对话内通知（200ms 内的多行会合并为一条）
- **stderr** → 写入 task 的 output 文件（可用 `Read` 工具查看），**不**触发通知
- **进程退出** → 监听结束，会带上退出码报告
- **超时** → 进程被 kill
- **手动停止** → 用 `TaskStop` 工具，传入返回的 task id

> 注意：通知是异步事件，不是用户消息。即使一条通知刚好在等待用户回答时到达，也不应被理解为用户的回复或确认。

---

## 4. 选型速查

| 需求 | 工具选择 | 命令模板 |
|---|---|---|
| 只要 1 次通知（"X 准备好了告诉我"） | `Bash` + `run_in_background` | `until <check>; do sleep 0.5; done` |
| 每次发生都通知，无终点 | `Monitor`（不持久） | `tail -f log \| grep --line-buffered PATTERN` |
| 每次发生都通知，有自然终点 | `Monitor` | poll 循环里 emit 行，全部完成就 `break` |
| Session 长期监听（PR、日志） | `Monitor` + `persistent: true` | 同上，靠 `TaskStop` 终止 |

---

## 5. 易踩的坑

1. **管道里忘加 `grep --line-buffered`** → 事件被缓冲，可能延迟几分钟才出现
2. **用 `tail -f` 或 `while true` 等"一次性事件"** → 命令永不自退，监控挂到 timeout
3. **过滤只匹配成功路径** → 进程 crash / hang / OOM 时监控完全静默，看起来与"仍在运行"一模一样。**Silence is not success**——必须把 `Traceback|Error|FAILED|Killed|OOM` 等失败信号一起加到 alternation 里
4. **stderr 没合并** → 直接跑的命令（`python train.py`）的报错不会触发通知，需要 `2>&1`
5. **过滤太宽** → 通知量过大会被系统自动停掉，需用更紧的 filter 重启
