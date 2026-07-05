import { spawnSync } from 'node:child_process'
import { getIsInteractive } from '../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { getGlobalConfig } from '../services/config/config.js'
import { isBgSession } from './concurrentSessions.js'
import { logForDebugging } from './debug.js'
import { isEnvDefinedFalsy, isEnvTruthy, isInternalBuild } from './envUtils.js'
import { execFileNoThrow } from './execFileNoThrow.js'

let loggedTmuxCcDisable = false
let loggedWindowsSshDisable = false
let checkedTmuxMouseHint = false
let checkedTmuxFocusHint = false
let fullscreenRuntimeOverride: boolean | null = null

/**
 * Cached result from `tmux display-message -p '#{client_control_mode}'`.
 * undefined = not yet queried (or probe failed) — env heuristic stays authoritative.
 */
let tmuxControlModeProbed: boolean | undefined

/**
 * Env-var heuristic for iTerm2's tmux integration mode (`tmux -CC` / `tmux -2CC`).
 *
 * In `-CC` mode, iTerm2 renders tmux panes as native splits — tmux runs
 * as a server (TMUX is set) but iTerm2 is the actual terminal emulator
 * for each pane, so TERM_PROGRAM stays `iTerm.app` and TERM is iTerm2's
 * default (xterm-*). Contrast with regular tmux-inside-iTerm2, where tmux
 * overwrites TERM_PROGRAM to `tmux` and sets TERM to screen-* or tmux-*.
 *
 * This heuristic has known holes (SSH often doesn't propagate TERM_PROGRAM;
 * .tmux.conf can override TERM) — probeTmuxControlModeSync() is the
 * authoritative backstop. Kept as a zero-subprocess fast path.
 */
function isTmuxControlModeEnvHeuristic(): boolean {
  if (!process.env.TMUX) {
    return false
  }
  if (process.env.TERM_PROGRAM !== 'iTerm.app') {
    return false
  }
  // Belt-and-suspenders: in regular tmux TERM is screen-* or tmux-*;
  // in -CC mode iTerm2 sets its own TERM (xterm-*).
  const term = process.env.TERM ?? ''
  return !term.startsWith('screen') && !term.startsWith('tmux')
}

/**
 * Sync one-shot probe: asks tmux directly whether this client is in control
 * mode via `#{client_control_mode}`. Runs on first isTmuxControlMode() call
 * when the env heuristic can't decide; result is cached.
 *
 * Sync (spawnSync) because the answer gates whether we enter fullscreen — an
 * async probe raced against React render and lost: coder-tmux (ssh → tmux -CC
 * on a remote box) doesn't propagate TERM_PROGRAM, so the env heuristic missed,
 * and by the time the async probe resolved we'd already entered alt-screen with
 * mouse tracking enabled. Mouse wheel is dead in iTerm2's -CC integration, so
 * users couldn't scroll at all.
 *
 * Cost: one ~5ms subprocess, only when $TMUX is set AND $TERM_PROGRAM is unset
 * (the SSH-into-tmux case). Local iTerm2 -CC and non-tmux paths skip the spawn.
 *
 * The TMUX env check MUST come first — without it, display-message would
 * query whatever tmux server happens to be running rather than our client.
 */
