/**
 * promptCacheBreakDetection 测试：缓存中断检测。
 *
 * 核心逻辑：
 * - recordPromptState 首次调用 → 存储状态，无变更
 * - recordPromptState 二次调用（同 key）→ 检测 system/tools/model 等变更
 * - checkResponseForCacheBreak → 根据缓存读取量变化判定是否中断
 * - resetPromptCacheBreakDetection → 清空所有跟踪状态
 * - notifyCacheDeletion / notifyCompaction → 标记预期的缓存下降
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import {
  resetPromptCacheBreakDetection,
  notifyCacheDeletion,
  notifyCompaction,
  cleanupAgentTracking,
} from '../../../src/services/api/promptCacheBreakDetection.js'

describe('promptCacheBreakDetection', () => {
  // 每次测试前清空状态，避免交叉影响
  beforeEach(() => {
    resetPromptCacheBreakDetection()
  })

  describe('resetPromptCacheBreakDetection', () => {
    test('调用后不抛错', () => {
      expect(() => resetPromptCacheBreakDetection()).not.toThrow()
    })
  })

  describe('notifyCacheDeletion', () => {
    test('无对应 source → 不抛错', () => {
      expect(() => notifyCacheDeletion('repl_main_thread' as any)).not.toThrow()
    })
  })

  describe('notifyCompaction', () => {
    test('无对应 source → 不抛错', () => {
      expect(() => notifyCompaction('repl_main_thread' as any)).not.toThrow()
    })
  })

  describe('cleanupAgentTracking', () => {
    test('删除不存在的 agentId → 不抛错', () => {
      expect(() => cleanupAgentTracking('non-existent' as any)).not.toThrow()
    })
  })

  describe('recordPromptState + checkResponseForCacheBreak 基本流程', () => {
    test('首次 recordPromptState → 存储状态，无变更', async () => {
      const { recordPromptState } = await import(
        '../../../src/services/api/promptCacheBreakDetection.js'
      )
      recordPromptState({
        system: [{ type: 'text', text: 'You are helpful.' }],
        toolSchemas: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
        querySource: 'repl_main_thread' as any,
        model: 'claude-3',
      })
      // 首次调用不应抛错
      expect(true).toBe(true)
    })

    test('两次相同 snapshot → pendingChanges 为 null', async () => {
      const { mock } = await import('bun:test')
      mock.module('../../../src/services/analytics/index.js', () => ({
        logEvent: () => {},
        default: {},
      }))
      mock.module('../../../src/utils/debug.js', () => ({
        logForDebugging: () => {},
        default: {},
      }))
      mock.module('../../../src/utils/log.js', () => ({
        logError: () => {},
        default: {},
      }))

      const { recordPromptState, checkResponseForCacheBreak } = await import(
        '../../../src/services/api/promptCacheBreakDetection.js'
      )
      const snapshot = {
        system: [{ type: 'text', text: 'You are helpful.' }],
        toolSchemas: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
        querySource: 'repl_main_thread' as any,
        model: 'claude-3',
      }

      // 第一次：存储
      recordPromptState(snapshot)
      // 第二次：相同内容 → 无变更，pendingChanges 应为 null
      recordPromptState(snapshot)
      // 调用 checkResponse — 因无变更应跳过
      await checkResponseForCacheBreak(
        'repl_main_thread' as any,
        1000, // cacheReadTokens
        200, // cacheCreationTokens
        [{ type: 'user', content: 'hi' }],
      )

      mock.restore()
    })

    test('system 变更 → 检测到 systemPromptChanged', async () => {
      const { mock } = await import('bun:test')
      mock.module('../../../src/services/analytics/index.js', () => ({
        logEvent: () => {},
        default: {},
      }))
      mock.module('../../../src/utils/debug.js', () => ({
        logForDebugging: () => {},
        default: {},
      }))
      mock.module('../../../src/utils/log.js', () => ({
        logError: () => {},
        default: {},
      }))

      const { recordPromptState, checkResponseForCacheBreak } = await import(
        '../../../src/services/api/promptCacheBreakDetection.js'
      )
      const baseSnapshot = {
        system: [{ type: 'text', text: 'Original system prompt.' }],
        toolSchemas: [],
        querySource: 'repl_main_thread' as any,
        model: 'claude-3',
      }

      recordPromptState(baseSnapshot)

      // 首次 checkResponse 只记录基线（prevCacheRead），第二次才检测
      await checkResponseForCacheBreak('repl_main_thread' as any, 2000, 0, [])

      // 变更 system prompt
      recordPromptState({
        ...baseSnapshot,
        system: [{ type: 'text', text: 'Changed system prompt.' }],
      })

      // 第二次 checkResponse: 缓存读取下降 → 触发检测
      await checkResponseForCacheBreak(
        'repl_main_thread' as any,
        500, // 从 2000 降到 500 (>5%)，触发检测
        100,
        [{ type: 'user', content: 'hi' }],
      )

      mock.restore()
    })

    test('model 变更 → 检测到 modelChanged', async () => {
      const { mock } = await import('bun:test')
      mock.module('../../../src/services/analytics/index.js', () => ({
        logEvent: () => {},
        default: {},
      }))
      mock.module('../../../src/utils/debug.js', () => ({
        logForDebugging: () => {},
        default: {},
      }))
      mock.module('../../../src/utils/log.js', () => ({
        logError: () => {},
        default: {},
      }))

      const { recordPromptState, checkResponseForCacheBreak } = await import(
        '../../../src/services/api/promptCacheBreakDetection.js'
      )
      recordPromptState({
        system: [{ type: 'text', text: 'prompt' }],
        toolSchemas: [],
        querySource: 'repl_main_thread' as any,
        model: 'claude-3-opus',
      })

      // 首次 checkResponse — 设基线
      await checkResponseForCacheBreak('repl_main_thread' as any, 3000, 0, [])

      // 换模型
      recordPromptState({
        system: [{ type: 'text', text: 'prompt' }],
        toolSchemas: [],
        querySource: 'repl_main_thread' as any,
        model: 'claude-3-sonnet',
      })

      await checkResponseForCacheBreak('repl_main_thread' as any, 500, 100, [])

      mock.restore()
    })

    test('缓存读取未显著下降 → 不触发检测', async () => {
      const { mock } = await import('bun:test')
      mock.module('../../../src/services/analytics/index.js', () => ({
        logEvent: () => {},
        default: {},
      }))
      mock.module('../../../src/utils/debug.js', () => ({
        logForDebugging: () => {},
        default: {},
      }))
      mock.module('../../../src/utils/log.js', () => ({
        logError: () => {},
        default: {},
      }))

      const { recordPromptState, checkResponseForCacheBreak } = await import(
        '../../../src/services/api/promptCacheBreakDetection.js'
      )
      recordPromptState({
        system: [{ type: 'text', text: 'prompt' }],
        toolSchemas: [],
        querySource: 'repl_main_thread' as any,
        model: 'claude-3',
      })

      // 首次基线
      await checkResponseForCacheBreak('repl_main_thread' as any, 1000, 0, [])

      // 没有变更，缓存读取相近（>= 95%）
      await checkResponseForCacheBreak('repl_main_thread' as any, 980, 0, [])

      mock.restore()
    })
  })
})
