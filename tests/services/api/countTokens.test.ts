import { describe, expect, it, vi, beforeEach } from 'bun:test'
import { countTokensWithAdapter } from '../../../src/services/api/shared/countTokens.js'

const mockGetMainLoopModel = vi.fn(() => 'gpt-5[1m]')
const mockCountMessagesTokensLocally = vi.fn()

// 注意：normalizeModelStringForAPI 的 mock 实现必须与真实行为一致
//（去除 [1m]/[2m] 后缀）。bun 全量并行复用 worker 时 vi.mock 会跨文件
// 泄漏，若 mock 与真实实现偏离（如 toUpperCase）会污染同 worker 其他测试。
vi.mock('../../../src/services/model/model.js', () => ({
  getMainLoopModel: mockGetMainLoopModel,
  normalizeModelStringForAPI: (model: string) => model.replace(/\[(1|2)m\]/gi, ''),
}))

vi.mock('../../../src/services/tokenEstimation.js', () => ({
  countMessagesTokensLocally: mockCountMessagesTokensLocally,
}))

describe('countTokensWithAdapter - OpenAI 系共享计数', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMainLoopModel.mockReturnValue('gpt-5[1m]')
    mockCountMessagesTokensLocally.mockResolvedValue(1234)
  })

  const messages = [{ role: 'user', content: 'hello' }]
  const tools = [{ name: 'Bash', description: 'x' }]

  it('正常路径：模型去除 [1m] 后缀后委托 countMessagesTokensLocally', async () => {
    const result = await countTokensWithAdapter(messages as never, tools as never)
    expect(result).toBe(1234)
    expect(mockGetMainLoopModel).toHaveBeenCalled()
    expect(mockCountMessagesTokensLocally).toHaveBeenCalledWith(messages, tools, 'gpt-5')
  })

  it('countMessagesTokensLocally 抛异常时返回 null', async () => {
    mockCountMessagesTokensLocally.mockRejectedValue(new Error('tokenizer failed'))
    const result = await countTokensWithAdapter(messages as never, tools as never)
    expect(result).toBeNull()
  })

  it('抛异常时调用 logError 回调', async () => {
    mockCountMessagesTokensLocally.mockRejectedValue(new Error('tokenizer failed'))
    const logError = vi.fn()
    await countTokensWithAdapter(messages as never, tools as never, logError)
    expect(logError).toHaveBeenCalled()
  })

  it('未传 logError 时抛异常不崩溃', async () => {
    mockCountMessagesTokensLocally.mockRejectedValue(new Error('tokenizer failed'))
    await expect(countTokensWithAdapter(messages as never, tools as never)).resolves.toBeNull()
  })
})
