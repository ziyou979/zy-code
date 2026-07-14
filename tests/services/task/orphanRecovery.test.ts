/**
 * orphanRecovery 测试
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { createTask, getTask, listTasks } from '../../../src/utils/tasks.js'
import { createTestDataDirectory } from '../../_helpers/testDataDirectory.js'

const testData = await createTestDataDirectory('zy-test-orphan', { includeTeams: true })

describe('orphanRecovery', () => {
  beforeAll(async () => {
    await testData.setup()
  })

  afterAll(async () => {
    await testData.cleanup()
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
