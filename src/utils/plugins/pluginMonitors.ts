/**
 * 插件 monitors 运行时管理。
 *
 * monitors 在 session 启动时自动启动后台进程，
 * 持续监听事件和状态变化，类似守护进程（daemon）。
 * 适合日志监控、资源监控、自动修复等场景。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { LoadedPlugin } from '../../types/plugin.js'
import { logForDebugging } from '../debug.js'
import { getCwd } from '../cwd.js'

type MonitorConfig = NonNullable<LoadedPlugin['monitors']>[number]

interface RunningMonitor {
  pluginName: string
  config: MonitorConfig
  process: ChildProcess
  startedAt: number
}

/** 当前会话中运行的 monitors */
const _runningMonitors: RunningMonitor[] = []

/**
 * 启动指定插件的所有 session_start 类型 monitors。
 * 在 session 初始化时调用。
 */
export function startPluginMonitors(plugins: readonly LoadedPlugin[]): void {
  for (const plugin of plugins) {
    if (!plugin.enabled || !plugin.monitors?.length) continue

    for (const monitor of plugin.monitors) {
      const trigger = monitor.trigger ?? 'session_start'
      if (trigger !== 'session_start') continue

      startMonitor(plugin.name, monitor)
    }
  }

  if (_runningMonitors.length > 0) {
    logForDebugging(
      `Started ${_runningMonitors.length} plugin monitor(s): ${_runningMonitors.map((m) => `${m.pluginName}/${m.config.name}`).join(', ')}`,
    )
  }
}

/**
 * 启动指定 trigger 类型的 monitors（如 skill_invoke）。
 */
export function triggerPluginMonitors(
  plugins: readonly LoadedPlugin[],
  trigger: 'skill_invoke',
): void {
  for (const plugin of plugins) {
    if (!plugin.enabled || !plugin.monitors?.length) continue

    for (const monitor of plugin.monitors) {
      if (monitor.trigger !== trigger) continue

      // 避免重复启动同名 monitor
      const alreadyRunning = _runningMonitors.some(
        (r) => r.pluginName === plugin.name && r.config.name === monitor.name,
      )
      if (alreadyRunning) continue

      startMonitor(plugin.name, monitor)
    }
  }
}

/**
 * 停止所有正在运行的 monitors。
 * 在 session 结束时调用。
 */
export function stopAllPluginMonitors(): void {
  const count = _runningMonitors.length
  if (count === 0) return

  for (const monitor of _runningMonitors) {
    try {
      monitor.process.kill('SIGTERM')
      logForDebugging(
        `Stopped monitor ${monitor.pluginName}/${monitor.config.name} (ran ${((Date.now() - monitor.startedAt) / 1000).toFixed(0)}s)`,
      )
    } catch {
      // 进程可能已经退出
    }
  }
  _runningMonitors.length = 0
  logForDebugging(`Stopped ${count} plugin monitor(s)`)
}

/** 获取当前运行的 monitors 数量 */
export function getRunningMonitorCount(): number {
  return _runningMonitors.length
}

/** 启动单个 monitor 后台进程 */
function startMonitor(pluginName: string, config: MonitorConfig): void {
  const cwd = config.cwd ?? getCwd()

  try {
    const child = spawn(config.command, [], {
      cwd,
      shell: true,
      stdio: 'ignore',
      detached: false,
      env: config.env ? { ...process.env, ...config.env } : undefined,
    })

    child.on('error', (error) => {
      logForDebugging(`Monitor ${pluginName}/${config.name} error: ${error.message}`, {
        level: 'error',
      })
      removeRunningMonitor(pluginName, config.name)
    })

    child.on('exit', (code) => {
      logForDebugging(`Monitor ${pluginName}/${config.name} exited with code ${code}`)
      removeRunningMonitor(pluginName, config.name)
    })

    _runningMonitors.push({
      pluginName,
      config,
      process: child,
      startedAt: Date.now(),
    })
  } catch (error) {
    logForDebugging(
      `Failed to start monitor ${pluginName}/${config.name}: ${error instanceof Error ? error.message : String(error)}`,
      { level: 'error' },
    )
  }
}

/** 从运行列表中移除已退出的 monitor */
function removeRunningMonitor(pluginName: string, monitorName: string): void {
  const index = _runningMonitors.findIndex(
    (m) => m.pluginName === pluginName && m.config.name === monitorName,
  )
  if (index > -1) {
    _runningMonitors.splice(index, 1)
  }
}
