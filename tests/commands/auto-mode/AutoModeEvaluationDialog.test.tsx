import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import {
  getAllowedSettingSources,
  getMainLoopModelOverride,
  setAllowedSettingSources,
  setMainLoopModelOverride,
  getSessionId,
  switchSession,
} from '../../../src/bootstrap/runtime/runtimeContext.js'
import { call } from '../../../src/commands/auto-mode/AutoModeEvaluationDialog.js'
import { AutoModeOptInDialog } from '../../../src/components/AutoModeOptInDialog.js'
import { getAutoModeModelAuthorization } from '../../../src/services/permissions/autoModeQualification.js'
import type { LocalJSXCommandContext } from '../../../src/commands/types.js'
import { tSync, warmI18n } from '../../../src/i18n/index.js'
import type { Frame } from '../../../src/ink/frame.js'
import Ink from '../../../src/ink/ink.js'
import { charInCellAt } from '../../../src/ink/screen.js'
import { KeybindingSetup } from '../../../src/keybindings/KeybindingProviderSetup.js'
import { resetSettingsCache } from '../../../src/services/settings/settingsCache.js'
import { AppStateProvider, useAppStateStore } from '../../../src/state/AppState.js'
import { getDefaultAppState, type AppStateStore } from '../../../src/state/AppStateStore.js'
import { BashTool } from '../../../src/tools/BashTool/BashTool.js'

const originalFetch = globalThis.fetch
let previousConfig: string | undefined
let previousSources: ReturnType<typeof getAllowedSettingSources>
let previousModel: ReturnType<typeof getMainLoopModelOverride>
let configDir: string
let requests: number

beforeEach(async () => {
  await warmI18n()
  previousConfig = process.env.ZY_CONFIG_DIR
  previousSources = getAllowedSettingSources()
  previousModel = getMainLoopModelOverride()
  configDir = mkdtempSync(join(tmpdir(), 'zy-evaluation-consent-'))
  process.env.ZY_CONFIG_DIR = configDir
  setAllowedSettingSources(['userSettings'])
  setMainLoopModelOverride('consent-test-model')
  writeFileSync(
    join(configDir, 'settings.json'),
    JSON.stringify({
      provider: 'generic',
      models: { standard: { provider: 'generic', model: 'consent-test-model' } },
    }),
  )
  writeFileSync(
    join(configDir, 'auth.json'),
    JSON.stringify({
      generic: {
        provider: 'generic',
        apiFormat: 'openai-chat',
        baseUrl: 'https://fixture.invalid/v1',
        apiKey: 'fixture-key',
      },
    }),
  )
  resetSettingsCache()
  requests = 0
  globalThis.fetch = (async () => {
    requests++
    return new Response(JSON.stringify({ error: { message: 'Fixture only' } }), { status: 401 })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (previousConfig === undefined) {
    delete process.env.ZY_CONFIG_DIR
  } else {
    process.env.ZY_CONFIG_DIR = previousConfig
  }
  setAllowedSettingSources(previousSources)
  setMainLoopModelOverride(previousModel)
  resetSettingsCache()
  rmSync(configDir, { recursive: true, force: true })
})

function textOf(frame: Frame | undefined): string {
  if (!frame) {
    return ''
  }
  const lines: string[] = []
  for (let y = 0; y < frame.screen.height; y++) {
    let line = ''
    for (let x = 0; x < frame.screen.width; x++) {
      line += charInCellAt(frame.screen, x, y)
    }
    lines.push(line)
  }
  return lines.join('\n')
}

async function mount(args: string, firstUse = false, failAccept = false) {
  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  }) as unknown as NodeJS.WriteStream
  stdout.columns = 140
  stdout.rows = 40
  stdout.isTTY = true
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  const ink = new Ink({ stdout, stderr: stdout, stdin, exitOnCtrlC: false, patchConsole: false })
  let latest: Frame | undefined
  ink.frameSink = (frame) => {
    latest = frame
    return true
  }
  const state = getDefaultAppState()
  const abortController = new AbortController()
  const context = {
    options: { tools: [BashTool] },
    abortController,
    getAppState: () => state,
    setAppState: () => {},
  } as unknown as LocalJSXCommandContext
  const closed: string[] = []
  let liveStore: AppStateStore | undefined
  function CaptureStore() {
    liveStore = useAppStateStore()
    return null
  }
  ink.render(
    <AppStateProvider>
      <KeybindingSetup>
        <CaptureStore />
        {firstUse ? (
          <AutoModeOptInDialog
            onAccept={() => {
              if (failAccept) throw new Error('Fixture: auto mode gate changed')
              closed.push('accepted')
              liveStore?.setState((previous) => ({
                ...previous,
                toolPermissionContext: { ...previous.toolPermissionContext, mode: 'auto' },
              }))
            }}
            onDecline={() => closed.push('cancelled')}
            getEvaluationContext={() => context}
          />
        ) : (
          await call(
            (message) => {
              closed.push(message ?? '')
            },
            context,
            args,
          )
        )}
      </KeybindingSetup>
    </AppStateProvider>,
  )
  await Bun.sleep(50)
  return {
    stdin,
    store: () => liveStore!,
    text: () => textOf(latest),
    closed,
    close: () => {
      abortController.abort()
      ink.unmount()
    },
  }
}

