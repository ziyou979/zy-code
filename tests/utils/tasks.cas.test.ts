/**
 * Task revision/claimToken/CAS 测试
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdir, unlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  createTask,
  getTask,
  updateTask,
  updateTaskCAS,
  claimTask,
  type Task,
} from '../../src/utils/tasks.js'

const testDir = join(tmpdir(), `zy-test-tasks-cas-${randomUUID()}`)
const originalZyHome = process.env.ZY_CONFIG_HOME
const originalHome = process.env.HOME

describe('Task revision + CAS', () => {
  beforeAll(async () => {
    process.env.ZY_CONFIG_HOME = testDir
    process.env.HOME = testDir
    await mkdir(testDir, { recursive: true })
    await mkdir(join(testDir, 'tasks'), { recursive: true })
    // 设置团队目录（task 系统需要此目录）
    process.env.ZY_TEAMS_DIR = join(testDir, 'teams')
    await mkdir(join(testDir, 'teams'), { recursive: true })
    // 设置 session ID
    if (!process.env.ZY_SESSION_ID) {
      process.env.ZY_SESSION_ID = `test-session-${randomUUID()}`
    }
  })

  afterAll(async () => {
    if (originalZyHome === undefined) delete process.env.ZY_CONFIG_HOME
    else process.env.ZY_CONFIG_HOME = originalZyHome
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    delete process.env.ZY_TEAMS_DIR
    try {
      const files = await readdir(testDir)
      for (const f of files) await unlink(join(testDir, f)).catch(() => {})
      await unlink(testDir).catch(() => {})
    } catch {}
  })

  const testListId = `test-list-${randomUUID()}`

  test('创建 task 后 revision 为 1', async () => {
    const taskId = await createTask(testListId, {
      subject: 'test',
      description: 'desc',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })
    expect(taskId).toBeTruthy()
    const task = await getTask(testListId, taskId)
    expect(task).not.toBeNull()
    expect(task!.revision).toBe(1)
  })

  test('更新 task 后 revision 递增', async () => {
    const taskId = await createTask(testListId, {
      subject: 'revision test',
      description: '',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })
    const before = await getTask(testListId, taskId)
    expect(before!.revision).toBe(1)

    await updateTask(testListId, taskId, { subject: 'updated' })
    const after = await getTask(testListId, taskId)
    expect(after!.revision).toBe(2)

    await updateTask(testListId, taskId, { status: 'in_progress' })
    const after2 = await getTask(testListId, taskId)
    expect(after2!.revision).toBe(3)
  })

  test('claimTask 后返回 claimToken 和更新的 revision', async () => {
    const taskId = await createTask(testListId, {
      subject: 'claim test',
      description: '',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })
    const result = await claimTask(testListId, taskId, 'agent-1')
    expect(result.success).toBe(true)
    expect(result.claimToken).toBeTruthy()
    expect(result.claimRevision).toBeGreaterThanOrEqual(2)
    expect(result.claimToken).toContain('agent-1')

    // 验证磁盘状态
    const task = await getTask(testListId, taskId)
    expect(task!.status).toBe('in_progress')
    expect(task!.owner).toBe('agent-1')
    expect(task!.claimToken).toBe(result.claimToken)
  })

  test('CAS 成功：预期匹配时更新', async () => {
    const taskId = await createTask(testListId, {
      subject: 'cas success',
      description: '',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })
    // task 默认 revision=1
    const result1 = await updateTaskCAS({
      taskListId: testListId,
      taskId,
      expectedStatus: 'pending',
      expectedRevision: 1,
      updates: { owner: 'agent-2' },
    })
    expect(result1.success).toBe(true)
    expect(result1.task!.revision).toBe(2)
    expect(result1.task!.owner).toBe('agent-2')
  })

  test('CAS 失败：revision 不匹配时返回冲突', async () => {
    const taskId = await createTask(testListId, {
      subject: 'cas conflict',
      description: '',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })
    // 先更新一次使 revision=2
    const result1 = await updateTaskCAS({
      taskListId: testListId,
      taskId,
      expectedStatus: 'pending',
      expectedRevision: 1,
      updates: { owner: 'agent-3' },
    })
    expect(result1.success).toBe(true)
    // 第二次使用旧 revision=1 更新，应冲突
    const result2 = await updateTaskCAS({
      taskListId: testListId,
      taskId,
      expectedStatus: 'pending',
      expectedRevision: 1, // 过期的 revision
      updates: { owner: 'agent-4' },
    })
    expect(result2.success).toBe(false)
    expect(result2.conflict).toContain('revision_mismatch')
    // 验证磁盘状态没有被覆盖
    const task = await getTask(testListId, taskId)
    expect(task!.owner).toBe('agent-3') // 仍然是 agent-3
  })

  test('CAS 失败：status 不匹配时返回冲突', async () => {
    const taskId = await createTask(testListId, {
      subject: 'cas status conflict',
      description: '',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })
    const result = await updateTaskCAS({
      taskListId: testListId,
      taskId,
      expectedStatus: 'in_progress', // 实际是 pending
      expectedRevision: 1,
      updates: { owner: 'agent-5' },
    })
    expect(result.success).toBe(false)
    expect(result.conflict).toContain('status_mismatch')
  })

  test('claimTask 后同一个 agent 可以再次 claim（重新领取）', async () => {
    const taskId = await createTask(testListId, {
      subject: 'reclaim test',
      description: '',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })
    await claimTask(testListId, taskId, 'agent-reclaim')
    // agent 可以 claim 自己的 task（已经是 owner）
    const result = await claimTask(testListId, taskId, 'agent-reclaim')
    expect(result.success).toBe(true)
    expect(result.claimToken).toBeTruthy()
  })

  test('claimTask 后其他 agent 不能再次 claim', async () => {
    const taskId = await createTask(testListId, {
      subject: 'double claim',
      description: '',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })
    await claimTask(testListId, taskId, 'agent-first')
    const result = await claimTask(testListId, taskId, 'agent-second')
    expect(result.success).toBe(false)
    expect(result.reason).toBe('already_claimed')
  })

  test('CAS claimToken 不匹配时拒绝', async () => {
    const taskId = await createTask(testListId, {
      subject: 'claim token check',
      description: '',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })
    // claim task
    await claimTask(testListId, taskId, 'agent-token')
    // 使用错误的 claimToken 尝试 CAS 更新
    const result = await updateTaskCAS({
      taskListId: testListId,
      taskId,
      expectedStatus: 'in_progress',
      expectedRevision: 2,
      expectedClaimToken: 'wrong-token',
      updates: { status: 'completed' },
    })
    expect(result.success).toBe(false)
    expect(result.conflict).toContain('claim_token')
  })

  test('不存在的 task 返回 task_not_found', async () => {
    const result = await updateTaskCAS({
      taskListId: testListId,
      taskId: '999999',
      expectedStatus: 'pending',
      expectedRevision: 1,
      updates: { description: 'test' },
    })
    expect(result.success).toBe(false)
    expect(result.conflict).toBe('task_not_found')
  })
})
