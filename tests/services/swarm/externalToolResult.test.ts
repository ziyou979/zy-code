/**
 * externalToolResult 测试：验证工具结果外置的存储、加载和清除功能。
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { unlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  storeToolResultExternally,
  loadExternalToolResult,
  clearExternalToolResults,
} from '../../../src/services/swarm/externalToolResult.js'
import { TOOL_RESULT_EXTERNAL_THRESHOLD_BYTES } from '../../../src/tasks/InProcessTeammateTask/types.js'

const testDir = join(tmpdir(), `zy-test-ext-tool-${randomUUID()}`)
const originalConfigHome = process.env.ZY_CONFIG_HOME

describe('externalToolResult', () => {
  beforeAll(async () => {
    process.env.ZY_CONFIG_HOME = testDir
    const { mkdir } = await import('node:fs/promises')
    await mkdir(testDir, { recursive: true })
  })

  afterAll(async () => {
    if (originalConfigHome === undefined) {
      delete process.env.ZY_CONFIG_HOME
    } else {
      process.env.ZY_CONFIG_HOME = originalConfigHome
    }
    try {
      await unlink(testDir).catch(() => {})
    } catch {}
  })

  const taskId = 'test-task-123'
  const toolCallId = 'tool-use-abc'

  test('小结果（低于阈值）不存储', async () => {
    const smallContent = [{ type: 'text' as const, text: '小结果' }]
    const ref = await storeToolResultExternally(taskId, 'small-tool', smallContent)
    expect(ref).toBeNull()
  })

  test('大结果（超过阈值）存储到磁盘', async () => {
    const largeText = 'x'.repeat(TOOL_RESULT_EXTERNAL_THRESHOLD_BYTES + 1)
    const largeContent = [{ type: 'text' as const, text: largeText }]
    const ref = await storeToolResultExternally(taskId, toolCallId, largeContent)
    expect(ref).not.toBeNull()
    expect(ref!.type).toBe('stored_tool_result')
    expect(ref!.toolCallId).toBe(toolCallId)
    expect(ref!.byteLength).toBeGreaterThanOrEqual(TOOL_RESULT_EXTERNAL_THRESHOLD_BYTES)
    expect(ref!.path).toBeTruthy()
    expect(ref!.preview).toBeTruthy()
  })

  test('从磁盘加载外置结果', async () => {
    // "大结果"测试已存储了 toolCallId 对应的文件，直接用其 ref 信息加载
    const ref = await storeToolResultExternally(taskId, 'load-test', [
      { type: 'text' as const, text: 'test data' },
    ])
    // 小内容不存储，直接构造一个文件测试加载
    const { writeFile, mkdir } = await import('node:fs/promises')
    const dir = join(testDir, 'external-tool-results', taskId)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'load-test.json'),
      JSON.stringify([{ type: 'text', text: 'loaded content' }]),
    )
    const loaded = await loadExternalToolResult({
      type: 'stored_tool_result',
      toolCallId: 'load-test',
      path: join(dir, 'load-test.json'),
      byteLength: 100,
      preview: '',
    })
    expect(loaded).not.toBeNull()
    expect(Array.isArray(loaded)).toBe(true)
    expect(loaded!.length).toBe(1)
    expect(loaded![0]!.type).toBe('text')
    expect((loaded![0]! as any).text).toBe('loaded content')
  })

  test('预览截断超过 500 字符的长内容', async () => {
    // 需要超过 512KB 才能触发外置存储
    const veryLongText = 'Hello World - ' + 'x'.repeat(TOOL_RESULT_EXTERNAL_THRESHOLD_BYTES)
    const content = [{ type: 'text' as const, text: veryLongText }]
    const ref = await storeToolResultExternally(taskId, 'preview-test', content)
    expect(ref).not.toBeNull()
    expect(ref!.preview.length).toBeLessThan(veryLongText.length)
    // 预览应包含原始文本开头
    expect(ref!.preview).toStartWith('Hello World - ')
  })

  test('不存在的路径返回 null', async () => {
    const result = await loadExternalToolResult({
      type: 'stored_tool_result',
      toolCallId: 'nonexistent',
      path: join(testDir, 'not-exists.json'),
      byteLength: 0,
      preview: '',
    })
    expect(result).toBeNull()
  })

  test('清除 task 的外置结果', async () => {
    // 先存一个结果
    const largeText = 'y'.repeat(TOOL_RESULT_EXTERNAL_THRESHOLD_BYTES + 1)
    await storeToolResultExternally(taskId, 'cleanup-test', [
      { type: 'text' as const, text: largeText },
    ])
    // 清除
    await clearExternalToolResults(taskId)
    // 验证文件不再存在
    const result = await loadExternalToolResult({
      type: 'stored_tool_result',
      toolCallId: 'cleanup-test',
      path: join(testDir, 'external-tool-results', taskId, 'cleanup-test.json'),
      byteLength: 100,
      preview: '',
    })
    expect(result).toBeNull()
  })

  test('清除不存在的 task 不报错', async () => {
    await expect(clearExternalToolResults('non-existent-task')).resolves.toBeUndefined()
  })

  test('加载非法 JSON 返回 null', async () => {
    const { writeFile } = await import('node:fs/promises')
    const { mkdir } = await import('node:fs/promises')
    const dir = join(testDir, 'external-tool-results', taskId)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'invalid.json'), '不是有效 JSON{{{', 'utf-8')
    const result = await loadExternalToolResult({
      type: 'stored_tool_result',
      toolCallId: 'invalid',
      path: join(dir, 'invalid.json'),
      byteLength: 100,
      preview: '',
    })
    expect(result).toBeNull()
  })
})
