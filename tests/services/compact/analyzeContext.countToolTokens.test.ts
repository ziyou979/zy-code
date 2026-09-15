/**
 * countToolDefinitionTokens 的回退估算行为：服务端 countTokens 不可用
 * （返回 null，如 Code Assist 拒绝为含 tools 的请求计数）时，应回退
 * 逐 schema 的本地粗估而非归零。
 *
 * mock 面收窄到两个直接依赖（tokenEstimation 的 API 计数入口、api.js 的
 * toolToAPISchema），spread-real + afterAll 恢复，避免跨文件泄漏。
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'

const tokenEstimationPath = '../../../src/services/tokenEstimation.js'
const apiPath = '../../../src/services/api/api.js'
const slowOpsPath = '../../../src/services/infra/slowOperations.js'

const realTe = await import(tokenEstimationPath)
const realApi = await import(apiPath)
const realSlow = await import(slowOpsPath)

mock.module(tokenEstimationPath, () => ({
  ...realTe,
  // 模拟服务端计数不可用：两次尝试（fallback 会重试一次）都返回 null。
  countMessagesTokensWithAPI: async () => null,
}))
mock.module(apiPath, () => ({
  ...realApi,
  // 固定 schema 输出，使期望值可逐字节推导。
  toolToAPISchema: async (tool: { name: string }) => ({
    name: tool.name,
    description: `${tool.name}-desc`,
  }),
}))

const { countToolDefinitionTokens } = await import(
  '../../../src/services/compact/analyzeContext.js'
)

afterAll(() => {
  mock.module(tokenEstimationPath, () => ({ ...realTe }))
  mock.module(apiPath, () => ({ ...realApi }))
})

type Args = Parameters<typeof countToolDefinitionTokens>
const fakePermissionCtx = (async () => ({})) as unknown as Args[1]

describe('countToolDefinitionTokens 回退估算', () => {
  test('服务端计数返回 null 时回退本地粗估而非归零', async () => {
    const tools = [{ name: 'alpha' }, { name: 'beta' }] as unknown as Args[0]
    const result = await countToolDefinitionTokens(tools, fakePermissionCtx, null)

    const expected =
      realTe.roughTokenCountEstimation(
        realSlow.jsonStringify({ name: 'alpha', description: 'alpha-desc' }),
      ) +
      realTe.roughTokenCountEstimation(
        realSlow.jsonStringify({ name: 'beta', description: 'beta-desc' }),
      )
    expect(result).toBe(expected)
    expect(result).toBeGreaterThan(0)
  })
})
