import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

describe('apiHelpers.configureEffortParams', () => {
  test('跨 provider 候选的六档思考强度映射进入 OpenRouter 请求体', () => {
    const model = 'stealth/space-bunny-alpha'
    const configDir = mkdtempSync(join(tmpdir(), 'zy-api-effort-'))
    const projectRoot = join(import.meta.dir, '..', '..', '..')

    try {
      writeFileSync(
        join(configDir, 'settings.json'),
        JSON.stringify({
          provider: 'mimo',
          mainLoopModel: 'standard',
          models: {
            standard: [
              { provider: 'mimo', model: 'mimo-v2-flash' },
              { provider: 'openrouter', model },
            ],
          },
        }),
      )
      writeFileSync(
        join(configDir, 'model-capabilities.json'),
        JSON.stringify({
          models: [
            {
              pattern: model,
              provider: 'openrouter',
              apiFormat: 'openai-chat',
              capabilities: {
                thinking: {
                  effort: {
                    levels: ['on', 'quick', 'light', 'balanced', 'thorough', 'extreme'],
                    map: {
                      on: 'max',
                      quick: 'low',
                      light: 'medium',
                      balanced: 'high',
                      thorough: 'xhigh',
                      extreme: 'max',
                    },
                  },
                },
              },
            },
          ],
        }),
      )

      // 应用模块及其全局缓存只在子进程加载，避免其它测试的 mock 污染路由结果。
      const moduleUrl = (path: string) => pathToFileURL(join(projectRoot, path)).href
      const childScript = `
        const { configureEffortParams } = await import(${JSON.stringify(moduleUrl('src/services/api/apiHelpers.ts'))})
        const { buildOpenAIRequestParams } = await import(${JSON.stringify(moduleUrl('src/services/api/conversions/openai.ts'))})
        const { getProviderForModel } = await import(${JSON.stringify(moduleUrl('src/services/model/model.ts'))})
        const { getAPIProvider } = await import(${JSON.stringify(moduleUrl('src/services/model/providers.ts'))})
        const model = ${JSON.stringify(model)}
        const levels = ['on', 'quick', 'light', 'balanced', 'thorough', 'extreme']
        const results = levels.map((level) => {
          const outputConfig = {}
          configureEffortParams(level, outputConfig, {}, [], model)
          const request = buildOpenAIRequestParams({
            model,
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
            maxTokens: 100,
            thinking: { type: 'enabled', budgetTokens: 64 },
            reasoningEffort: outputConfig.effort,
          })
          return { level, mapped: outputConfig.effort ?? null, reasoning: request.reasoning ?? null }
        })
        process.stdout.write('ZY_EFFORT_RESULT:' + JSON.stringify({
          globalProvider: getAPIProvider(),
          targetProvider: getProviderForModel(model),
          results,
        }))
      `
      const child = spawnSync(process.execPath, ['-e', childScript], {
        cwd: projectRoot,
        env: { ...process.env, ZY_CONFIG_DIR: configDir },
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
      })

      expect(child.error).toBeUndefined()
      expect(child.status).toBe(0)
      const marker = 'ZY_EFFORT_RESULT:'
      const markerIndex = child.stdout.lastIndexOf(marker)
      expect(markerIndex).toBeGreaterThanOrEqual(0)
      const result = JSON.parse(child.stdout.slice(markerIndex + marker.length))
      expect(result).toEqual({
        globalProvider: 'mimo',
        targetProvider: 'openrouter',
        results: [
          { level: 'on', mapped: 'max', reasoning: { effort: 'max' } },
          { level: 'quick', mapped: 'low', reasoning: { effort: 'low' } },
          { level: 'light', mapped: 'medium', reasoning: { effort: 'medium' } },
          { level: 'balanced', mapped: 'high', reasoning: { effort: 'high' } },
          { level: 'thorough', mapped: 'xhigh', reasoning: { effort: 'xhigh' } },
          { level: 'extreme', mapped: 'max', reasoning: { effort: 'max' } },
        ],
      })
    } finally {
      for (const name of ['settings.json', 'model-capabilities.json']) {
        const path = join(configDir, name)
        if (existsSync(path)) {
          unlinkSync(path)
        }
      }
      rmdirSync(configDir)
    }
  }, 45_000)
})
