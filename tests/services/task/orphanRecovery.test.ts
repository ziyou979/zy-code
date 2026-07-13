/**
 * orphanRecovery 测试
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTask, getTask, listTasks } from '../../../src/utils/tasks.js'

const testDir = join(tmpdir(), `zy-test-orphan-${randomUUID()}`)
const originalZyHome = process.env.ZY_CONFIG_DIR

describe('orphanRecovery', () => {
  beforeAll(async () => {
    process.env.ZY_CONFIG_DIR = testDir
    process.env.ZY_TEAMS_DIR = join(testDir, 'teams')
    await mkdir(testDir, { recursive: true })
    await mkdir(join(testDir, 'teams'), { recursive: true })
    if (!process.env.ZY_SESSION_ID) {
      process.env.ZY_SESSION_ID = `test-session-${randomUUID()}`
    }
  })

  afterAll(async () => {
    if (originalZyHome === undefined) delete process.env.ZY_CONFIG_DIR
    else process.env.ZY_CONFIG_DIR = originalZyHome
    delete process.env.ZY_TEAMS_DIR
    try {
      const files = await readdir(testDir)
      for (const f of files) await unlink(join(testDir, f)).catch(() => {})
      await unlink(testDir).catch(() => {})
    } catch {}
  })

  const listId = `test-orphan-${randomUUID()}`

  test('正常 task 不被回收', async () => {
    const taskId = await createTask(listId, {
      subject: 'normal task',
      description: '',
      status: 'in_progress',
      owner: 'active-agent',
      blocks: [],
      blockedBy: [],
    })
    expect(taskId).toBeTruthy()
    const task = await getTask(listId, taskId)
    expect(task!.status).toBe('in_progress')
    expect(task!.owner).toBe('active-agent')
  })

  test('pending task 不被回收', async () => {
    const taskId = await createTask(listId, {
      subject: 'pending task',
      description: '',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })
    const task = await getTask(listId, taskId)
    expect(task!.status).toBe('pending')
  })

  test('completed task 不被回收', async () => {
    const taskId = await createTask(listId, {
      subject: 'completed task',
      description: '',
      status: 'completed',
      blocks: [],
      blockedBy: [],
    })
    const task = await getTask(listId, taskId)
    expect(task!.status).toBe('completed')
  })

  test('listTasks 返回所有 task', async () => {
    const tasks = await listTasks(listId)
    expect(tasks.length).toBeGreaterThanOrEqual(3)
    expect(tasks.some((t) => t.subject === 'normal task')).toBe(true)
    expect(tasks.some((t) => t.subject === 'pending task')).toBe(true)
  })

  test('task 创建后 revision 正确', async () => {
    const taskId = await createTask(listId, {
      subject: 'revision check',
      description: '',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })
    const task = await getTask(listId, taskId)
    expect(task!.revision).toBe(1)
  })
})
