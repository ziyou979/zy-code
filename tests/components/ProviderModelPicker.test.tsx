import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { ProviderModelPicker } from '../../src/components/ProviderModelPicker.js'
import { tSync, warmI18n } from '../../src/i18n/index.js'
import type { Frame } from '../../src/ink/frame.js'
import Ink from '../../src/ink/ink.js'
import { charInCellAt } from '../../src/ink/screen.js'
import { AppStateProvider } from '../../src/state/AppState.js'
import { resetSettingsCache } from '../../src/services/settings/settingsCache.js'
import {
  getLocalContextWindow,
  getLocalModelInputModalities,
  getLocalModelEffortLevels,
  getLocalModelEffortMap,
} from '../../src/services/settings/localModelCapabilities.js'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function frameText(frame: Frame | undefined): string {
  if (!frame) return ''
  const lines: string[] = []
  for (let y = 0; y < frame.screen.height; y++) {
    let line = ''
    for (let x = 0; x < frame.screen.width; x++) line += charInCellAt(frame.screen, x, y)
    lines.push(line)
  }
  return lines.join('\n')
}

async function mountPicker(provider = 'ant-ling', actualProvider = 'ant-ling', registry = false) {
  await warmI18n()
  const previousDir = process.env.ZY_CONFIG_DIR
  const configDir = mkdtempSync(join(tmpdir(), 'zy-picker-'))
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    join(configDir, 'auth.json'),
    JSON.stringify({
      [provider]: { provider: actualProvider, apiKey: 'old-key', apiFormat: 'openai-chat' },
    }),
  )
  process.env.ZY_CONFIG_DIR = configDir
  writeFileSync(
    join(configDir, 'settings.json'),
    JSON.stringify(registry ? {} : { modelCapabilityCatalogUrl: null }),
  )
  resetSettingsCache()
  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  }) as unknown as NodeJS.WriteStream
  stdout.columns = 110
  stdout.rows = 35
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
  const choices: string[] = []
  ink.render(
    <AppStateProvider>
      <ProviderModelPicker
        provider={provider}
        onDone={(model) => choices.push(model)}
        onCancel={() => {}}
      />
    </AppStateProvider>,
  )
  return {
    text: () => frameText(latest),
    stdin,
    choices,
    configDir,
    close() {
      ink.unmount()
      stdin.destroy()
      if (previousDir === undefined) delete process.env.ZY_CONFIG_DIR
      else process.env.ZY_CONFIG_DIR = previousDir
      resetSettingsCache()
      rmSync(configDir, { recursive: true, force: true })
    },
  }
}

async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error('模型选择器没有完成预期更新')
}

