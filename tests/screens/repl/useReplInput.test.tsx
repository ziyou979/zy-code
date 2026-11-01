import { describe, expect, test } from 'bun:test'
import React, { StrictMode, Suspense } from 'react'
import Text from '../../../src/ink/components/Text.js'
import Ink from '../../../src/ink/ink.js'
import { useReplInput } from '../../../src/screens/repl/useReplInput.js'
import { createFileStateCacheWithSizeLimit } from '../../../src/services/file-persistence/fileStateCache.js'
import { getBufferedEarlyInputLength, seedEarlyInput } from '../../../src/ink/earlyInput.js'
import { QueryGuard } from '../../../src/services/query/queryGuard.js'
import { createReplStore } from '../../../src/state/replStore.js'
import { createTerminalStreams } from '../../_helpers/terminalStreams.js'

describe('useReplInput', () => {
  test('挂起的渲染不消费缓存，提交及 StrictMode 重放只追加一次，重挂载保留已有输入', () => {
    const streams = createTerminalStreams()
    const ink = new Ink({
      ...streams,
      stderr: streams.stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    const store = createReplStore({
      initialExternalLoading: false,
      queryGuard: new QueryGuard(),
      titleGenerationAttempted: false,
      readFileState: createFileStateCacheWithSizeLimit(10),
      contentReplacementState: null,
      initialInputValue: 'existing',
    })
    const pending = new Promise<void>(() => {})
    function Target({ suspend }: { suspend: boolean }) {
      useReplInput({
        replStore: store,
        repinScroll() {},
        lastUserScrollTsRef: { current: 0 },
        trySuggestBgPRIntercept: () => false,
      })
      if (suspend) throw pending
      return <Text>input</Text>
    }
    try {
      seedEarlyInput('early')
      ink.render(
        <Suspense fallback={<Text>loading</Text>}>
          <Target suspend={true} />
        </Suspense>,
      )
      expect(getBufferedEarlyInputLength()).toBe(5)
      expect(store.input.getValue()).toBe('existing')
      ink.render(
        <StrictMode>
          <Target suspend={false} />
        </StrictMode>,
      )
      expect(getBufferedEarlyInputLength()).toBe(0)
      expect(store.input.getValue()).toBe('existingearly')
      store.input.setValue('edited')
      ink.render(<Text>unmounted</Text>)
      ink.render(
        <StrictMode>
          <Target suspend={false} />
        </StrictMode>,
      )
      expect(store.input.getValue()).toBe('edited')
    } finally {
      ink.unmount()
      streams.input.destroy()
      seedEarlyInput('')
    }
  })
})
