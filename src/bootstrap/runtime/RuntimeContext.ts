/**
 * RuntimeContext — 运行时上下文接口。
 *
 * 规划目标：替代 src/bootstrap/state.ts 大 barrel，提供最小接口集合。
 *
 * 当前实现通过 STATE 单例委派，后续逐步拆为独立领域模块。
 *
 * 使用原则：
 * - 服务构造函数或执行函数显式接收所需接口
 * - 禁止服务直接导入 bootstrap/state.ts 大 barrel
 * - 组件通过 selector/context 获取状态，不直接读取 RuntimeContext
 *
 * @see docs/architecture.md — 状态管理三层分离
 */

import { STATE } from '../state/_core.js'

// ============================================================================
// 接口定义 — 规划目标：替代 bootstrap/state.ts 大 barrel
// ============================================================================

/** Session Identity */
export interface SessionIdentity {
  readonly sessionId: string
  readonly projectRoot: string
  readonly cwd: string
}

/** 模型运行时信息（规划中） */
export interface ModelRuntime {
  readonly model: string
}

/** 遥测 */
export interface TelemetryContext {
  readonly sessionId: string
}

/** 功能开关 */
export interface FeatureAccess {
  isEnabled(flag: string): boolean
}

/** 运行时时钟 */
export interface RuntimeClock {
  now(): Date
  timestamp(): number
}

// ============================================================================
// 完整 RuntimeContext 接口 — 后续按领域扩展
// ============================================================================

export interface RuntimeContext {
  readonly identity: SessionIdentity
  readonly model: ModelRuntime
  readonly telemetry: TelemetryContext
  readonly features: FeatureAccess
  readonly clock: RuntimeClock
}

// ============================================================================
// 当前实现（通过 STATE 单例委派，过渡期用）
// ============================================================================

function getSessionIdentity(): SessionIdentity {
  return {
    sessionId: STATE.sessionId,
    projectRoot: STATE.projectRoot ?? '',
    cwd: STATE.cwd ?? '',
  }
}

function getModelRuntime(): ModelRuntime {
  return {
    model: STATE.modelStrings?.mainModel ?? '',
  }
}

function getTelemetry(): TelemetryContext {
  return {
    sessionId: STATE.sessionId,
  }
}

function isFeatureEnabled(flag: string): boolean {
  try {
    const fn = (globalThis as { feature?: (flag: string) => boolean }).feature
    if (typeof fn === 'function') return fn(flag)
  } catch {
    // feature() not available
  }
  return false
}

function getRuntimeClock(): RuntimeClock {
  return {
    now: () => new Date(),
    timestamp: () => Date.now(),
  }
}

// ============================================================================
// 默认实例
// ============================================================================

let _instance: RuntimeContext | null = null

export function getRuntimeContext(): RuntimeContext {
  if (!_instance) {
    _instance = {
      identity: getSessionIdentity(),
      model: getModelRuntime(),
      telemetry: getTelemetry(),
      features: { isEnabled: isFeatureEnabled },
      clock: getRuntimeClock(),
    }
  }
  return _instance
}

/** 测试用：重置上下文 */
export function resetRuntimeContextForTest(): void {
  _instance = null
}
