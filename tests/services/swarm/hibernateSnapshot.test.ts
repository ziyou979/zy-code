/**
 * hibernateSnapshot 测试：验证快照的保存、加载和删除功能。
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdir, writeFile, unlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  saveHibernateSnapshot,
  loadHibernateSnapshot,
  deleteHibernateSnapshot,
  hasHibernateSnapshot,
} from '../../../src/services/swarm/hibernateSnapshot.js'

// 临时覆盖 ZY_CONFIG_HOME 环境变量，使 hibernate 快照写入临时目录
const testDir = join(tmpdir(), `zy-test-hibernate-${randomUUID()}`)
const originalConfigHome = process.env.ZY_CONFIG_HOME

describe('hibernateSnapshot', () => {
  beforeAll(async () => {
    // 使用临时目录作为配置目录
    process.env.ZY_CONFIG_HOME = testDir
    await mkdir(testDir, { recursive: true })
  })

  afterAll(async () => {
    // 清理环境
    if (originalConfigHome === undefined) {
      delete process.env.ZY_CONFIG_HOME
    } else {
      process.env.ZY_CONFIG_HOME = originalConfigHome
    }
    // 清理临时目录
    try {
      const files = await readdir(testDir)
      for (const f of files) {
        await unlink(join(testDir, f)).catch(() => {})
      }
      await unlink(testDir).catch(() => {})
    } catch {}
  })

  const identity = {
    agentId: 'researcher@test-team',
    agentName: 'researcher',
    teamName: 'test-team',
    planModeRequired: false,
    parentSessionId: 'session-123' as any,
  }

  test('保存快照并验证文件存在', async () => {
    const path = await saveHibernateSnapshot(identity, {
      model: 'claude-3-5-sonnet',
      permissionMode: 'default',
      summary: [],
      transcriptPath: '/tmp/transcript.json',
      lastActiveAt: Date.now(),
      lifecycleMode: 'persistent',
    })
    expect(path).toBeTruthy()
    expect(path).toContain('researcher_test-team')
  })

  test('加载保存的快照', async () => {
    const snapshot = await loadHibernateSnapshot('researcher@test-team')
    expect(snapshot).not.toBeNull()
    expect(snapshot!.identity.agentName).toBe('researcher')
    expect(snapshot!.identity.teamName).toBe('test-team')
    expect(snapshot!.model).toBe('claude-3-5-sonnet')
    expect(snapshot!.snapshotVersion).toBe(1)
    expect(snapshot!.lifecycleMode).toBe('persistent')
  })

  test('快照包含 summary 消息', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const summaryMsg: any[] = [
      {
        uuid: 'msg-1',
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
        timestamp: Date.now(),
      },
      {
        uuid: 'msg-2',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi there' }],
        },
        timestamp: Date.now(),
      },
    ]

    await saveHibernateSnapshot(identity, {
      model: 'gpt-4',
      permissionMode: 'plan',
      // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象
      summary: summaryMsg as any,
      transcriptPath: '/tmp/transcript2.json',
      lastActiveAt: Date.now() - 5000,
      lifecycleMode: 'persistent',
    })

    const loaded = await loadHibernateSnapshot('researcher@test-team')
    expect(loaded).not.toBeNull()
    expect(loaded!.summary).toHaveLength(2)
    expect(loaded!.summary[0]).toBeTruthy()
    expect(loaded!.summary[0]!.type).toBe('user')
    expect(loaded!.summary[1]!.type).toBe('assistant')
    expect(loaded!.model).toBe('gpt-4')
    expect(loaded!.permissionMode).toBe('plan')
  })

  test('hasHibernateSnapshot 返回正确', async () => {
    const exists = await hasHibernateSnapshot('researcher@test-team')
    expect(exists).toBe(true)

    const nonExists = await hasHibernateSnapshot('ghost@nonexistent')
    expect(nonExists).toBe(false)
  })

  test('删除快照后返回 null', async () => {
    await deleteHibernateSnapshot('researcher@test-team')
    const snapshot = await loadHibernateSnapshot('researcher@test-team')
    expect(snapshot).toBeNull()
  })

  test('不存在的 agent 返回 null', async () => {
    const snapshot = await loadHibernateSnapshot('does-not-exist@team')
    expect(snapshot).toBeNull()
  })

  test('版本不兼容时返回 null', async () => {
    // 写入一个旧版本号的快照（sanitizeForPath 把 @ 替换为 _）
    const hibernateDir = join(testDir, 'hibernated-agents')
    await mkdir(hibernateDir, { recursive: true })
    const oldSnapshotPath = join(hibernateDir, 'v0-agent_team.snapshot.json')
    await writeFile(
      oldSnapshotPath,
      JSON.stringify({
        snapshotVersion: 0, // 旧版本
        identity: { agentId: 'v0-agent@team', agentName: 'v0-agent', teamName: 'team' },
        summary: [],
        lastActiveAt: Date.now(),
        hibernatedAt: Date.now(),
        lifecycleMode: 'persistent',
      }),
    )

    const snapshot = await loadHibernateSnapshot('v0-agent@team')
    expect(snapshot).toBeNull()
  })
})
