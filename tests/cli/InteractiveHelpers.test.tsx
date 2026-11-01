import { describe, expect, test } from 'bun:test'
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import { showSetupDialog } from '../../src/cli/InteractiveHelpers.js'
import { warmI18n } from '../../src/i18n/index.js'
import { AlternateScreen } from '../../src/ink/components/AlternateScreen.js'
import Text from '../../src/ink/components/Text.js'
import instances from '../../src/ink/instances.js'
import { createRoot } from '../../src/ink/root.js'
import { ENTER_ALT_SCREEN, EXIT_ALT_SCREEN } from '../../src/ink/termio/dec.js'

async function createFixture() {
  await warmI18n()
  const chunks: string[] = []
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk))
      callback()
    },
  }) as unknown as NodeJS.WriteStream
  stdout.columns = 100
  stdout.rows = 30
  stdout.isTTY = true
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  const root = await createRoot({ stdout, stderr: stdout, stdin, patchConsole: false })
  const ink = instances.get(stdout)!
  const previousInstance = instances.get(process.stdout)
  // AlternateScreen 按进程 stdout 查找渲染器；将测试流对应的实例注入同一入口。
  instances.set(process.stdout, ink)
  return {
    root,
    ink,
    output: () => chunks.join(''),
    close() {
      root.unmount()
      if (previousInstance) instances.set(process.stdout, previousInstance)
      else instances.delete(process.stdout)
      stdin.destroy()
      stdout.destroy()
    },
  }
}

describe('showSetupDialog 临时启动提示', () => {
  test('确认后先恢复主屏幕，再进入会话，退出时不重新绘制信任提示', async () => {
    const fixture = await createFixture()
    let complete: (value: string) => void = () => {}
    try {
      const result = showSetupDialog<string>(
        fixture.root,
        (done) => {
          complete = done
          return <Text>TRUST_REMINDER</Text>
        },
        { transient: true },
      )
      fixture.ink.onRender()
      const reminder = fixture.output()
      expect(fixture.ink.isAltScreenActive).toBe(true)
      expect(reminder.indexOf(ENTER_ALT_SCREEN)).toBeLessThan(reminder.indexOf('TRUST_REMINDER'))
      complete('accepted')
      expect(await result).toBe('accepted')
      expect(fixture.ink.isAltScreenActive).toBe(false)
      expect(fixture.output()).toContain(EXIT_ALT_SCREEN)

      const afterReminder = fixture.output().length
      fixture.root.render(
        <AlternateScreen mouseTracking={false}>
          <Text>SESSION_READY</Text>
        </AlternateScreen>,
      )
      fixture.ink.onRender()
      fixture.root.unmount()
      const session = fixture.output().slice(afterReminder)
      expect(session).toContain(ENTER_ALT_SCREEN)
      expect(session).toContain('SESSION_READY')
      expect(session).toContain(EXIT_ALT_SCREEN)
      expect(session).not.toContain('TRUST_REMINDER')
    } finally {
      fixture.close()
    }
  })

  test('在提示阶段直接退出也恢复主屏幕', async () => {
    const fixture = await createFixture()
    try {
      void showSetupDialog(fixture.root, () => <Text>TRUST_REMINDER</Text>, { transient: true })
      fixture.ink.onRender()
      expect(fixture.ink.isAltScreenActive).toBe(true)
      fixture.root.unmount()
      const output = fixture.output()
      expect(output.indexOf(ENTER_ALT_SCREEN)).toBeLessThan(output.indexOf('TRUST_REMINDER'))
      expect(output.indexOf(EXIT_ALT_SCREEN)).toBeGreaterThan(output.indexOf('TRUST_REMINDER'))
      expect(fixture.ink.isAltScreenActive).toBe(false)
    } finally {
      fixture.close()
    }
  })
})
