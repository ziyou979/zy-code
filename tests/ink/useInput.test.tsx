import { describe, expect, test } from 'bun:test'
import React from 'react'
import StdinContext from '../../src/ink/components/StdinContext.js'
import { EventEmitter } from '../../src/ink/events/emitter.js'
import { InputEvent } from '../../src/ink/events/inputEvent.js'
import useInput from '../../src/ink/hooks/useInput.js'
import Ink from '../../src/ink/ink.js'
import { INITIAL_STATE, parseMultipleKeypresses } from '../../src/ink/parseKeypress.js'
import { createTerminalStreams } from '../_helpers/terminalStreams.js'

function inputEvent() {
  const parsed = parseMultipleKeypresses(INITIAL_STATE, 'x')[0][0]!
  if (parsed.kind !== 'key') throw new Error('Expected a key event')
  return new InputEvent(parsed)
}

describe('useInput', () => {
  test('启用读取时同步到达的按键已有订阅者', () => {
    const streams = createTerminalStreams()
    const ink = new Ink({
      ...streams,
      stderr: streams.stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    const emitter = new EventEmitter()
    const received: string[] = []
    function Target() {
      useInput((input) => received.push(input))
      return null
    }
    try {
      ink.render(
        <StdinContext.Provider
          value={{
            stdin: streams.stdin,
            isRawModeSupported: true,
            internal_exitOnCtrlC: false,
            internal_eventEmitter: emitter,
            internal_querier: null,
            setRawMode(enabled) {
              if (enabled) emitter.emit('input', inputEvent())
            },
          }}
        >
          <Target />
        </StdinContext.Provider>,
      )
      expect(received).toEqual(['x'])
    } finally {
      ink.unmount()
      streams.input.destroy()
    }
    expect(emitter.listenerCount('input')).toBe(0)
  })

  test('禁用后重新启用保持监听顺序和事件拦截语义', () => {
    const streams = createTerminalStreams()
    const ink = new Ink({
      ...streams,
      stderr: streams.stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    const emitter = new EventEmitter()
    const received: string[] = []
    function First({ active }: { active: boolean }) {
      useInput(
        (_input, _key, event) => {
          received.push('first')
          event.stopImmediatePropagation()
        },
        { isActive: active },
      )
      return null
    }
    function Second() {
      useInput(() => received.push('second'))
      return null
    }
    const render = (active: boolean) =>
      ink.render(
        <StdinContext.Provider
          value={{
            stdin: streams.stdin,
            isRawModeSupported: true,
            internal_exitOnCtrlC: false,
            internal_eventEmitter: emitter,
            internal_querier: null,
            setRawMode() {},
          }}
        >
          <First active={active} />
          <Second />
        </StdinContext.Provider>,
      )
    try {
      render(false)
      emitter.emit('input', inputEvent())
      expect(received).toEqual(['second'])
      received.length = 0
      render(true)
      emitter.emit('input', inputEvent())
      expect(received).toEqual(['first'])
      render(false)
      render(true)
      expect(emitter.listenerCount('input')).toBe(2)
    } finally {
      ink.unmount()
      streams.input.destroy()
    }
  })
})
