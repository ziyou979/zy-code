/**
 * 使用 Meta+J 切换的内置终端面板。
 *
 * 使用 tmux 保持 shell：独立 tmux server 通过每实例 socket（如
 * "zy-panel-a1b2c3d4"）保存 shell session。每个 ZY Code 实例拥有隔离的
 * 终端面板，在 session 内持续存在，并在实例退出时销毁。
 *
 * tmux 内将 Meta+J 绑定到 detach-client，按下后返回 ZY Code，同时 shell
 * 继续运行；下次切换会重新连接同一 session。
 *
 * tmux 不可用时，通过 spawnSync 回退到非持久 shell。
 *
 * 使用与外部 editor（promptEditor.ts）相同的暂停 Ink 模式。
 */

import { spawn, spawnSync } from 'node:child_process'
import { getSessionId } from '../bootstrap/runtime/runtimeContext.js'
import instances from '../ink/instances.js'
import { registerCleanup } from '../services/cleanup/cleanupRegistry.js'
import { pwd } from '../services/environment/cwd.js'
import { logForDebugging } from '../services/infra/debug.js'

const TMUX_SESSION = 'panel'

/**
 * 获取终端面板的 tmux socket 名称。根据 session ID 为每个 ZY Code 实例使用
 * 唯一 socket，使各实例拥有相互隔离的终端面板。
 */
export function getTerminalPanelSocket(): string {
  // 使用 session UUID 的前 8 个字符，在保持名称简短的同时确保唯一性
  const sessionId = getSessionId()
  return `zy-panel-${sessionId.slice(0, 8)}`
}

let instance: TerminalPanel | undefined

/**
 * 返回 TerminalPanel 单例，首次使用时延迟创建。
 */
export function getTerminalPanel(): TerminalPanel {
  if (!instance) {
    instance = new TerminalPanel()
  }
  return instance
}

class TerminalPanel {
  private hasTmux: boolean | undefined
  private cleanupRegistered = false

  // ── 公共 API ─────────────────────────────────────────────────────

  toggle(): void {
    this.showShell()
  }

  // ── tmux 辅助方法 ────────────────────────────────────────────────

  private checkTmux(): boolean {
    if (this.hasTmux !== undefined) {
      return this.hasTmux
    }
    const result = spawnSync('tmux', ['-V'], { encoding: 'utf-8' })
    this.hasTmux = result.status === 0
    if (!this.hasTmux) {
      logForDebugging('Terminal panel: tmux not found, falling back to non-persistent shell')
    }
    return this.hasTmux
  }

  private hasSession(): boolean {
    const result = spawnSync(
      'tmux',
      ['-L', getTerminalPanelSocket(), 'has-session', '-t', TMUX_SESSION],
      { encoding: 'utf-8' },
    )
    return result.status === 0
  }

  private createSession(): boolean {
    const shell = process.env.SHELL || '/bin/bash'
    const cwd = pwd()
    const socket = getTerminalPanelSocket()

    const result = spawnSync(
      'tmux',
      ['-L', socket, 'new-session', '-d', '-s', TMUX_SESSION, '-c', cwd, shell, '-l'],
      { encoding: 'utf-8' },
    )

    if (result.status !== 0) {
      logForDebugging(`Terminal panel: failed to create tmux session: ${result.stderr}`)
      return false
    }

    // 绑定 Meta+J（从终端内切回 ZY Code）并配置状态栏提示。
    // 使用 ';' 串联，把 5 次 spawnSync 合并为 1 次。
    // biome-ignore format: one tmux command per line
    spawnSync('tmux', [
      '-L', socket,
      'bind-key', '-n', 'M-j', 'detach-client', ';',
      'set-option', '-g', 'status-style', 'bg=default', ';',
      'set-option', '-g', 'status-left', '', ';',
      'set-option', '-g', 'status-right', ' Alt+J to return to Zy ', ';',
      'set-option', '-g', 'status-right-style', 'fg=brightblack',
    ])

    if (!this.cleanupRegistered) {
      this.cleanupRegistered = true
      registerCleanup(async () => {
        // 使用分离的异步 spawn；此处若用 spawnSync，会阻塞 event loop，并使
        // gracefulShutdown 中整个清理 Promise.all 串行化。若 tmux 在 session 创建后、
        // 清理前消失，.on('error') 会吞掉 ENOENT，避免无意义的 uncaughtException 噪声。
        spawn('tmux', ['-L', socket, 'kill-server'], {
          detached: true,
          stdio: 'ignore',
        })
          .on('error', () => {})
          .unref()
      })
    }

    return true
  }

  private attachSession(): void {
    spawnSync('tmux', ['-L', getTerminalPanelSocket(), 'attach-session', '-t', TMUX_SESSION], {
      stdio: 'inherit',
    })
  }

  // ── 显示 shell ───────────────────────────────────────────────────

  private showShell(): void {
    const inkInstance = instances.get(process.stdout)
    if (!inkInstance) {
      logForDebugging('Terminal panel: no Ink instance found, aborting')
      return
    }

    inkInstance.enterAlternateScreen()
    try {
      if (this.checkTmux() && this.ensureSession()) {
        this.attachSession()
      } else {
        this.runShellDirect()
      }
    } finally {
      inkInstance.exitAlternateScreen()
    }
  }

  // ── 辅助方法 ─────────────────────────────────────────────────────

  /** 确保 tmux session 存在，必要时创建。 */
  private ensureSession(): boolean {
    if (this.hasSession()) {
      return true
    }
    return this.createSession()
  }

  /** tmux 不可用时的回退路径：运行非持久 shell。 */
  private runShellDirect(): void {
    const shell = process.env.SHELL || '/bin/bash'
    const cwd = pwd()
    spawnSync(shell, ['-i', '-l'], {
      stdio: 'inherit',
      cwd,
      env: process.env,
    })
  }
}