describe('ProviderModelPicker', () => {
  test('连接能力编辑可保存思考强度映射，不接受未映射的具体强度', async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ data: [{ id: 'custom-thinking-model' }] })),
    ) as unknown as typeof fetch
    const picker = await mountPicker()
    try {
      await waitUntil(() => picker.text().includes('custom-thinking-model'))
      await Bun.sleep(20)
      picker.stdin.write('1')
      await waitUntil(() => picker.text().includes(tSync('modelCapability.useModel')))
      await Bun.sleep(20)
      picker.stdin.write('7')
      await waitUntil(() => picker.text().includes(tSync('modelCapability.effortJson')))
      await Bun.sleep(20)
      picker.stdin.write('\t')
      await Bun.sleep(20)
      picker.stdin.write('\x01')
      await Bun.sleep(20)
      picker.stdin.write('\x0b')
      await Bun.sleep(20)
      picker.stdin.write('["balanced"]')
      await Bun.sleep(20)
      picker.stdin.write('\r')
      await waitUntil(() =>
        picker
          .text()
          .replace(/\s/g, '')
          .includes(tSync('modelCapability.invalidMapping').replace(/\s/g, '')),
      )
      picker.stdin.write('\x01')
      await Bun.sleep(20)
      picker.stdin.write('\x0b')
      await Bun.sleep(20)
      picker.stdin.write(
        '{"levels":["off","light","balanced"],"map":{"light":"low","balanced":"medium"}}',
      )
      await Bun.sleep(20)
      picker.stdin.write('\r')
      await waitUntil(() => picker.text().includes(tSync('modelCapability.useModel')))
      await Bun.sleep(20)
      picker.stdin.write('1')
      await waitUntil(() => picker.choices.length > 0)
      const context = {
        provider: 'ant-ling',
        connectionId: 'ant-ling',
        apiFormat: 'openai-chat' as const,
      }
      expect(getLocalModelEffortLevels('custom-thinking-model', context)).toEqual([
        'off',
        'light',
        'balanced',
      ])
      expect(getLocalModelEffortMap('custom-thinking-model', context)).toEqual({
        light: 'low',
        balanced: 'medium',
      })
    } finally {
      picker.close()
    }
  })
  test('跨平台目录的 image 输入在能力编辑界面显示支持，缺失输入仍显示未知', async () => {
    let input: string[] | undefined = ['text', 'image', 'pdf']
    globalThis.fetch = mock(
      async (url: string | URL | Request) =>
        new Response(
          JSON.stringify(
            String(url).includes('models.dev')
              ? {
                  anthropic: {
                    models: {
                      'claude-sonnet-5-5': {
                        id: 'claude-sonnet-5-5',
                        modalities: { input },
                        reasoning: true,
                        limit: { context: 1000000, output: 128000 },
                      },
                    },
                  },
                }
              : { data: [{ id: 'claude-sonnet-5-5' }] },
          ),
        ),
    ) as unknown as typeof fetch
    for (const expected of ['supported', 'unknown'] as const) {
      const picker = await mountPicker('private', 'openai', true)
      try {
        await waitUntil(() => picker.text().includes('claude-sonnet-5-5'))
        await Bun.sleep(20)
        picker.stdin.write('1')
        await waitUntil(() => picker.text().includes(tSync('modelCapability.useModel')))
        const imageLine = picker
          .text()
          .split('\n')
          .find((line) => line.includes(tSync('modelCapability.image')))
        expect(imageLine).toContain(tSync(`modelCapability.${expected}`))
      } finally {
        picker.close()
      }
      input = undefined
    }
  })
  test('百炼 K3 公共目录超时后显示原因，图片输入保持未知而不是错误宣称不支持', async () => {
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      if (String(url).includes('models.dev')) {
        throw new DOMException('timeout', 'TimeoutError')
      }
      return new Response(JSON.stringify({ data: [{ id: 'kimi-k3' }] }))
    }) as unknown as typeof fetch
    const picker = await mountPicker('dashscope', 'dashscope', true)
    try {
      await waitUntil(() => picker.text().includes('kimi-k3'))
      await Bun.sleep(20)
      picker.stdin.write('1')
      await waitUntil(() => picker.text().includes(tSync('modelCapability.useModel')))
      expect(picker.text().replace(/\s+/g, ' ')).toContain(
        tSync('modelCapability.catalogIssue.timeout'),
      )
      const imageLine = picker
        .text()
        .split('\n')
        .find((line) => line.includes(tSync('modelCapability.image')))
      expect(imageLine).toContain(tSync('modelCapability.unknown'))
    } finally {
      picker.close()
    }
  })
  test('官方列表仅给 ID 时，动态公共目录补齐能力后可直接选中', async () => {
    globalThis.fetch = mock(
      async (url: string | URL | Request) =>
        new Response(
          JSON.stringify(
            String(url).includes('models.dev')
              ? {
                  openai: {
                    models: {
                      'new-api-model': {
                        id: 'new-api-model',
                        reasoning: true,
                        structured_output: false,
                        modalities: { input: ['text', 'image'] },
                        limit: { context: 128000, output: 8000 },
                      },
                    },
                  },
                }
              : { data: [{ id: 'new-api-model' }] },
          ),
        ),
    ) as unknown as typeof fetch
    const picker = await mountPicker('openai-personal', 'openai', true)
    try {
      await waitUntil(() => picker.text().includes('new-api-model'))
      await Bun.sleep(20)
      picker.stdin.write('1')
      await waitUntil(() => picker.choices.length > 0)
      const context = {
        provider: 'openai',
        connectionId: 'openai-personal',
        apiFormat: 'openai-chat' as const,
      }
      expect(getLocalContextWindow('new-api-model', context)).toBe(128000)
      expect(getLocalModelInputModalities('new-api-model', context)).toEqual(['text', 'image'])
    } finally {
      picker.close()
    }
  })

  test('未收录的模型可在界面补充能力，保存后不需要手工能力文件', async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ data: [{ id: 'private-model' }] })),
    ) as unknown as typeof fetch
    const picker = await mountPicker()
    try {
      await waitUntil(() => picker.text().includes('private-model'))
      await Bun.sleep(20)
      picker.stdin.write('1')
      await waitUntil(() => picker.text().includes(tSync('modelCapability.useModel')))
      await Bun.sleep(20)
      picker.stdin.write('2')
      await waitUntil(() => picker.text().includes(tSync('modelCapability.followSource')))
      await Bun.sleep(20)
      picker.stdin.write('1')
      await waitUntil(() => picker.text().includes(tSync('modelCapability.useModel')))
      await Bun.sleep(20)
      picker.stdin.write('3')
      await waitUntil(() => picker.text().includes(tSync('modelCapability.followSource')))
      await Bun.sleep(20)
      picker.stdin.write('2')
      await waitUntil(() => picker.text().includes(tSync('modelCapability.useModel')))
      await Bun.sleep(20)
      picker.stdin.write('5')
      await waitUntil(() => picker.text().includes(tSync('modelCapability.numberHint')))
      await Bun.sleep(20)
      picker.stdin.write('131072')
      await Bun.sleep(20)
      picker.stdin.write('\r')
      await waitUntil(() => picker.text().includes(tSync('modelCapability.useModel')))
      await Bun.sleep(20)
      picker.stdin.write('1')
      await waitUntil(() => picker.choices.length > 0)
      const context = {
        provider: 'ant-ling',
        connectionId: 'ant-ling',
        apiFormat: 'openai-chat' as const,
      }
      expect(getLocalModelInputModalities('private-model', context)).toEqual(['text', 'image'])
      expect(getLocalModelEffortLevels('private-model', context)).toEqual(['off'])
      expect(getLocalContextWindow('private-model', context)).toBe(131072)
    } finally {
      picker.close()
    }
  })

  test('选择新模型后保留平台元数据，缺少手工配置也能识别图片和上下文', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'doubao-seed-2-1-pro-260915',
                modalities: { input_modalities: ['text', 'image', 'video'] },
                token_limits: { context_window: 1048576, max_reasoning_token_length: 262144 },
              },
            ],
          }),
        ),
    ) as unknown as typeof fetch
    const picker = await mountPicker('ark-personal', 'ark')
    try {
      await waitUntil(() => picker.text().includes('doubao-seed-2-1-pro-260915'))
      await Bun.sleep(20)
      picker.stdin.write('1')
      await waitUntil(() => picker.text().includes(tSync('modelCapability.useModel')))
      await Bun.sleep(20)
      picker.stdin.write('1')
      await waitUntil(() => picker.choices.length > 0)
      const context = {
        provider: 'ark',
        connectionId: 'ark-personal',
        apiFormat: 'openai-chat' as const,
      }
      expect(getLocalContextWindow(picker.choices[0]!, context)).toBe(1048576)
      expect(getLocalModelInputModalities(picker.choices[0]!, context)).toEqual(['text', 'image'])
    } finally {
      picker.close()
    }
  })

  test('只有模型名称时提示能力未确认，元数据写入失败不会报告选择成功', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: 'unknown-model' },
              {
                id: 'known-model',
                modalities: { input_modalities: ['text'] },
                token_limits: { context_window: 32000 },
              },
            ],
          }),
        ),
    ) as unknown as typeof fetch
    const picker = await mountPicker()
    try {
      await waitUntil(() => picker.text().includes('unknown-model'))
      expect(picker.text()).toContain(tSync('onboarding.models.capabilitiesIncomplete'))
      writeFileSync(join(picker.configDir, 'discovered-model-capabilities.json'), '{ broken')
      await Bun.sleep(20)
      picker.stdin.write('2')
      await waitUntil(() => picker.text().includes(tSync('modelCapability.useModel')))
      await Bun.sleep(20)
      picker.stdin.write('1')
      await waitUntil(() => picker.text().includes(tSync('onboarding.models.capabilitySaveFailed')))
      expect(picker.choices).toEqual([])
    } finally {
      picker.close()
    }
  })

  test('展示实时模型并在重新打开后移除下线模型', async () => {
    let calls = 0
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            data:
              calls++ === 0
                ? [{ id: 'live-old-model' }, { id: 'Ling-3.1-flash' }]
                : [{ id: 'Ling-3.1-flash' }],
          }),
        ),
    ) as unknown as typeof fetch
    const first = await mountPicker()
    try {
      await waitUntil(() => first.text().includes('live-old-model'))
      expect(first.text()).toContain('Ling-3.1-flash')
      expect(first.text()).not.toContain('Ling-2.6-1T')
    } finally {
      first.close()
    }
    const second = await mountPicker()
    try {
      await waitUntil(() => second.text().includes('Ling-3.1-flash'))
      expect(second.text()).not.toContain('live-old-model')
      expect(calls).toBe(2)
    } finally {
      second.close()
    }
  })

  test('认证失败显示原因，刷新读取命名连接的新凭证并选中模型', async () => {
    const keys: string[] = []
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get('Authorization') ?? '')
      return keys.length === 1
        ? new Response('{}', { status: 401 })
        : new Response(JSON.stringify({ data: [{ id: 'Ling-3.1-flash' }] }))
    }) as unknown as typeof fetch
    const picker = await mountPicker('ling-personal')
    try {
      await waitUntil(() => picker.text().includes(tSync('onboarding.models.authentication')))
      expect(picker.text()).toContain(tSync('onboarding.models.refresh'))
      writeFileSync(
        join(picker.configDir, 'auth.json'),
        JSON.stringify({
          'ling-personal': { provider: 'ant-ling', apiKey: 'new-key', apiFormat: 'openai-chat' },
        }),
      )
      picker.stdin.write('2')
      await waitUntil(() => picker.text().includes('Ling-3.1-flash'))
      expect(keys).toEqual(['Bearer old-key', 'Bearer new-key'])
      // 目录变化会重建 Select；等待新控件的输入监听器挂载后再模拟按键。
      await Bun.sleep(20)
      picker.stdin.write('1')
      await waitUntil(() => picker.text().includes(tSync('modelCapability.useModel')))
      await Bun.sleep(20)
      picker.stdin.write('1')
      await waitUntil(() => picker.choices.length > 0)
      expect(picker.choices).toEqual(['Ling-3.1-flash'])
    } finally {
      picker.close()
    }
  })
})