function probeTmuxControlModeSync(): void {
  // Seed cache with heuristic result so early returns below don't leave it
  // undefined — isTmuxControlMode() is called 15+ times per render, and an
  // undefined cache would re-enter this function (re-spawning tmux in the
  // failure case) on every call.
  tmuxControlModeProbed = isTmuxControlModeEnvHeuristic()
  if (tmuxControlModeProbed) {
    return
  }
  if (!process.env.TMUX) {
    return
  }
  // Only probe when iTerm might be involved: TERM_PROGRAM is iTerm.app
  // (covered above) or not set (SSH often doesn't propagate it). When
  // TERM_PROGRAM is explicitly a non-iTerm terminal, skip — tmux -CC is
  // an iTerm-only feature, so the subprocess would be wasted.
  if (process.env.TERM_PROGRAM) {
    return
  }
  let result
  try {
    result = spawnSync('tmux', ['display-message', '-p', '#{client_control_mode}'], {
      encoding: 'utf8',
      timeout: 2000,
    })
  } catch {
    // spawnSync can throw on some platforms (e.g. ENOENT on Windows if tmux
    // is absent and the runtime surfaces it as an exception rather than in
    // result.error). Treat the same as a non-zero exit.
    return
  }
  // Non-zero exit / spawn error: tmux too old (format var added in 2.4) or
  // unavailable. Keep the heuristic result cached.
  if (result.status !== 0) {
    return
  }
  tmuxControlModeProbed = result.stdout.trim() === '1'
}

/**
 * True when running under `tmux -CC` (iTerm2 integration mode).
 *
 * The alt-screen / mouse-tracking path in fullscreen mode is unrecoverable
 * in -CC mode (double-click corrupts terminal state; mouse wheel is dead),
 * so callers auto-disable fullscreen.
 *
 * Lazily probes tmux on first call when the env heuristic can't decide.
 */
export function isTmuxControlMode(): boolean {
  if (tmuxControlModeProbed === undefined) {
    probeTmuxControlModeSync()
  }
  return tmuxControlModeProbed ?? false
}

export function _resetTmuxControlModeProbeForTesting(): void {
  tmuxControlModeProbed = undefined
  loggedTmuxCcDisable = false
}

/**
 * 检测 Windows 客户端通过 SSH 连接的场景。ConPTY 在这种环境下
 * 与 alt-screen 的兼容性差（重绘、鼠标事件等问题）。
 *
 * 两种触发路径：
 * 1. 本机是 Windows（process.platform === 'win32'）且处于 SSH 会话
 * 2. 远端检测到 Windows Terminal 的 WT_SESSION 环境变量通过 SSH env
 *    forwarding 泄漏过来（本机不一定是 Windows）
 */
function isWindowsOverSsh(): boolean {
  const isSsh = !!(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY)
  if (process.platform === 'win32' && isSsh) {
    return true
  }
  // WT_SESSION 是 Windows Terminal 设置的环境变量，有时通过 SSH
  // env forwarding（SendEnv/AcceptEnv）传播到远端
  if (isSsh && process.env.WT_SESSION) {
    return true
  }
  return false
}

/**
 * 全屏分辨率的决策原因。每个值对应 isFullscreenEnvEnabled() 中的
 * 一个分支，可直接用于遥测归因。
 */
export type FullscreenReason =
  | 'bg_forced_on'
  | 'runtime_off'
  | 'runtime_on'
  | 'env_off'
  | 'env_on'
  | 'tmux_cc_auto_off'
  | 'win_ssh_auto_off'
  | 'settings_on'
  | 'settings_off'
  | 'feature_flag_on'
  | 'feature_flag_off'
  | 'internal_default'
  | 'external_default_off'

export type FullscreenResolution = {
  enabled: boolean
  reason: FullscreenReason
}

/**
 * 设置当前进程内的全屏覆盖值。用于 /tui 在不重启的情况下立即切换
 * AlternateScreen；持久化偏好仍然由 global config 负责。
 */
export function setFullscreenRuntimeOverride(mode: 'fullscreen' | 'default' | null): void {
  fullscreenRuntimeOverride = mode === null ? null : mode === 'fullscreen'
}

/**
 * 解析全屏模式的最终决策及原因。判断优先级：
 * 1. bg_forced_on — 后台会话无条件全屏
 * 2. runtime_off / runtime_on — 当前进程内的 /tui 即时切换
 * 3. env_off / env_on — 环境变量显式控制
 * 4. tmux_cc_auto_off — tmux -CC 自动禁用
 * 5. win_ssh_auto_off — Windows+SSH 自动禁用
 * 6. settings_on / settings_off — 用户持久化偏好（/tui 命令）
 * 7. internal_default / external_default_off — 构建类型默认值
 */
