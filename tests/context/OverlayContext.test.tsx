import { describe, expect, test } from 'bun:test'
import React, { StrictMode } from 'react'
import { useIsModalOverlayActive, useRegisterOverlay } from '../../src/context/OverlayContext.js'
import Text from '../../src/ink/components/Text.js'
import Ink from '../../src/ink/ink.js'
import { AppStoreContext } from '../../src/state/AppState.js'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import { createStore } from '../../src/state/store.js'
import { createTerminalStreams } from '../_helpers/terminalStreams.js'

function Overlay({ kind, enabled = true }: { kind: string; enabled?: boolean }) {
  useRegisterOverlay(kind, enabled)
  return null
}

describe('OverlayContext', () => {
  test('同类实例独立注册，注销、切换类型与 StrictMode 重放不会清掉其他实例', () => {
    const streams = createTerminalStreams()
    const ink = new Ink({
      ...streams,
      stderr: streams.stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    const store = createStore(getDefaultAppState())
    let modal = false
    function Observer() {
      modal = useIsModalOverlayActive()
      return <Text>overlay</Text>
    }
    const render = (first: boolean, kind = 'select', enabled = true) =>
      ink.render(
        <AppStoreContext.Provider value={store}>
          <StrictMode>
            {first && <Overlay key="first" kind="select" />}
            <Overlay key="second" kind={kind} enabled={enabled} />
            <Observer />
          </StrictMode>
        </AppStoreContext.Provider>,
      )
    try {
      render(true)
      expect([...store.getState().activeOverlays.values()]).toEqual(['select', 'select'])
      expect(modal).toBe(true)
      render(false)
      expect([...store.getState().activeOverlays.values()]).toEqual(['select'])
      expect(modal).toBe(true)
      render(false, 'autocomplete')
      expect([...store.getState().activeOverlays.values()]).toEqual(['autocomplete'])
      expect(modal).toBe(false)
      render(false, 'select', false)
      expect(store.getState().activeOverlays.size).toBe(0)
      expect(modal).toBe(false)
    } finally {
      ink.unmount()
      streams.input.destroy()
    }
    expect(store.getState().activeOverlays.size).toBe(0)
  })
})