describe('AutoModeEvaluationDialog', () => {
  test('模式转换失败时撤销尚未启用的临时授权', async () => {
    const dialog = await mount('', true, true)
    try {
      dialog.stdin.write('2')
      await Bun.sleep(50)
      expect(dialog.closed).toEqual([])
      expect(dialog.text()).toContain(tSync('autoModeEvaluation.error'))
      expect(getAutoModeModelAuthorization('consent-test-model')).toBe('unverified')
      expect(dialog.store().getState().autoModeSessionGrant).toBeUndefined()
      expect(requests).toBe(0)
    } finally {
      dialog.close()
    }
  })
  test('临时允许只影响当前开启，关闭后重新授权，且不保存设置或发起评测', async () => {
    const settingsPath = join(configDir, 'settings.json')
    const original = readFileSync(settingsPath, 'utf8')
    const dialog = await mount('', true)
    try {
      expect(dialog.text()).toContain(tSync('autoModeEvaluation.enableTemporary'))
      dialog.stdin.write('2')
      await Bun.sleep(50)
      expect(dialog.closed).toEqual(['accepted'])
      expect(getAutoModeModelAuthorization('consent-test-model')).toBe('temporary')
      expect(readFileSync(settingsPath, 'utf8')).toBe(original)
      expect(
        existsSync(join(configDir, 'model-capabilities', 'discovered-model-capabilities.json')),
      ).toBe(false)
      expect(requests).toBe(0)
      dialog.store().setState((previous) => ({
        ...previous,
        toolPermissionContext: { ...previous.toolPermissionContext, mode: 'default' },
      }))
      expect(dialog.store().getState().autoModeSessionGrant).toBeUndefined()
      expect(getAutoModeModelAuthorization('consent-test-model')).toBe('unverified')
    } finally {
      dialog.close()
    }
    const reopened = await mount('', true)
    try {
      expect(reopened.text()).toContain(tSync('autoModeEvaluation.enableTemporary'))
      expect(getAutoModeModelAuthorization('consent-test-model')).toBe('unverified')
    } finally {
      reopened.close()
    }
  })
  test('结束对话后临时授权失效', async () => {
    const dialog = await mount('', true)
    dialog.stdin.write('2')
    await Bun.sleep(50)
    expect(getAutoModeModelAuthorization('consent-test-model')).toBe('temporary')
    dialog.close()
    expect(getAutoModeModelAuthorization('consent-test-model')).toBe('unverified')
  })
  test('切换模型或切换对话会清除临时授权', async () => {
    for (const action of ['model', 'session'] as const) {
      const dialog = await mount('', true)
      try {
        dialog.stdin.write('2')
        await Bun.sleep(50)
        expect(getAutoModeModelAuthorization('consent-test-model')).toBe('temporary')
        if (action === 'model') {
          dialog.store().setState((previous) => ({ ...previous, mainLoopModel: 'other-model' }))
        } else {
          // 恢复同一会话也不应恢复一次临时授权。
          switchSession(getSessionId())
        }
        expect(dialog.store().getState().autoModeSessionGrant).toBeUndefined()
        expect(getAutoModeModelAuthorization('consent-test-model')).toBe('unverified')
      } finally {
        dialog.close()
      }
    }
  })

  test('首次始终允许保存能力 true，不发起评测且不伪造通过', async () => {
    const dialog = await mount('', true)
    try {
      expect(dialog.text()).toContain(tSync('autoModeEvaluation.enableDirect'))
      expect(dialog.text()).toContain(tSync('autoModeEvaluation.verifyFirst'))
      expect(getAutoModeModelAuthorization('consent-test-model')).toBe('unverified')
      dialog.stdin.write('3')
      await Bun.sleep(50)
      expect(dialog.closed).toEqual(['accepted'])
      expect(requests).toBe(0)
      expect(getAutoModeModelAuthorization('consent-test-model')).toBe('direct')
    } finally {
      dialog.close()
    }
  })
  test('首次选择评测仅进入费用确认，取消后保持无授权且不请求', async () => {
    const dialog = await mount('', true)
    try {
      dialog.stdin.write('4')
      await Bun.sleep(50)
      expect(dialog.text()).toContain(tSync('autoModeEvaluation.confirmStart'))
      expect(requests).toBe(0)
      dialog.stdin.write('1')
      await Bun.sleep(50)
      expect(getAutoModeModelAuthorization('consent-test-model')).toBe('unverified')
      expect(requests).toBe(0)
    } finally {
      dialog.close()
    }
  })
  test('打开状态页和默认 Enter 关闭均不发起模型请求', async () => {
    const dialog = await mount('status')
    try {
      expect(dialog.text()).toContain(tSync('autoModeEvaluation.start'))
      expect(requests).toBe(0)
      dialog.stdin.write('\r')
      await Bun.sleep(50)
      expect(dialog.closed).toHaveLength(1)
      expect(requests).toBe(0)
      expect(
        existsSync(join(configDir, 'model-capabilities', 'auto-mode-qualifications.json')),
      ).toBe(false)
    } finally {
      dialog.close()
    }
  })
  test('evaluate 参数只展示费用确认，默认 Enter 取消，不暗中消费额度', async () => {
    const dialog = await mount('evaluate')
    try {
      expect(dialog.text()).toContain(tSync('autoModeEvaluation.confirmStart'))
      expect(dialog.text()).toContain(
        tSync('autoModeEvaluation.connection', { connectionId: 'generic' }),
      )
      expect(requests).toBe(0)
      dialog.stdin.write('\r')
      await Bun.sleep(50)
      expect(dialog.text()).toContain(tSync('autoModeEvaluation.start'))
      expect(requests).toBe(0)
      expect(
        existsSync(join(configDir, 'model-capabilities', 'auto-mode-qualifications.json')),
      ).toBe(false)
    } finally {
      dialog.close()
    }
  })
  test('选中评测选项只进入确认页，Escape 可撤回且不产生请求', async () => {
    const dialog = await mount('')
    try {
      dialog.stdin.write('1')
      await Bun.sleep(50)
      expect(dialog.text()).toContain(tSync('autoModeEvaluation.confirmStart'))
      expect(requests).toBe(0)
      dialog.stdin.write('\x1b')
      for (
        let attempt = 0;
        attempt < 50 && !dialog.text().includes(tSync('autoModeEvaluation.start'));
        attempt++
      ) {
        await Bun.sleep(10)
      }
      expect(dialog.text()).toContain(tSync('autoModeEvaluation.start'))
      expect(requests).toBe(0)
    } finally {
      dialog.close()
    }
  })
})
