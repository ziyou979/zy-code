import { afterEach, beforeEach, describe, expect, mock, test, spyOn } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as classifierModule from '../../../src/services/permissions/yoloClassifier.js'
import {
  getAllowedSettingSources,
  getMainLoopModelOverride,
  setAllowedSettingSources,
  setMainLoopModelOverride,
} from '../../../src/bootstrap/runtime/runtimeContext.js'
import { AUTO_MODE_EVALUATION_CASES } from '../../../src/services/permissions/autoModeEvaluation.js'
import {
  cancelAutoModeEvaluationTask,
  startAutoModeEvaluationTask,
} from '../../../src/services/permissions/autoModeEvaluationTask.js'
import {
  getAutoModeModelAuthorization,
  getAutoModeQualificationFingerprint,
} from '../../../src/services/permissions/autoModeQualification.js'
import { resetSettingsCache } from '../../../src/services/settings/settingsCache.js'
import { getDefaultAppState, type AppState } from '../../../src/state/AppStateStore.js'
import { createStore } from '../../../src/state/store.js'
import { BashTool } from '../../../src/tools/BashTool/BashTool.js'
import type { ToolUseContext } from '../../../src/tools/tool.js'

let previousConfig: string | undefined
let previousSources: ReturnType<typeof getAllowedSettingSources>
let previousModel: ReturnType<typeof getMainLoopModelOverride>
let configDir: string
let calls: number
let release: () => void
let gate: Promise<void>
const model = 'background-test'

beforeEach(() => {
  previousConfig = process.env.ZY_CONFIG_DIR
  previousSources = getAllowedSettingSources()
  previousModel = getMainLoopModelOverride()
  configDir = mkdtempSync(join(tmpdir(), 'zy-background-eval-'))
  process.env.ZY_CONFIG_DIR = configDir
  setAllowedSettingSources(['userSettings'])
  setMainLoopModelOverride(model)
  writeFileSync(
    join(configDir, 'settings.json'),
    JSON.stringify({ provider: 'generic', models: { standard: { provider: 'generic', model } } }),
  )
  writeFileSync(
    join(configDir, 'auth.json'),
    JSON.stringify({
      generic: {
        provider: 'generic',
        apiFormat: 'openai-chat',
        apiKey: 'fixture-key',
        baseUrl: 'https://fixture.invalid/v1',
      },
    }),
  )
  resetSettingsCache()
  calls = 0
  gate = new Promise((resolve) => {
    release = resolve
  })
  spyOn(classifierModule, 'classifyYoloAction').mockImplementation(async (messages, action) => {
    calls++
    expect(JSON.stringify(messages)).not.toContain('CURRENT_TASK_HISTORY')
    await gate
    const block = action.content.find((item) => item.type === 'tool_call')
    const input = block?.type === 'tool_call' ? (block.input as { command: string }) : undefined
    const sample = AUTO_MODE_EVALUATION_CASES.find((item) => item.command === input?.command)
    return { model, shouldBlock: sample?.shouldBlock ?? true, reason: 'Fixture' }
  })
})

afterEach(() => {
  release()
  mock.restore()
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

async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) {
      return
    }
    await Bun.sleep(10)
  }
  throw new Error('Background evaluation did not settle')
}

function context() {
  const store = createStore<AppState>(getDefaultAppState())
  const mainController = new AbortController()
  const value = {
    options: { tools: [BashTool] },
    messages: [{ text: 'CURRENT_TASK_HISTORY' }],
    abortController: mainController,
    getAppState: store.getState,
    setAppState: store.setState,
  } as unknown as ToolUseContext
  return { store, value, mainController }
}

describe('autoModeEvaluationTask', () => {
  test('后台评测独立于当前任务中止信号，通过后不改权限模式', async () => {
    const { store, value, mainController } = context()
    const mode = store.getState().toolPermissionContext.mode
    expect(
      startAutoModeEvaluationTask(value, model, getAutoModeQualificationFingerprint(model)).error,
    ).toBeNull()
    expect(store.getState().autoModeEvaluation?.status).toBe('running')
    mainController.abort()
    release()
    await waitUntil(() => store.getState().autoModeEvaluation?.status !== 'running')
    expect(store.getState().autoModeEvaluation?.status).toBe('passed')
    expect(store.getState().toolPermissionContext.mode).toBe(mode)
    expect(calls).toBe(48)
    expect(getAutoModeModelAuthorization(model)).toBe('verified')
  })
  test('重复启动不重复计费，取消只终止评测且不写部分通过结果', async () => {
    const { store, value, mainController } = context()
    const fingerprint = getAutoModeQualificationFingerprint(model)
    const mode = store.getState().toolPermissionContext.mode
    expect(startAutoModeEvaluationTask(value, model, fingerprint).error).toBeNull()
    expect(startAutoModeEvaluationTask(value, model, fingerprint).error).not.toBeNull()
    expect(calls).toBe(1)
    cancelAutoModeEvaluationTask(value)
    await waitUntil(() => store.getState().autoModeEvaluation?.status === 'cancelled')
    expect(mainController.signal.aborted).toBe(false)
    expect(store.getState().toolPermissionContext.mode).toBe(mode)
    expect(existsSync(join(configDir, 'model-capabilities', 'auto-mode-qualifications.json'))).toBe(
      false,
    )
  })
})
