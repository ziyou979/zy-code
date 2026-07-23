/**
 * teammateMailboxMessages 消息构造器/检测器测试。
 *
 * 覆盖范围：
 *   - formatTeammateMessages：消息格式化
 *   - IdleNotification：构造与检测
 *   - PermissionRequest / PermissionResponse：构造与检测
 *   - isStructuredProtocolMessage：路由判断
 */
import { describe, expect, test } from 'bun:test'

const {
  formatTeammateMessages,
  createIdleNotification,
  isIdleNotification,
  createPermissionRequestMessage,
  createPermissionResponseMessage,
  isPermissionRequest,
  isPermissionResponse,
  isStructuredProtocolMessage,
} = await import('../../../src/services/swarm/teammateMailboxMessages.js')

// ============================================================================
// formatTeammateMessages
// ============================================================================
describe('formatTeammateMessages', () => {
  test('格式化单条消息，标签为 teammate-message', () => {
    const result = formatTeammateMessages([
      { from: 'lead', text: 'hello', timestamp: '2025-01-01T00:00:00Z' },
    ])
    expect(result).toContain('teammate-message')
    expect(result).toContain('teammate_id="lead"')
    expect(result).toContain('hello')
  })

  test('多条消息用空行分隔', () => {
    const result = formatTeammateMessages([
      { from: 'a', text: 'first', timestamp: '2025-01-01T00:00:00Z' },
      { from: 'b', text: 'second', timestamp: '2025-01-01T00:00:01Z' },
    ])
    expect(result).toContain('first')
    expect(result).toContain('second')
    expect(result).toMatch(/\n\n/)
  })

  test('包含 color 和 summary 属性', () => {
    const result = formatTeammateMessages([
      {
        from: 'c',
        text: 'colored',
        timestamp: '2025-01-01T00:00:00Z',
        color: 'red',
        summary: 'brief',
      },
    ])
    expect(result).toContain('color="red"')
    expect(result).toContain('summary="brief"')
  })

  test('空数组返回空字符串', () => {
    expect(formatTeammateMessages([])).toBe('')
  })
})

// ============================================================================
// IdleNotification
// ============================================================================
describe('IdleNotification', () => {
  test('create → is 正反查正确', () => {
    const msg = createIdleNotification('agent-1', {
      idleReason: 'available',
      summary: 'task done',
      completedTaskId: 'task-1',
      completedStatus: 'resolved',
    })
    expect(msg.type).toBe('idle_notification')
    expect(msg.from).toBe('agent-1')
    expect(msg.idleReason).toBe('available')
    expect(msg.summary).toBe('task done')
    expect(msg.completedTaskId).toBe('task-1')
    expect(msg.completedStatus).toBe('resolved')

    const raw = JSON.stringify(msg)
    const detected = isIdleNotification(raw)
    expect(detected).not.toBeNull()
    expect(detected!.from).toBe('agent-1')
  })

  test('isIdleNotification 非 JSON 返回 null', () => {
    expect(isIdleNotification('not json')).toBeNull()
  })

  test('isIdleNotification 错误类型返回 null', () => {
    expect(isIdleNotification(JSON.stringify({ type: 'other' }))).toBeNull()
  })

  test('无选项参数也能创建有效通知', () => {
    const msg = createIdleNotification('agent-2')
    const raw = JSON.stringify(msg)
    expect(isIdleNotification(raw)).not.toBeNull()
  })
})

// ============================================================================
// PermissionRequest / PermissionResponse
// ============================================================================
describe('PermissionRequest', () => {
  test('create → is 正反查正确', () => {
    const msg = createPermissionRequestMessage({
      request_id: 'req-1',
      agent_id: 'agent-a',
      tool_name: 'Bash',
      toolCallId: 'call-1',
      description: '执行 bash 命令',
      input: { command: 'ls' },
    })
    expect(msg.type).toBe('permission_request')
    expect(msg.tool_name).toBe('Bash')
    expect(msg.description).toBe('执行 bash 命令')

    const raw = JSON.stringify(msg)
    const detected = isPermissionRequest(raw)
    expect(detected).not.toBeNull()
    expect(detected!.request_id).toBe('req-1')
    expect(detected!.tool_name).toBe('Bash')
  })

  test('isPermissionRequest 非匹配 JSON 返回 null', () => {
    expect(isPermissionRequest(JSON.stringify({ type: 'other' }))).toBeNull()
  })

  test('isPermissionRequest 无效 JSON 返回 null', () => {
    expect(isPermissionRequest('{{{')).toBeNull()
  })
})

describe('PermissionResponse', () => {
  test('create (success) → is 正反查正确', () => {
    const msg = createPermissionResponseMessage({
      request_id: 'req-1',
      subtype: 'success',
    })
    expect(msg.type).toBe('permission_response')
    expect(msg.subtype).toBe('success')

    const raw = JSON.stringify(msg)
    const detected = isPermissionResponse(raw)
    expect(detected).not.toBeNull()
    expect(detected!.request_id).toBe('req-1')
  })

  test('create (error) → subtype 为 error 且有错误信息', () => {
    const msg = createPermissionResponseMessage({
      request_id: 'req-2',
      subtype: 'error',
      error: 'Permission denied by user',
    })
    expect(msg.subtype).toBe('error')
    expect((msg as { subtype: 'error'; error: string }).error).toBe('Permission denied by user')
  })

  test('isPermissionResponse 非匹配返回 null', () => {
    expect(isPermissionResponse(JSON.stringify({ type: 'other' }))).toBeNull()
  })
})

// ============================================================================
// isStructuredProtocolMessage
// ============================================================================
describe('isStructuredProtocolMessage', () => {
  test('permission_request 识别为协议消息', () => {
    const raw = JSON.stringify(
      createPermissionRequestMessage({
        request_id: 'r1',
        agent_id: 'a',
        tool_name: 'Bash',
        toolCallId: 'c1',
        description: 'd',
        input: {},
      }),
    )
    expect(isStructuredProtocolMessage(raw)).toBe(true)
  })

  test('permission_response 识别为协议消息', () => {
    const raw = JSON.stringify(
      createPermissionResponseMessage({
        request_id: 'r2',
        subtype: 'success',
      }),
    )
    expect(isStructuredProtocolMessage(raw)).toBe(true)
  })

  test('idle_notification 不被视为协议消息（不含在路由列表中）', () => {
    const raw = JSON.stringify(createIdleNotification('a'))
    expect(isStructuredProtocolMessage(raw)).toBe(false)
  })

  test('普通文本不识别为协议消息', () => {
    expect(isStructuredProtocolMessage('hello')).toBe(false)
  })

  test('非协议 JSON 不识别', () => {
    expect(isStructuredProtocolMessage(JSON.stringify({ type: 'chat' }))).toBe(false)
  })

  test('无效 JSON 不识别', () => {
    expect(isStructuredProtocolMessage('{bad json}')).toBe(false)
  })
})