export function resolveFullscreenEnabled(): FullscreenResolution {
  if (isBgSession()) {
    return { enabled: true, reason: 'bg_forced_on' }
  }
  if (fullscreenRuntimeOverride === false) {
    return { enabled: false, reason: 'runtime_off' }
  }
  if (fullscreenRuntimeOverride === true) {
    return { enabled: true, reason: 'runtime_on' }
  }
  if (isEnvDefinedFalsy(process.env.ZY_CODE_NO_FLICKER)) {
    return { enabled: false, reason: 'env_off' }
  }
  if (isEnvTruthy(process.env.ZY_CODE_NO_FLICKER)) {
    return { enabled: true, reason: 'env_on' }
  }
  if (isTmuxControlMode()) {
    if (!loggedTmuxCcDisable) {
      loggedTmuxCcDisable = true
      logForDebugging(
        'fullscreen disabled: tmux -CC (iTerm2 integration mode) detected · set ZY_CODE_NO_FLICKER=1 to override',
      )
    }
    return { enabled: false, reason: 'tmux_cc_auto_off' }
  }
  if (isWindowsOverSsh()) {
    if (!loggedWindowsSshDisable) {
      loggedWindowsSshDisable = true
      logForDebugging(
        'fullscreen disabled: Windows-over-SSH detected · set ZY_CODE_NO_FLICKER=1 to override',
      )
    }
    return { enabled: false, reason: 'win_ssh_auto_off' }
  }
  // 用户通过 /tui 命令设置的持久化偏好
  const tuiPref = getGlobalConfig().tui
  if (tuiPref === 'fullscreen') {
    return { enabled: true, reason: 'settings_on' }
  }
  if (tuiPref === 'default') {
    return { enabled: false, reason: 'settings_off' }
  }
  if (isInternalBuild()) {
    return { enabled: true, reason: 'internal_default' }
  }
  // Feature flag 灰度推广：服务端控制外部用户百分比
  if (getFeatureValue_CACHED_MAY_BE_STALE<boolean>('zy_fullscreen_rollout', false)) {
    return { enabled: true, reason: 'feature_flag_on' }
  }
  return { enabled: false, reason: 'external_default_off' }
}

/**
 * Runtime env-var check only. Ants default to on (ZY_CODE_NO_FLICKER=0
 * to opt out); external users default to off (ZY_CODE_NO_FLICKER=1 to
 * opt in).
 */
export function isFullscreenEnvEnabled(): boolean {
  return resolveFullscreenEnabled().enabled
}

/**
 * Whether fullscreen mode should enable SGR mouse tracking (DEC 1000/1002/1006).
 * Set ZY_CODE_DISABLE_MOUSE=1 to keep alt-screen + virtualized scroll
 * (keyboard PgUp/PgDn/Ctrl+Home/End still work) but skip mouse capture,
 * so tmux/kitty/terminal-native copy-on-select keeps working.
 *
 * Compare with ZY_CODE_NO_FLICKER=0 which is all-or-nothing — it also
 * disables alt-screen and virtualized scrollback.
 */
export function isMouseTrackingEnabled(): boolean {
  return !isEnvTruthy(process.env.ZY_CODE_DISABLE_MOUSE)
}

/**
 * Whether mouse click handling is disabled (clicks/drags ignored, wheel still
 * works). Set ZY_CODE_DISABLE_MOUSE_CLICKS=1 to prevent accidental clicks
 * from triggering cursor positioning, text selection, or message expansion.
 *
 * Fullscreen-specific — only reachable when ZY_CODE_NO_FLICKER is active.
 */
export function isMouseClicksDisabled(): boolean {
  return isEnvTruthy(process.env.ZY_CODE_DISABLE_MOUSE_CLICKS)
}

/**
 * True when the fullscreen alt-screen layout is actually rendering —
 * requires an interactive REPL session AND the env var not explicitly
 * set falsy. Headless paths (--print, SDK, in-process teammates) never
 * enter fullscreen, so features that depend on alt-screen re-rendering
 * should gate on this.
 */
