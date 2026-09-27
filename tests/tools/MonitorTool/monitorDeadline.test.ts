import { describe, expect, test } from 'bun:test'
import { armMonitorDeadline } from '../../../src/tools/MonitorTool/monitorDeadline.js'
import type { ExecResult, ShellCommand } from '../../../src/services/shell/shellCommand.js'

function makeCommand() {
  const completion = Promise.withResolvers<ExecResult>()
  let kills = 0
  const command: Pick<ShellCommand, 'status' | 'result' | 'kill'> = {
    status: 'backgrounded',
    result: completion.promise,
    kill() {
      kills++
      command.status = 'killed'
      completion.resolve({ stdout: '', stderr: '', code: 137, interrupted: true })
    },
  }
  return { command, completion, kills: () => kills }
}

describe('armMonitorDeadline', () => {
  test('转后台后仍到期终止且只通知一次', async () => {
    const { command, kills } = makeCommand()
    let notifications = 0
    armMonitorDeadline(command, 5, () => notifications++)
    await Bun.sleep(25)
    expect(kills()).toBe(1)
    expect(notifications).toBe(1)
  })

  test('自然结束和手动停止后不产生迟到通知', async () => {
    for (const status of ['completed', 'killed'] as const) {
      const { command, completion, kills } = makeCommand()
      let notifications = 0
      armMonitorDeadline(command, 5, () => notifications++)
      command.status = status
      completion.resolve({ stdout: '', stderr: '', code: 0, interrupted: false })
      await Bun.sleep(25)
      expect(kills()).toBe(0)
      expect(notifications).toBe(0)
    }
  })

  test('持久监控不设置截止时间', async () => {
    const { command, kills } = makeCommand()
    let notifications = 0
    armMonitorDeadline(command, null, () => notifications++)
    await Bun.sleep(25)
    expect(kills()).toBe(0)
    expect(notifications).toBe(0)
    command.kill()
  })
})
