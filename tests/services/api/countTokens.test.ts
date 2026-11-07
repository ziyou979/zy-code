import { describe, expect, it, vi, beforeEach, afterEach, spyOn } from 'bun:test'
import { countTokensWithAdapter } from '../../../src/services/api/shared/countTokens.js'

import * as modelModule from '../../../src/services/model/model.js'
import * as tokenEstimation from '../../../src/services/tokenEstimation.js'

const mockGetMainLoopModel = vi.fn(() => 'gpt-5[1m]')
const mockCountMessagesTokensLocally = vi.fn()

// 使用可恢复的函数 spy，避免整模块替换泄漏到后续配置和安全测试。
afterEach(() => vi.restoreAllMocks())

describe('countTokensWithAdapter - OpenAI 系共享计数', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    spyOn(modelModule, 'getMainLoopModel').mockImplementation(mockGetMainLoopModel)
    spyOn(tokenEstimation, 'countMessagesTokensLocally').mockImplementation(
      mockCountMessagesTokensLocally,
    )
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
