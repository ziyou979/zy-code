/**
 * 守护进程的 Worker 注册表。
 *
 * 每个 worker 子进程在启动时调用 runDaemonWorker()，
 * 向 daemon 的 roster 注册自身，执行工作，然后注销。
 *
 * 当前支持以下 worker 类型：
 * - 'assistant' — 后台 assistant 任务
 * - 'cron' — 定时任务执行器
 * - 'session' — 远程会话 worker
 *
 * 通过 feature('DAEMON') 门控，构建时 DCE。
 */
import { feature } from 'bun:bundle'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

const DAEMON_DIR = join(homedir(), '.zy', 'daemon')
const ROSTER_FILE = join(DAEMON_DIR, 'roster.json')

type WorkerRegistration = {
  name: string
  pid: number
  hostname: string
  startedAt: string
  lastHeartbeat: string
  status: 'running' | 'completed' | 'failed'
}

type Roster = {
  workers: WorkerRegistration[]
}

function ensureDir(): void {
  if (!existsSync(DAEMON_DIR)) {
    mkdirSync(DAEMON_DIR, { recursive: true })
  }
}

function readRoster(): Roster {
  try {
    return JSON.parse(readFileSync(ROSTER_FILE, 'utf-8')) as Roster
  } catch {
    return { workers: [] }
  }
}

function writeRoster(roster: Roster): void {
  writeFileSync(ROSTER_FILE, JSON.stringify(roster, null, 2))
}

/**
 * 注册一个 worker 到 daemon roster。
 * 如果同名 worker 已存在，更新其记录。
 */
export function registerWorker(name: string): WorkerRegistration {
  ensureDir()
  const roster = readRoster()
  roster.workers = roster.workers.filter((w) => w.name !== name)
  const reg: WorkerRegistration = {
    name,
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    status: 'running',
  }
  roster.workers.push(reg)
  writeRoster(roster)
  return reg
}

/**
 * 更新 worker 的心跳时间戳。
 */
export function heartbeatWorker(name: string): void {
  const roster = readRoster()
  const worker = roster.workers.find((w) => w.name === name)
  if (worker) {
    worker.lastHeartbeat = new Date().toISOString()
    writeRoster(roster)
  }
}

/**
 * 从 roster 中注销一个 worker。
 */
export function unregisterWorker(name: string, status: 'completed' | 'failed' = 'completed'): void {
  const roster = readRoster()
  const worker = roster.workers.find((w) => w.name === name)
  if (worker) {
    worker.status = status
    worker.lastHeartbeat = new Date().toISOString()
  }
  writeRoster(roster)
}

/**
 * 列出所有已注册的 worker。
 */
export function listWorkers(): WorkerRegistration[] {
  return readRoster().workers
}

/**
 * 运行一个 daemon worker。
 * worker 类型由 name 参数指定。
 * 辅助功能 — 自动处理注册/注销生命周期。
 */
export async function runDaemonWorker(workerName: string): Promise<void> {
  if (!feature('DAEMON')) {
    console.log('Daemon subsystem is not enabled (DAEMON feature flag)')
    return
  }

  console.log(`Daemon worker '${workerName}' starting (PID ${process.pid})`)
  registerWorker(workerName)

  try {
    switch (workerName) {
      case 'assistant': {
        // 后台 assistant 任务 — 运行 side-query
        console.log('Assistant worker: not yet implemented')
        break
      }
      case 'cron': {
        // 定时任务执行器
        console.log('Cron worker: not yet implemented')
        break
      }
      case 'session': {
        // 远程会话 worker
        console.log('Session worker: not yet implemented')
        break
      }
      default: {
        console.error(`Unknown worker type: ${workerName}`)
        unregisterWorker(workerName, 'failed')
        process.exit(1)
      }
    }

    unregisterWorker(workerName, 'completed')
    console.log(`Daemon worker '${workerName}' completed`)
  } catch (error) {
    console.error(`Daemon worker '${workerName}' failed:`, error)
    unregisterWorker(workerName, 'failed')
    process.exit(1)
  }
}