export function isFullscreenActive(): boolean {
  return getIsInteractive() && isFullscreenEnvEnabled()
}

/**
 * One-time hint for tmux users in fullscreen with `mouse off`.
 *
 * tmux's `mouse` option is session-scoped by design — there is no
 * pane-level equivalent. We used to `tmux set mouse on` when entering
 * alt-screen so wheel scrolling worked, but that changed mouse behavior
 * for every sibling pane (vim, less, shell) and leaked on kill-pane or
 * when multiple CC instances raced on restore. Now we leave tmux state
 * alone — same as vim/less/htop — and just tell the user their options.
 *
 * Fire-and-forget from REPL startup. Returns the hint text once per
 * session if TMUX is set, fullscreen is active, and tmux's current
 * `mouse` option is off; null otherwise.
 */
export async function maybeGetTmuxMouseHint(): Promise<string | null> {
  if (!process.env.TMUX) {
    return null
  }
  // tmux -CC auto-disables fullscreen above, but belt-and-suspenders.
  if (!isFullscreenActive() || isTmuxControlMode()) {
    return null
  }
  if (checkedTmuxMouseHint) {
    return null
  }
  checkedTmuxMouseHint = true
  // -A includes inherited values: `show -v mouse` returns empty when the
  // option is set globally (`set -g mouse on` in .tmux.conf) but not at
  // session level — which is the common case. -A gives the effective value.
  const { stdout, code } = await execFileNoThrow('tmux', ['show', '-Av', 'mouse'], {
    useCwd: false,
    timeout: 2000,
  })
  if (code !== 0 || stdout.trim() === 'on') {
    return null
  }
  return "tmux detected · scroll with PgUp/PgDn · or add 'set -g mouse on' to ~/.tmux.conf for wheel scroll"
}

/**
 * True when the user wants fullscreen features (virtualized scroll, mouse)
 * but NOT the physical alt-screen buffer — preserving native terminal
 * scrollback. Set ZY_CODE_DISABLE_ALTERNATE_SCREEN=1 to enable.
 */
export function isAlternateScreenDisabled(): boolean {
  return isEnvTruthy(process.env.ZY_CODE_DISABLE_ALTERNATE_SCREEN)
}

/**
 * One-time hint for tmux users in fullscreen with `focus-events` off.
 *
 * tmux 默认关闭 focus-events，导致终端标签页焦点变化无法传递给
 * zy-code（DECSET 1004 的 focus-in/focus-out 事件被 tmux 拦截）。
 * 提示用户在 ~/.tmux.conf 中添加 `set -g focus-events on`。
 *
 * Fire-and-forget from REPL startup. Returns the hint text once per
 * session if TMUX is set, fullscreen is active, and tmux's current
 * `focus-events` option is off; null otherwise.
 */
export async function maybeGetTmuxFocusHint(): Promise<string | null> {
  if (!process.env.TMUX) {
    return null
  }
  if (!isFullscreenActive() || isTmuxControlMode()) {
    return null
  }
  if (checkedTmuxFocusHint) {
    return null
  }
  checkedTmuxFocusHint = true
  // -gv 只返回全局值，避免 -Av 输出带 "focus-events " 前缀
  const { stdout, code } = await execFileNoThrow('tmux', ['show', '-gv', 'focus-events'], {
    useCwd: false,
    timeout: 2000,
  })
  if (code !== 0 || stdout.trim() === 'on') {
    return null
  }
  return "tmux: add 'set -g focus-events on' to ~/.tmux.conf for better tab focus tracking"
}

/** Test-only: reset module-level once-per-session flags. */
export function _resetForTesting(): void {
  loggedTmuxCcDisable = false
  loggedWindowsSshDisable = false
  checkedTmuxMouseHint = false
  checkedTmuxFocusHint = false
  fullscreenRuntimeOverride = null
}
