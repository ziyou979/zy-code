/**
 * Daemon 主入口 — 长期运行的 supervisor 进程。
 *
 * 职责：
 * - 管理 daemon 锁文件（PID-based，带 stale 检测）
 * - 维护 worker roster（已注册的 worker 清单）
 * - 生成 socket token 用于 IPC 鉴权
 *
 * 当前通过 feature('DAEMON') 门控，构建时 DCE。
 */
import { feature } from 'bun:bundle'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createServer, type AddressInfo } from 'node:net'
import { logForDebugging } from '../utils/debug.js'

// --------------- constants ---------------

const DAEMON_DIR = join(homedir(), '.zy', 'daemon')
const LOCK_FILE = join(DAEMON_DIR, 'daemon.lock')
const ROSTER_FILE = join(DAEMON_DIR, 'roster.json')
const SOCKET_TOKEN_FILE = join(DAEMON_DIR, 'socket.token')

// --------------- lock file ---------------

type DaemonLock = {
  pid: number
  hostname: string
  startedAt: string
}

function ensureDaemonDir(): void {
  if (!existsSync(DAEMON_DIR)) {
    mkdirSync(DAEMON_DIR, { recursive: true })
  }
}

function readLock(): DaemonLock | null {
  try {
    return JSON.parse(readFileSync(LOCK_FILE, 'utf-8')) as DaemonLock
  } catch {
    return null
  }
}

function writeLock(): DaemonLock {
  const lock: DaemonLock = {
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
  }
  writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 2))
  return lock
}

function isStaleLock(lock: DaemonLock): boolean {
  try {
    // POSIX: kill(pid, 0) 检测进程是否存在
    process.kill(lock.pid, 0)
    return false
  } catch {
    return true
  }
}

function clearLock(): void {
  try {
    if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE)
  } catch {
    // 清理时忽略错误
  }
}

// --------------- socket token ---------------

function generateSocketToken(): string {
  return randomBytes(32).toString('hex')
}

function readOrCreateSocketToken(): string {
  try {
    const existing = readFileSync(SOCKET_TOKEN_FILE, 'utf-8').trim()
    if (existing.length >= 32) return existing
  } catch {
    // 不存在或无效，生成新的
  }
  const token = generateSocketToken()
  writeFileSync(SOCKET_TOKEN_FILE, token)
  return token
}

// --------------- roster ---------------

type WorkerRegistration = {
  name: string
  pid: number
  startedAt: string
  lastHeartbeat: string
}

type Roster = {
  workers: WorkerRegistration[]
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

function registerWorker(name: string): void {
  const roster = readRoster()
  // 移除同名旧记录
  roster.workers = roster.workers.filter((w) => w.name !== name)
  roster.workers.push({
    name,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
  })
  writeRoster(roster)
}

function unregisterWorker(name: string): void {
  const roster = readRoster()
  roster.workers = roster.workers.filter((w) => w.name !== name)
  writeRoster(roster)
}

// --------------- daemon main ---------------

export async function daemonMain(args: string[]): Promise<void> {
  if (!feature('DAEMON')) {
    console.log('Daemon subsystem is not enabled (DAEMON feature flag)')
    return
  }

  const subcommand = args[0]

  if (subcommand === 'lock' || subcommand === 'status') {
    // 查询 daemon 状态
    const lock = readLock()
    if (!lock) {
      console.log('Daemon is not running.')
      return
    }
    if (isStaleLock(lock)) {
      console.log(`Daemon lock is stale (PID ${lock.pid} no longer exists).`)
      clearLock()
      return
    }
    console.log(`Daemon is running:
  PID: ${lock.pid}
  Hostname: ${lock.hostname}
  Started: ${lock.startedAt}`)
    return
  }

  if (subcommand === 'stop' || subcommand === 'kill') {
    const lock = readLock()
    if (!lock) {
      console.log('Daemon is not running.')
      return
    }
    if (!isStaleLock(lock)) {
      try {
        process.kill(lock.pid, 'SIGTERM')
      } catch {
        // 忽略
      }
    }
    clearLock()
    console.log('Daemon stopped.')
    return
  }

  if (subcommand === 'clear-lock') {
    clearLock()
    console.log('Daemon lock cleared.')
    return
  }

  // 默认：启动 daemon
  ensureDaemonDir()
  const existingLock = readLock()
  if (existingLock && !isStaleLock(existingLock)) {
    console.error(`Daemon is already running (PID ${existingLock.pid}).`)
    console.error('Use "zy daemon stop" to stop it, or "zy daemon clear-lock" to force clear.')
    process.exit(1)
  }

  // 清理旧锁（如果存在且 stale）
  if (existingLock) clearLock()

  // 写入新锁
  const lock = writeLock()
  const socketToken = readOrCreateSocketToken()

  // 注册 daemon 自身到 roster
  registerWorker('daemon')

  // 启动简单的 Unix socket 服务用于 IPC 健康检查
  const server = createServer((socket) => {
    // 简单的鉴权：客户端发送 token，daemon 验证
    socket.once('data', (data) => {
      const clientToken = data.toString().trim()
      if (clientToken === socketToken) {
        socket.write(JSON.stringify({ status: 'ok', pid: process.pid }))
      } else {
        socket.write(JSON.stringify({ status: 'error', message: 'invalid token' }))
      }
      socket.end()
    })
  })

  try {
    // 使用 Unix socket 或 Windows named pipe
    const socketPath = join(DAEMON_DIR, 'daemon.sock')
    // 清理旧 socket
    try { unlinkSync(socketPath) } catch { /* ignore */ }

    server.listen(socketPath, () => {
      const addr = server.address() as AddressInfo
      logForDebugging(`Daemon started (PID ${lock.pid}, socket: ${socketPath})`)
      console.log(`Daemon started. PID: ${lock.pid}`)
    })

    // 优雅退出
    const shutdown = () => {
      logForDebugging('Daemon shutting down...')
      unregisterWorker('daemon')
      clearLock()
      server.close()
      process.exit(0)
    }

    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)

    // 保持进程运行
    await new Promise(() => {})
  } catch (error) {
    console.error('Failed to start daemon:', error)
    unregisterWorker('daemon')
    clearLock()
    process.exit(1)
  }
}
