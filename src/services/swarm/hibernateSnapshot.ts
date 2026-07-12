/**
 * Hibernate snapshot/resume 模块
 *
 * 为 persistent agent 提供 hibernation 快照保存与恢复功能。
 * Runner 退出时保存快照；收到新消息时根据快照重建 runner。
 *
 * 不属于 src/utils/ 因为它涉及磁盘 I/O 和 agent 生命周期领域逻辑。
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  HibernatedAgentSnapshot,
  TeammateIdentity,
} from '../../tasks/InProcessTeammateTask/types.js'
import { getZyConfigHomeDir } from '../../utils/envUtils.js'
import { logForDebugging } from '../../utils/debug.js'
import { jsonStringify, jsonParse } from '../../utils/slowOperations.js'
import type { Message } from '../../types/message.js'

/**
 * hibernate 快照的版本号，用于校验 resume 合法性。
 */
const SNAPSHOT_VERSION = 1

/**
 * 获取 hibernate 快照存储目录。
 */
function getHibernateDir(): string {
  return join(getZyConfigHomeDir(), 'hibernated-agents')
}

/**
 * 获取指定 agent 的快照文件路径。
 */
function getSnapshotPath(agentId: string): string {
  return join(getHibernateDir(), `${sanitizeForPath(agentId)}.snapshot.json`)
}

/**
 * 将 agentId 中的特殊字符替换为安全字符。
 */
function sanitizeForPath(s: string): string {
  return s.replace(/[@/\\:]/g, '_')
}

/**
 * 保存 agent hibernate 快照到磁盘。
 * 返回快照路径。
 */
export async function saveHibernateSnapshot(
  identity: TeammateIdentity,
  options: {
    model?: string
    permissionMode: string
    summary: Message[]
    transcriptPath: string
    lastActiveAt: number
    lifecycleMode: 'ephemeral' | 'persistent'
  },
): Promise<string> {
  const dir = getHibernateDir()
  await mkdir(dir, { recursive: true })

  const snapshot: HibernatedAgentSnapshot = {
    identity,
    model: options.model,
    permissionMode: options.permissionMode as any,
    summary: options.summary,
    transcriptPath: options.transcriptPath,
    lastActiveAt: options.lastActiveAt,
    hibernatedAt: Date.now(),
    lifecycleMode: options.lifecycleMode,
    snapshotVersion: SNAPSHOT_VERSION,
  }

  const path = getSnapshotPath(identity.agentId)
  await writeFile(path, jsonStringify(snapshot, null, 2))

  logForDebugging(
    `[hibernate] Saved snapshot for ${identity.agentId} at ${path} (${options.summary.length} summary messages)`,
  )

  return path
}

/**
 * 从磁盘加载 agent hibernate 快照。
 */
export async function loadHibernateSnapshot(
  agentId: string,
): Promise<HibernatedAgentSnapshot | null> {
  try {
    const path = getSnapshotPath(agentId)
    const raw = await readFile(path, 'utf-8')
    const parsed = jsonParse(raw) as HibernatedAgentSnapshot | null

    if (!parsed || parsed.snapshotVersion !== SNAPSHOT_VERSION) {
      logForDebugging(
        `[hibernate] Snapshot for ${agentId} has incompatible version (expected ${SNAPSHOT_VERSION}, got ${parsed?.snapshotVersion})`,
      )
      return null
    }

    logForDebugging(
      `[hibernate] Loaded snapshot for ${agentId} (hibernated at ${new Date(parsed.hibernatedAt).toISOString()})`,
    )

    return parsed
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logForDebugging(`[hibernate] Failed to load snapshot for ${agentId}: ${err}`)
    }
    return null
  }
}

/**
 * 删除 agent hibernate 快照（resume 成功后或 agent 被 kill 时调用）。
 */
export async function deleteHibernateSnapshot(agentId: string): Promise<void> {
  try {
    const path = getSnapshotPath(agentId)
    await unlink(path)
    logForDebugging(`[hibernate] Deleted snapshot for ${agentId}`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logForDebugging(`[hibernate] Failed to delete snapshot for ${agentId}: ${err}`)
    }
  }
}

/**
 * 检查指定 agent 是否存在 hibernate 快照（用于判断可恢复性）。
 */
export async function hasHibernateSnapshot(agentId: string): Promise<boolean> {
  try {
    const path = getSnapshotPath(agentId)
    await readFile(path, 'utf-8')
    return true
  } catch {
    return false
  }
}
