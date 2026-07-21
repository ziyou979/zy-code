---
name: tui-test
description: Automate TUI (Ink/React) testing via expect scripts. Use when asked to reproduce a TUI bug, test a slash command, verify a UI fix, or run an end-to-end interaction test against the dev app.
---

# TUI Test Skill

Automate interactive TUI testing of the zy-code app using `expect` + ANSI stripping + error grep.

## When to use

- Reproducing a reported TUI bug (crash, rendering glitch, stuck state)
- Verifying a fix works end-to-end in the real dev app (not just unit tests)
- Testing slash commands (`/agents`, `/config`, `/mcp`, etc.) in realistic conditions
- Checking that dialogs open, close, and re-open without errors

## Prerequisites

- `expect` at `/usr/bin/expect` (macOS default)
- `bun` available on PATH
- Working directory must be project root

## Core pattern

Every TUI test follows three phases: **drive** → **capture** → **diagnose**.

### Phase 1: Drive — write the expect script

```expect
#!/usr/bin/expect -f
set timeout 120
set env(TERM) "xterm-256color"
log_file -a /tmp/zy-test.log

spawn bun --preload ./src/entrypoints/devPreload.ts src/entrypoints/cli.tsx

# Wait for app startup (prompt appears). 12-18s is safe for cold start.
sleep 15

# --- YOUR TEST SEQUENCE HERE ---
# send "/agents\r"      — type a slash command + Enter
# sleep 5               — wait for dialog to render
# send "\x1b"           — press Escape
# sleep 2               — wait for unmount
# send "/agents\r"      — re-trigger to test remount
# sleep 5

# Exit cleanly
send "\x03"             — Ctrl+C
sleep 2
send "\x03"             — Ctrl+C again (double-press exit)
expect eof
```

#### Key reference

| Action            | Send sequence | Notes                                      |
| ----------------- | ------------- | ------------------------------------------ |
| Type text + Enter | `send "text\r"` |                                          |
| Escape            | `send "\x1b"`   | Close dialog / cancel                    |
| Ctrl+C            | `send "\x03"`   | Interrupt; send twice for exit           |
| Arrow Up          | `send "\x1b\x5b\x41"` |                                    |
| Arrow Down        | `send "\x1b\x5b\x42"` |                                    |
| Arrow Right       | `send "\x1b\x5b\x43"` |                                    |
| Arrow Left        | `send "\x1b\x5b\x44"` |                                    |
| Enter             | `send "\r"`       |                                        |
| Tab               | `send "\t"`       |                                        |
| Backspace         | `send "\x7f"`     |                                        |
| Ctrl+U (clear)    | `send "\x15"`     | Clear current input line               |

#### Timing guidelines

- **Startup wait**: 15s cold start, 10s warm start
- **Dialog render**: 3-5s after sending a slash command
- **After Escape**: 2-3s for unmount
- **Between commands**: 2-3s minimum
- **Before exit**: 2s after last Ctrl+C

### Phase 2: Capture — run and collect output

```bash
# Clean previous log
rm -f /tmp/zy-test.log

# Run the expect script (suppress expect's own output)
/path/to/test.exp >/dev/null 2>&1

# Strip ANSI escape sequences for readable output
sed 's/\x1b\[[0-9;]*[a-zA-Z]//g; s/\x1b\[?[0-9;]*[a-zA-Z]//g' /tmp/zy-test.log > /tmp/zy-test-clean.log
```

### Phase 3: Diagnose — grep for errors

```bash
# Check for crashes
grep -aiE "TypeError|RangeError|ReferenceError|Cannot read|undefined is not|stack.*frame" /tmp/zy-test.log | head -20

# Check for React-specific errors
grep -aiE "Invalid hook|Maximum update|Rendered more hooks|Cannot find fiber" /tmp/zy-test.log | head -10

# Check for module load failures
grep -aiE "Cannot find module|Module not found|SyntaxError" /tmp/zy-test.log | head -10

# Verify expected UI appeared (adjust per test)
grep -ac "some-expected-text" /tmp/zy-test-clean.log
```

### Exit codes

- Grep finds errors → bug still present
- Grep finds nothing + expected text count > 0 → fix verified
- Grep finds nothing + expected text count = 0 → test didn't exercise the path, increase sleep times

## Common test recipes

### Slash command open → close → re-open

Tests that a dialog component unmounts and remounts cleanly:

```expect
send "/COMMAND\r"
sleep 5
send "\x1b"
sleep 3
send "/COMMAND\r"
sleep 5
send "\x1b"
```

### Navigate and select

Tests list navigation + selection:

```expect
send "/COMMAND\r"
sleep 5
send "\x1b\x5b\x42"    # Arrow down
sleep 1
send "\x1b\x5b\x42"    # Arrow down
sleep 1
send "\r"               # Enter to select
sleep 3
```

### Rapid re-trigger stress test

Tests for memory leaks or stale state:

```expect
for {set i 0} {$i < 5} {incr i} {
  send "/COMMAND\r"
  sleep 3
  send "\x1b"
  sleep 2
}
```

## Debugging tips

- **If no output appears in log**: the `spawn` process may have died before writing. Check with `spawn -noecho` prefix.
- **If input gets garbled** (e.g., `gents` instead of `/agents`): the previous state didn't fully clear. Add `\x15` (Ctrl+U) before the next command to clear the input buffer.
- **If expect times out**: increase `set timeout` or add longer `sleep` after startup.
- **If errors appear on stderr but not in log**: redirect stderr in the spawn command: `spawn bash -c "bun ... 2>&1"`.
- **Module-level crashes vs render-time crashes**: if the error appears during `import()` (before any UI renders), it's a module evaluation error — check for circular deps or version mismatches. If it appears after UI renders (you see dialog elements in the log), it's a React component error — check hooks, state, or props.
