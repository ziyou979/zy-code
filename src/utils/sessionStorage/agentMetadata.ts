import type { Dirent } from 'node:fs'
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AgentId } from '../../types/ids.js'
import { logForDebugging } from '../debug.js'
import { isFsInaccessible } from '../errors.js'
import {
  getAgentMetadataPath,
  getRemoteAgentMetadataPath,
  getRemoteAgentsDir,
} from './paths.js'

export type AgentMetadata = {
  agentType: string
  /** 代理以 isolation: "worktree" 方式启动时的 worktree 路径 */
  worktreePath?: string
  /** 来自 AgentTool 输入的原始任务描述。持久化后恢复的代理通知可
   * 显示原始描述而非占位符。可选 — 旧 metadata 文件可能缺少此字段。 */
  description?: string
}

/**
 * 持久化启动子代理的 agentType。恢复时读取以便 subagent_type 省略时
 * 正确路由 — 否则恢复 fork 会静默降级为通用模式（4KB system prompt，
 * 无继承历史）。使用 sidecar 文件避免 JSONL schema 变更。
 *
 * 代理以 worktree 隔离方式启动时也会存储 worktreePath，
 * 使恢复时可还原正确的 cwd。
 */
export async function writeAgentMetadata(agentId: AgentId, metadata: AgentMetadata): Promise<void> {
  const path = getAgentMetadataPath(agentId)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(metadata))
}

export async function readAgentMetadata(agentId: AgentId): Promise<AgentMetadata | null> {
  const path = getAgentMetadataPath(agentId)
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as AgentMetadata
  } catch (e) {
    if (isFsInaccessible(e)) {
      return null
    }
    throw e
  }
}

export type RemoteAgentMetadata = {
  taskId: string
  remoteTaskType: string
  /** CCR session ID — 恢复时用于从 Sessions API 获取实时状态。 */
  sessionId: string
  title: string
  command: string
  spawnedAt: number
  toolUseId?: string
  isLongRunning?: boolean
  isUltraplan?: boolean
  isRemoteReview?: boolean
  remoteTaskMetadata?: Record<string, unknown>
}

/**
 * 持久化远程代理任务的 metadata，以便 session 恢复时可还原。
 * 按任务的 sidecar 文件（与 subagents/ 同级目录）在 hydrateSessionFromRemote
 * 的 .jsonl 清除中幸存；状态总是从 CCR 重新获取 — 只有身份信息在本地持久化。
 */
export async function writeRemoteAgentMetadata(
  taskId: string,
  metadata: RemoteAgentMetadata,
): Promise<void> {
  const path = getRemoteAgentMetadataPath(taskId)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(metadata))
}

export async function readRemoteAgentMetadata(taskId: string): Promise<RemoteAgentMetadata | null> {
  const path = getRemoteAgentMetadataPath(taskId)
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as RemoteAgentMetadata
  } catch (e) {
    if (isFsInaccessible(e)) {
      return null
    }
    throw e
  }
}

export async function deleteRemoteAgentMetadata(taskId: string): Promise<void> {
  const path = getRemoteAgentMetadataPath(taskId)
  try {
    await unlink(path)
  } catch (e) {
    if (isFsInaccessible(e)) {
      return
    }
    throw e
  }
}

/**
 * 扫描 remote-agents/ 目录中所有已持久化的 metadata 文件。
 * 由 restoreRemoteAgentTasks 使用，以重新连接仍在运行的 CCR session。
 */
export async function listRemoteAgentMetadata(): Promise<RemoteAgentMetadata[]> {
  const dir = getRemoteAgentsDir()
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (e) {
    if (isFsInaccessible(e)) {
      return []
    }
    throw e
  }
  const results: RemoteAgentMetadata[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.meta.json')) {
      continue
    }
    try {
      const raw = await readFile(join(dir, entry.name), 'utf-8')
      results.push(JSON.parse(raw) as RemoteAgentMetadata)
    } catch (e) {
      // 跳过不可读或损坏的文件 — 崩溃时 fire-and-forget 写入产生的部分写入
      // 不应导致整个恢复失败。
      logForDebugging(`listRemoteAgentMetadata: skipping ${entry.name}: ${String(e)}`)
    }
  }
  return results
}
