import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CannotRetryError } from '../../../src/services/api/withRetry.js'
import {
  clearAuthChainFailureCounts,
  tryAdvanceAuthChainOnError,
} from '../../../src/services/model/modelChainFailover.js'
import { confirmAuthFailover } from '../../../src/services/model/modelChainFailoverPrompt.js'
import {
  clearAllModelChainSticky,
  getStickyForTier,
} from '../../../src/services/model/modelChainState.js'
import type { SettingsJson } from '../../../src/services/settings/types.js'
import type { PromptRequest, PromptResponse } from '../../../src/types/hooks/index.js'
import { LLMError } from '../../../src/types/llm.js'

const err = new CannotRetryError(new LLMError('bad key', 401), {
  model: 'model-a',
  thinkingConfig: { type: 'disabled' },
})

function settingsWith(mode?: 'confirm' | 'notify' | 'off', max = 2): SettingsJson {
  return {
    provider: 'generic',
    mainLoopModel: 'standard',
    models: {
      standard: [
        { provider: 'generic-primary', model: 'model-a' },
        { provider: 'generic-backup', model: 'model-b' },
      ],
    },
    modelFailover: { ...(mode ? { mode } : {}), maxConsecutiveFailures: max },
  }
}

/** 构造确认上下文；answer 为 undefined 时提示永不返回（用于中断场景） */
function ctxWith(
  answer?: string | Error,
  overrides: { agentId?: string; nonInteractive?: boolean } = {},
) {
  const abortController = new AbortController()
  const asked: PromptRequest[] = []
  const requestPrompt = mock((_title: string) => (request: PromptRequest) => {
    asked.push(request)
    if (answer === undefined) {
      return new Promise<PromptResponse>(() => {})
    }
    if (answer instanceof Error) {
      return Promise.reject(answer)
    }
    return Promise.resolve({ prompt_response: request.prompt, selected: answer })
  })
  return {
    asked,
    requestPrompt,
    ctx: {
      abortController,
      agentId: overrides.agentId as never,
      requestModelFailoverPrompt: requestPrompt,
      options: { isNonInteractiveSession: overrides.nonInteractive ?? false },
    },
  }
}

let configDir: string
let prevConfigDir: string | undefined

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'zy-failover-confirm-'))
  prevConfigDir = process.env.ZY_CONFIG_DIR
  process.env.ZY_CONFIG_DIR = configDir
  writeFileSync(
    join(configDir, 'auth.json'),
    JSON.stringify({
      'generic-primary': { provider: 'generic', baseUrl: 'https://one.example/v1' },
      'generic-backup': { provider: 'generic', baseUrl: 'https://two.example/v1' },
    }),
  )
  clearAuthChainFailureCounts()
  clearAllModelChainSticky(null)
})

afterEach(() => {
  clearAuthChainFailureCounts()
  if (prevConfigDir === undefined) {
    delete process.env.ZY_CONFIG_DIR
  } else {
    process.env.ZY_CONFIG_DIR = prevConfigDir
  }
  rmSync(configDir, { recursive: true, force: true })
})

describe('auth chain failover propose/commit', () => {
  test('默认 confirm：达到阈值仅提议，commit 前 sticky 不变', () => {
    const settings = settingsWith()
    expect(tryAdvanceAuthChainOnError('model-a', err, settings)).toBeNull()
    const proposal = tryAdvanceAuthChainOnError('model-a', err, settings)
    expect(proposal?.mode).toBe('confirm')
    expect(proposal?.next.model).toBe('model-b')
    expect(getStickyForTier('standard', settings)).toBeNull()

    const committed = proposal!.commit()
    expect(committed?.model).toBe('model-b')
    const sticky = getStickyForTier('standard', settings)
    expect(sticky?.index).toBe(1)
    expect(sticky?.authProfile).toBe('generic-backup')
  })

  test('拒绝后清零计数，阈值重新累计且不写 sticky', () => {
    const settings = settingsWith()
    tryAdvanceAuthChainOnError('model-a', err, settings)
    tryAdvanceAuthChainOnError('model-a', err, settings)!.decline()
    expect(getStickyForTier('standard', settings)).toBeNull()
    expect(tryAdvanceAuthChainOnError('model-a', err, settings)).toBeNull()
    expect(tryAdvanceAuthChainOnError('model-a', err, settings)?.next.model).toBe('model-b')
  })

  test('notify 模式标记为自动切换', () => {
    const proposal = tryAdvanceAuthChainOnError('model-a', err, settingsWith('notify', 1))
    expect(proposal?.mode).toBe('notify')
  })

  test('off 模式不提议、不写 sticky', () => {
    const settings = settingsWith('off', 1)
    expect(tryAdvanceAuthChainOnError('model-a', err, settings)).toBeNull()
    expect(getStickyForTier('standard', settings)).toBeNull()
  })
})

describe('confirmAuthFailover', () => {
  const proposal = () => {
    clearAuthChainFailureCounts()
    return tryAdvanceAuthChainOnError('model-a', err, settingsWith('confirm', 1))!
  }

  test('用户选择 switch 才返回 true，并使用真实 PromptRequest 形状', async () => {
    const { ctx, asked } = ctxWith('switch')
    expect(await confirmAuthFailover(ctx, proposal())).toBe(true)
    expect(asked[0]?.options.map((o) => o.key)).toEqual(['switch', 'stay'])
    expect(typeof asked[0]?.message).toBe('string')
    expect(asked[0]?.message).toContain('generic-primary')
    expect(asked[0]?.message).toContain('generic-backup')
  })

  test('选择 stay 或提示被拒绝时不切换', async () => {
    expect(await confirmAuthFailover(ctxWith('stay').ctx, proposal())).toBe(false)
    expect(await confirmAuthFailover(ctxWith(new Error('closed')).ctx, proposal())).toBe(false)
    expect(await confirmAuthFailover(ctxWith('unexpected').ctx, proposal())).toBe(false)
  })

  test('请求提示前已中断时不显示确认框', async () => {
    const { ctx, requestPrompt } = ctxWith('switch')
    ctx.abortController.abort()
    expect(await confirmAuthFailover(ctx, proposal())).toBe(false)
    expect(requestPrompt).not.toHaveBeenCalled()
  })

  test('同步阶段中断后不会再调起确认框', async () => {
    const { ctx, requestPrompt } = ctxWith('switch')
    const pending = confirmAuthFailover(ctx, proposal())
    ctx.abortController.abort()
    expect(await pending).toBe(false)
    expect(requestPrompt).not.toHaveBeenCalled()
  })

  test('等待确认期间中断视为拒绝', async () => {
    const { ctx } = ctxWith(undefined)
    const pending = confirmAuthFailover(ctx, proposal())
    ctx.abortController.abort()
    expect(await pending).toBe(false)
  })

  test('子 agent、非交互或无提示通道时不提示也不切换', async () => {
    const sub = ctxWith('switch', { agentId: 'agent-1' })
    expect(await confirmAuthFailover(sub.ctx, proposal())).toBe(false)
    expect(sub.requestPrompt).not.toHaveBeenCalled()
    const headless = ctxWith('switch', { nonInteractive: true })
    expect(await confirmAuthFailover(headless.ctx, proposal())).toBe(false)
    expect(headless.requestPrompt).not.toHaveBeenCalled()
    const noUi = ctxWith('switch')
    expect(
      await confirmAuthFailover({ ...noUi.ctx, requestModelFailoverPrompt: undefined }, proposal()),
    ).toBe(false)
  })
})
