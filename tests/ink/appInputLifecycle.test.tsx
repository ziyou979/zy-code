import { describe, expect, test } from 'bun:test'
import type { ComponentProps } from 'react'
import App, { handleMouseEvent } from '../../src/ink/components/App.js'
import type { InputEvent } from '../../src/ink/events/inputEvent.js'
import { INITIAL_STATE, parseMultipleKeypresses } from '../../src/ink/parseKeypress.js'
import { createSelectionState } from '../../src/ink/selection.js'
import { xtversion } from '../../src/ink/terminalQuerier.js'
import { createTerminalStreams } from '../_helpers/terminalStreams.js'

function makeApp(overrides: Partial<ComponentProps<typeof App>> = {}) {
  const streams = createTerminalStreams()
  const props: ComponentProps<typeof App> = {
    children: null,
    stdin: streams.stdin,
    stdout: streams.stdout,
    stderr: streams.stdout,
    exitOnCtrlC: false,
    onExit() {},
    terminalColumns: 80,
    terminalRows: 24,
    selection: createSelectionState(),
    onSelectionChange() {},
    onClickAt: () => false,
    onHoverAt() {},
    getHyperlinkAt: () => undefined,
    onOpenHyperlink() {},
    onMultiClick() {},
    onSelectionDrag() {},
    dispatchKeyboardEvent() {},
    ...overrides,
  }
  const app = new App(props)
  const events: InputEvent[] = []
  app.internal_eventEmitter.on('input', (event: InputEvent) => events.push(event))
  return { app, events, ...streams }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('App 输入生命周期', () => {
  test('重复释放不产生负计数，重新获取仍能读取输入', async () => {
    const { app, input, events } = makeApp()
    try {
      app.handleSetRawMode(false)
      app.handleSetRawMode(false)
      expect(app.rawModeEnabledCount).toBe(0)
      app.handleSetRawMode(true)
      app.handleSetRawMode(true)
      app.handleSetRawMode(false)
      expect(input.isRaw).toBe(true)
      input.push('hello')
      await tick()
      expect(events.map((event) => event.input).join('')).toBe('hello')
      app.handleSetRawMode(false)
      app.handleSetRawMode(false)
      app.handleSetRawMode(true)
      input.push('world')
      await tick()
      expect(events.map((event) => event.input).join('')).toBe('helloworld')
    } finally {
      app.componentWillUnmount()
      input.destroy()
    }
  })

  test('销毁一次释放全部所有者，晚到的 Hook 清理和启动回调不再产生副作用', async () => {
    const { app, input, writes } = makeApp()
    app.handleSetRawMode(true)
    app.handleSetRawMode(true)
    app.componentWillUnmount()
    const count = writes.length
    app.handleSetRawMode(false)
    app.handleSetRawMode(true)
    app.componentWillUnmount()
    await tick()
    expect(app.rawModeEnabledCount).toBe(0)
    expect(input.isRaw).toBe(false)
    expect(input.listenerCount('readable')).toBe(0)
    // 重复 componentWillUnmount 允许再次显示光标，但不允许发出终端查询。
    expect(writes.slice(count).join('')).not.toContain('\x1b[>0q')
    input.destroy()
  })

  test('快速释放再获取只保留当前一轮的启动查询', async () => {
    const { app, input, writes } = makeApp()
    try {
      app.handleSetRawMode(true)
      app.handleSetRawMode(false)
      app.handleSetRawMode(true)
      await tick()
      expect(writes.filter((write) => write === '\x1b[>0q').length).toBe(1)
    } finally {
      app.componentWillUnmount()
      input.destroy()
    }
  })

  test('启动补读触发退出后，不再发送查询或向已卸载组件派发按键', async () => {
    let exits = 0
    const { app, input, writes, events } = makeApp({
      exitOnCtrlC: true,
      onExit() {
        exits++
      },
    })
    input.push('\x03')
    app.handleSetRawMode(true)
    await tick()
    expect(exits).toBe(1)
    expect(events).toHaveLength(0)
    expect(writes.join('')).not.toContain('\x1b[>0q')
    expect(input.isRaw).toBe(false)
    app.componentWillUnmount()
    input.destroy()
  })

  test('卸载会结束未收到终端应答的查询', async () => {
    const { app, input } = makeApp()
    const pending = app.querier.send(xtversion())
    const barrier = app.querier.flush()
    app.componentWillUnmount()
    expect(await pending).toBeUndefined()
    await barrier
    input.destroy()
  })

  test('缺少粘贴结束标记时按空闲超时恢复，后续按键正常派发', async () => {
    const { app, input, events } = makeApp()
    try {
      app.handleSetRawMode(true)
      app.processInput('\x1b[200~hello')
      expect(app.keyParseState.incomplete).toBe('')
      expect(app.incompleteEscapeTimer).not.toBeNull()
      await wait(300)
      app.processInput('世界')
      await wait(300)
      expect(events).toHaveLength(0)
      await wait(250)
      expect(app.keyParseState.mode).toBe('NORMAL')
      expect(events.map((event) => event.input)).toEqual(['hello世界'])
      app.processInput('next')
      expect(events.map((event) => event.input)).toEqual(['hello世界', 'next'])
    } finally {
      app.componentWillUnmount()
      input.destroy()
    }
  })

  test('空粘贴超时也会退出粘贴模式，完整粘贴结束后不重复派发', async () => {
    const { app, input, events } = makeApp()
    try {
      app.handleSetRawMode(true)
      app.processInput('\x1b[200~')
      await wait(550)
      expect(app.keyParseState.mode).toBe('NORMAL')
      app.processInput('\x1b[200~text\x1b[201~')
      expect(events.map((event) => event.input)).toEqual(['text'])
      expect(app.incompleteEscapeTimer).toBeNull()
    } finally {
      app.componentWillUnmount()
      input.destroy()
    }
  })

  test('移交带入的未结束粘贴在没有新数据时也启动恢复定时器', async () => {
    const { app, input, events } = makeApp()
    try {
      app.keyParseState = parseMultipleKeypresses(INITIAL_STATE, '\x1b[200~early')[1]
      app.handleSetRawMode(true)
      await tick()
      expect(app.incompleteEscapeTimer).not.toBeNull()
      await wait(550)
      expect(events.map((event) => event.input)).toEqual(['early'])
    } finally {
      app.componentWillUnmount()
      input.destroy()
    }
  })

  test('可点击元素消耗单击后重置多击计数，500ms 内快速二次点击仍触发 onClickAt 且不产生冗余选区重绘', () => {
    let clicks = 0
    let multiClicks = 0
    let selectionChanges = 0
    const { app, input } = makeApp({
      onClickAt: () => {
        clicks++
        return true
      },
      onMultiClick: () => {
        multiClicks++
      },
      onSelectionChange: () => {
        selectionChanges++
      },
    })
    try {
      // 第一次单击（展开）
      handleMouseEvent(app, {
        kind: 'mouse',
        button: 0,
        col: 10,
        row: 5,
        action: 'press',
        sequence: '\x1b[<0;10;5M',
      })
      handleMouseEvent(app, {
        kind: 'mouse',
        button: 0,
        col: 10,
        row: 5,
        action: 'release',
        sequence: '\x1b[<0;10;5m',
      })
      // 500ms 内立即第二次单击同一坐标（收起）
      handleMouseEvent(app, {
        kind: 'mouse',
        button: 0,
        col: 10,
        row: 5,
        action: 'press',
        sequence: '\x1b[<0;10;5M',
      })
      handleMouseEvent(app, {
        kind: 'mouse',
        button: 0,
        col: 10,
        row: 5,
        action: 'release',
        sequence: '\x1b[<0;10;5m',
      })

      expect(clicks).toBe(2)
      expect(multiClicks).toBe(0)
      expect(selectionChanges).toBe(0)
    } finally {
      app.componentWillUnmount()
      input.destroy()
    }
  })
})
