/**
 * officialMarketplaceStartupCheck 测试：官方 marketplace 自动安装与恢复路径。
 *
 * 重点覆盖：
 *   - `isRetryBudgetExhausted`：MAX_ATTEMPTS 边界与 autoInstalled 短路
 *   - 预算耗尽后的 GCS-only 恢复路径：成功安装、失败静默、policy/env 短路
 *   - 主路径保持既有语义：首次 GCS 成功、GCS 失败回退 git、flag 关闭时
 *     累加 retryCount 并记录 nextRetryTime
 *
 * 通过 mock.module 隔离 IO 依赖（config/marketplace/GCS/git/analytics），
 * 用可变闭包状态切换场景。
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
// Bun 的 mock.module factory 内不能 import 被 mock 的目标模块（返回空对象，
// 透传失效甚至卡死加载链），真实导出必须在 factory 外顶层加载。
import * as configActual from '../../../src/services/config/config.js'
import * as marketplaceManagerActual from '../../../src/services/plugins/marketplaceManager.js'
import * as officialMarketplaceGcsActual from '../../../src/services/plugins/officialMarketplaceGcs.js'
import * as gitAvailabilityActual from '../../../src/services/plugins/gitAvailability.js'
import * as marketplaceHelpersActual from '../../../src/services/plugins/marketplaceHelpers.js'
import * as analyticsActual from '../../../src/services/analytics/index.js'
import * as growthbookActual from '../../../src/services/analytics/growthbook.js'
// biome-ignore lint/suspicious/noExplicitAny: 测试用宽松 config 对象
type AnyConfig = any
// biome-ignore lint/suspicious/noExplicitAny: 测试用宽松 known_marketplaces 结构
type AnyMarketplaces = Record<string, any>

// —— 可变测试状态 ——
let currentGlobalConfig: AnyConfig = {}
let knownMarketplaces: AnyMarketplaces = {}
let gcsResult: string | null = 'test-sha'
let gitAvailable = true
let policyAllowed = true
let featureGitFallback = true
let lastAddMarketplaceSourceCalls = 0

// env 变量名与 src/services/plugins/officialMarketplaceStartupCheck.ts 一致
const ENV_DISABLE_KEY = 'ZY_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL'

// —— 隔离 IO 依赖 ——
// mock.module 是进程级全局替换且 mock.restore() 不撤销它：此前窄面 mock
// （config 只给 getGlobalConfig/saveGlobalConfig、marketplaceHelpers 只给一个
// 导出等）丢失其余导出（如 withApprovedFingerprint），泄漏给同 worker 后续文件
// 报 "Export named ... not found"。统一改为真实快照 spread + 仅覆盖所需导出；
// fake 只在测试体内登记，afterEach 恢复真实快照、afterAll 兜底。
const MOCK_PATHS = {
  config: '../../../src/services/config/config.js',
  marketplaceManager: '../../../src/services/plugins/marketplaceManager.js',
  officialMarketplaceGcs: '../../../src/services/plugins/officialMarketplaceGcs.js',
  gitAvailability: '../../../src/services/plugins/gitAvailability.js',
  marketplaceHelpers: '../../../src/services/plugins/marketplaceHelpers.js',
  analytics: '../../../src/services/analytics/index.js',
  growthbook: '../../../src/services/analytics/growthbook.js',
} as const

const mockLogEvent = mock(() => {})
const mockAddMarketplaceSource = mock(async () => {
  lastAddMarketplaceSourceCalls++
})

function registerMocks() {
  mock.module(MOCK_PATHS.config, () => ({
    ...configActual,
    getGlobalConfig: () => currentGlobalConfig,
    saveGlobalConfig: (fn: (c: AnyConfig) => AnyConfig) => {
      currentGlobalConfig = fn(currentGlobalConfig)
    },
  }))

  mock.module(MOCK_PATHS.marketplaceManager, () => ({
    ...marketplaceManagerActual,
    addMarketplaceSource: mockAddMarketplaceSource,
    getMarketplacesCacheDir: () => '/fake/cache',
    loadKnownMarketplacesConfig: async () => knownMarketplaces,
    saveKnownMarketplacesConfig: async (cfg: AnyMarketplaces) => {
      knownMarketplaces = cfg
    },
  }))

  mock.module(MOCK_PATHS.officialMarketplaceGcs, () => ({
    ...officialMarketplaceGcsActual,
    fetchOfficialMarketplaceFromGcs: async () => gcsResult,
  }))

  mock.module(MOCK_PATHS.gitAvailability, () => ({
    ...gitAvailabilityActual,
    checkGitAvailable: async () => gitAvailable,
    markGitUnavailable: () => {},
  }))

  mock.module(MOCK_PATHS.marketplaceHelpers, () => ({
    ...marketplaceHelpersActual,
    isSourceAllowedByPolicy: () => policyAllowed,
  }))

  mock.module(MOCK_PATHS.analytics, () => ({
    ...analyticsActual,
    logEvent: mockLogEvent,
  }))

  mock.module(MOCK_PATHS.growthbook, () => ({
    ...growthbookActual,
    getFeatureValue_CACHED_MAY_BE_STALE: () => featureGitFallback,
  }))
}

function restoreRealModules() {
  mock.module(MOCK_PATHS.config, () => ({ ...configActual }))
  mock.module(MOCK_PATHS.marketplaceManager, () => ({ ...marketplaceManagerActual }))
  mock.module(MOCK_PATHS.officialMarketplaceGcs, () => ({ ...officialMarketplaceGcsActual }))
  mock.module(MOCK_PATHS.gitAvailability, () => ({ ...gitAvailabilityActual }))
  mock.module(MOCK_PATHS.marketplaceHelpers, () => ({ ...marketplaceHelpersActual }))
  mock.module(MOCK_PATHS.analytics, () => ({ ...analyticsActual }))
  mock.module(MOCK_PATHS.growthbook, () => ({ ...growthbookActual }))
}

// envUtils 不 mock（避免全模块替换破坏其它 consumer 的 named import）；
// 直接通过真实 env 变量驱动 isOfficialMarketplaceAutoInstallDisabled()

// 在 mock.module 就位之后再导入被测模块
const {
  checkAndInstallOfficialMarketplace,
  isRetryBudgetExhausted,
  RETRY_CONFIG,
  // biome-ignore lint/suspicious/noExplicitAny: 由上方 mock 保证形状
} = await import('../../../src/services/plugins/officialMarketplaceStartupCheck.js')

const MKT_NAME = 'claude-plugins-official'

function exhaustedConfig(overrides: AnyConfig = {}): AnyConfig {
  return {
    officialMarketplaceAutoInstallAttempted: true,
    officialMarketplaceAutoInstalled: false,
    officialMarketplaceAutoInstallFailReason: 'unknown',
    officialMarketplaceAutoInstallRetryCount: RETRY_CONFIG.MAX_ATTEMPTS,
    ...overrides,
  }
}

beforeEach(() => {
  registerMocks()
})

afterEach(() => {
  mock.restore()
  restoreRealModules()
})

afterAll(() => {
  restoreRealModules()
})

describe('isRetryBudgetExhausted', () => {
  test('retryCount 达到 MAX_ATTEMPTS 且未安装 → 视为耗尽', () => {
    expect(
      isRetryBudgetExhausted({
        officialMarketplaceAutoInstallRetryCount: RETRY_CONFIG.MAX_ATTEMPTS,
      }),
    ).toBe(true)
  })

  test('retryCount 未达 MAX_ATTEMPTS → 未耗尽', () => {
    expect(
      isRetryBudgetExhausted({
        officialMarketplaceAutoInstallRetryCount: RETRY_CONFIG.MAX_ATTEMPTS - 1,
      }),
    ).toBe(false)
  })

  test('autoInstalled 已标记 → 不视为耗尽（即便计数封顶）', () => {
    expect(
      isRetryBudgetExhausted({
        officialMarketplaceAutoInstalled: true,
        officialMarketplaceAutoInstallRetryCount: RETRY_CONFIG.MAX_ATTEMPTS + 5,
      }),
    ).toBe(false)
  })
})

describe('recovery path: 预算耗尽后走 GCS-only 恢复', () => {
  beforeEach(() => {
    currentGlobalConfig = {}
    knownMarketplaces = {}
    gcsResult = 'test-sha'
    gitAvailable = true
    policyAllowed = true
    delete process.env[ENV_DISABLE_KEY]
    featureGitFallback = true
    lastAddMarketplaceSourceCalls = 0
  })

  test('耗尽 + GCS 可用 → 自动恢复安装、清空重试元数据、不动 git 计数', async () => {
    currentGlobalConfig = exhaustedConfig()
    gcsResult = 'new-sha'

    const result = await checkAndInstallOfficialMarketplace()

    expect(result.installed).toBe(true)
    expect(result.skipped).toBe(false)
    expect(currentGlobalConfig.officialMarketplaceAutoInstalled).toBe(true)
    expect(currentGlobalConfig.officialMarketplaceAutoInstallRetryCount).toBeUndefined()
    expect(currentGlobalConfig.officialMarketplaceAutoInstallFailReason).toBeUndefined()
    expect(currentGlobalConfig.officialMarketplaceAutoInstallNextRetryTime).toBeUndefined()
    expect(knownMarketplaces[MKT_NAME]).toBeDefined()
    // git 回退路径不应被触发
    expect(lastAddMarketplaceSourceCalls).toBe(0)
  })

  test('耗尽 + GCS 失败 → 返回 gcs_unavailable，不累加 retryCount', async () => {
    const initialRetryCount = RETRY_CONFIG.MAX_ATTEMPTS
    currentGlobalConfig = exhaustedConfig({
      officialMarketplaceAutoInstallRetryCount: initialRetryCount,
    })
    gcsResult = null

    const result = await checkAndInstallOfficialMarketplace()

    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('gcs_unavailable')
    // 保持静默：计数不增、状态字段不变、不写入 failReason=unknown
    expect(currentGlobalConfig.officialMarketplaceAutoInstallRetryCount).toBe(initialRetryCount)
    expect(currentGlobalConfig.officialMarketplaceAutoInstallFailReason).toBe('unknown')
    expect(currentGlobalConfig.officialMarketplaceAutoInstalled).toBe(false)
  })

  test('耗尽 + policy_blocked → 不尝试 GCS 恢复', async () => {
    currentGlobalConfig = exhaustedConfig({
      officialMarketplaceAutoInstallFailReason: 'policy_blocked',
    })
    gcsResult = 'test-sha'

    const result = await checkAndInstallOfficialMarketplace()

    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('policy_blocked')
    // GCS 未被调用 → known_marketplaces 仍空
    expect(knownMarketplaces[MKT_NAME]).toBeUndefined()
  })

  test('耗尽 + 已注册（用户手动 add 过）→ 标记 installed 但不重新拉取', async () => {
    currentGlobalConfig = exhaustedConfig()
    knownMarketplaces = {
      [MKT_NAME]: {
        source: { source: 'github', repo: 'anthropics/claude-plugins-official' },
        installLocation: '/fake/cache/claude-plugins-official',
        lastUpdated: '2026-01-01T00:00:00.000Z',
      },
    }
    // 若被调用会失败；预期不应被调用
    gcsResult = null

    const result = await checkAndInstallOfficialMarketplace()

    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('already_installed')
    expect(currentGlobalConfig.officialMarketplaceAutoInstalled).toBe(true)
    expect(currentGlobalConfig.officialMarketplaceAutoInstallRetryCount).toBeUndefined()
  })

  test('耗尽 + env kill switch → 静默 policy_blocked，不改计数', async () => {
    currentGlobalConfig = exhaustedConfig()
    process.env[ENV_DISABLE_KEY] = '1'

    const result = await checkAndInstallOfficialMarketplace()

    expect(result.reason).toBe('policy_blocked')
    expect(currentGlobalConfig.officialMarketplaceAutoInstalled).toBe(false)
    expect(currentGlobalConfig.officialMarketplaceAutoInstallFailReason).toBe('policy_blocked')
    // 恢复路径不递增计数
    expect(currentGlobalConfig.officialMarketplaceAutoInstallRetryCount).toBe(
      RETRY_CONFIG.MAX_ATTEMPTS,
    )
  })

  test('耗尽 + 企业策略关闭 → 静默 policy_blocked', async () => {
    currentGlobalConfig = exhaustedConfig()
    policyAllowed = false
    gcsResult = 'test-sha'

    const result = await checkAndInstallOfficialMarketplace()

    expect(result.reason).toBe('policy_blocked')
    expect(knownMarketplaces[MKT_NAME]).toBeUndefined()
    expect(currentGlobalConfig.officialMarketplaceAutoInstalled).toBe(false)
  })

  test('耗尽 + git_unavailable 历史 → GCS 恢复成功可覆盖 git 缺失', async () => {
    currentGlobalConfig = exhaustedConfig({
      officialMarketplaceAutoInstallFailReason: 'git_unavailable',
    })
    // git 不可用不影响 GCS 恢复
    gitAvailable = false
    gcsResult = 'recovered-sha'

    const result = await checkAndInstallOfficialMarketplace()

    expect(result.installed).toBe(true)
    expect(currentGlobalConfig.officialMarketplaceAutoInstalled).toBe(true)
  })
})

describe('main path (未耗尽)：保持既有语义', () => {
  beforeEach(() => {
    currentGlobalConfig = {}
    knownMarketplaces = {}
    gcsResult = 'test-sha'
    gitAvailable = true
    policyAllowed = true
    delete process.env[ENV_DISABLE_KEY]
    featureGitFallback = true
    lastAddMarketplaceSourceCalls = 0
  })

  test('首次尝试 GCS 成功 → 安装并清空元数据', async () => {
    gcsResult = 'fresh-sha'

    const result = await checkAndInstallOfficialMarketplace()

    expect(result.installed).toBe(true)
    expect(currentGlobalConfig.officialMarketplaceAutoInstalled).toBe(true)
    expect(knownMarketplaces[MKT_NAME]).toBeDefined()
    // 未回退 git
    expect(lastAddMarketplaceSourceCalls).toBe(0)
  })

  test('GCS 失败 + git 可用 → 回退 git 安装', async () => {
    gcsResult = null
    gitAvailable = true

    const result = await checkAndInstallOfficialMarketplace()

    expect(result.installed).toBe(true)
    expect(lastAddMarketplaceSourceCalls).toBe(1)
    expect(currentGlobalConfig.officialMarketplaceAutoInstalled).toBe(true)
    expect(currentGlobalConfig.officialMarketplaceAutoInstallRetryCount).toBeUndefined()
  })

  test('GCS 失败 + git fallback flag 关闭 → gcs_unavailable 且 retryCount 累加', async () => {
    gcsResult = null
    featureGitFallback = false

    const result = await checkAndInstallOfficialMarketplace()

    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('gcs_unavailable')
    expect(currentGlobalConfig.officialMarketplaceAutoInstallRetryCount).toBe(1)
    expect(currentGlobalConfig.officialMarketplaceAutoInstallNextRetryTime).toBeGreaterThan(0)
  })

  test('未耗尽 + reason=gcs_unavailable + nextRetryTime 未到 → 静默跳过', async () => {
    currentGlobalConfig = {
      officialMarketplaceAutoInstallAttempted: true,
      officialMarketplaceAutoInstalled: false,
      officialMarketplaceAutoInstallFailReason: 'gcs_unavailable',
      officialMarketplaceAutoInstallRetryCount: 2,
      officialMarketplaceAutoInstallNextRetryTime: Date.now() + 60_000,
    }
    gcsResult = 'test-sha'

    const result = await checkAndInstallOfficialMarketplace()

    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('gcs_unavailable')
    // 未触发实际拉取
    expect(knownMarketplaces[MKT_NAME]).toBeUndefined()
  })

  test('未耗尽 + reason=unknown + 计数 < MAX → 走 GCS 尝试', async () => {
    currentGlobalConfig = {
      officialMarketplaceAutoInstallAttempted: true,
      officialMarketplaceAutoInstalled: false,
      officialMarketplaceAutoInstallFailReason: 'unknown',
      officialMarketplaceAutoInstallRetryCount: 3,
    }
    gcsResult = 'retry-sha'

    const result = await checkAndInstallOfficialMarketplace()

    expect(result.installed).toBe(true)
    expect(currentGlobalConfig.officialMarketplaceAutoInstalled).toBe(true)
  })

  test('已注册（known_marketplaces）→ 主路径 already_installed 也清 retry 元数据', async () => {
    // 模拟用户手动添加过 marketplace 后配置里仍留有旧的 failReason 场景
    currentGlobalConfig = {
      officialMarketplaceAutoInstallAttempted: true,
      officialMarketplaceAutoInstalled: false,
      officialMarketplaceAutoInstallFailReason: 'unknown',
      officialMarketplaceAutoInstallRetryCount: 5,
    }
    knownMarketplaces = {
      [MKT_NAME]: {
        source: { source: 'github', repo: 'anthropics/claude-plugins-official' },
        installLocation: '/fake/cache/claude-plugins-official',
        lastUpdated: '2026-01-01T00:00:00.000Z',
      },
    }

    const result = await checkAndInstallOfficialMarketplace()

    expect(result.reason).toBe('already_installed')
    expect(currentGlobalConfig.officialMarketplaceAutoInstalled).toBe(true)
    // 关键：markAutoInstalledSuccess 会清 failReason/retryCount，
    // 否则下次启动因 reason 仍是 'unknown' 会误触发“安装失败”通知
    expect(currentGlobalConfig.officialMarketplaceAutoInstallFailReason).toBeUndefined()
    expect(currentGlobalConfig.officialMarketplaceAutoInstallRetryCount).toBeUndefined()
  })
})
