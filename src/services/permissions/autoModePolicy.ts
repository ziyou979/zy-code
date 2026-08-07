/**
 * Auto 模式策略：门控检查、可用性判定、EnableState 读取。
 *
 * 从 permissionSetup.ts 提取。包含 auto 模式生命周期中与策略相关的
 * 纯逻辑——同步门控检查、熔断器状态、GrowthBook 配置读取。
 * 不含权限模式转换（见 permissionModeTransitions.ts）。
 */
import { setNeedsAutoModeExitAttachment } from '../../bootstrap/runtime/runtimeContext.js'
import {
  getInitialSettings,
  getUseAutoModeDuringPlan,
  hasAutoModeOptIn,
  hasTrustedDefaultModeAuto,
} from '../settings/settings.js'
import type { ToolPermissionContext } from '../../tools/tool.js'
import { isEnvTruthy, isInternalBuild } from '../../services/infra/envUtils.js'
import { getMainLoopModel } from 'src/services/model/model.js'
import { modelSupportsAutoMode } from '../feature-flags/betas.js'
import {
  getDynamicConfig_BLOCKS_ON_INIT,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from 'src/services/analytics/growthbook.js'
import { createDebugLog } from '../../services/infra/debug.js'
import { applyPermissionUpdate } from './permissionUpdate.ts'
import { restoreDangerousPermissions } from './dangerousPermissionRules.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = true
  ? (require('./autoModeState.js') as typeof import('./autoModeState.js'))
  : null

const permLog = createDebugLog('auto-mode-policy')

// ─── 类型 ───────────────────────────────────────────

export type AutoModeGateCheckResult = {
  /** 转换函数（而非预先计算的上下文），以便调用者可以将其应用于
   *  setAppState(prev => ...) 中的当前上下文。预先计算上下文会捕获
   *  过时的快照：异步 GrowthBook await 可能被轮次中的 shift-tab
   *  超越，返回 { ...currentContext, ... } 会覆盖用户的模式更改。 */
  updateContext: (ctx: ToolPermissionContext) => ToolPermissionContext
  notification?: string
}

export type AutoModeUnavailableReason = 'settings' | 'circuit-breaker' | 'model'

export type AutoModeEnabledState = 'enabled' | 'disabled' | 'opt-in'

// ─── 私有工具 ───────────────────────────────────────

const AUTO_MODE_ENABLED_DEFAULT: AutoModeEnabledState = 'enabled'

function parseAutoModeEnabledState(value: unknown): AutoModeEnabledState {
  if (value === 'enabled' || value === 'disabled' || value === 'opt-in') {
    return value
  }
  return AUTO_MODE_ENABLED_DEFAULT
}

function isAutoModeDisabledBySettings(): boolean {
  const settings = getInitialSettings() || {}
  return (
    (settings as { disableAutoMode?: 'disable' }).disableAutoMode === 'disable' ||
    (settings.permissions as { disableAutoMode?: 'disable' } | undefined)?.disableAutoMode ===
      'disable'
  )
}

const NO_CACHED_AUTO_MODE_CONFIG = Symbol('no-cached-auto-mode-config')

// ─── 通知 ───────────────────────────────────────────

export function getAutoModeUnavailableNotification(reason: AutoModeUnavailableReason): string {
  let base: string
  switch (reason) {
    case 'settings':
      base = 'auto mode disabled by settings'
      break
    case 'circuit-breaker':
      base = 'auto mode is unavailable for your plan'
      break
    case 'model':
      base = 'auto mode unavailable for this model'
      break
  }
  return isInternalBuild() ? `${base} · #zy-code-feedback` : base
}

// ─── 同步门控检查 ───────────────────────────────────

/**
 * 检查 auto 模式是否可以进入：熔断器未激活且设置未禁用它。同步。
 */
export function isAutoModeGateEnabled(): boolean {
  if (autoModeStateModule?.isAutoModeCircuitBroken() ?? false) {
    return false
  }
  if (isAutoModeDisabledBySettings()) {
    return false
  }
  return modelSupportsAutoMode(getMainLoopModel()!)
}

/**
 * 返回 auto 模式当前不可用的原因，如果可用则返回 null。
 * 同步 — 使用由 verifyAutoModeGateAccess 填充的状态。
 */
export function getAutoModeUnavailableReason(): AutoModeUnavailableReason | null {
  if (isAutoModeDisabledBySettings()) {
    return 'settings'
  }
  if (autoModeStateModule?.isAutoModeCircuitBroken() ?? false) {
    return 'circuit-breaker'
  }
  if (!modelSupportsAutoMode(getMainLoopModel()!)) {
    return 'model'
  }
  return null
}

// ─── GrowthBook 配置读取 ────────────────────────────

/**
 * 读取 zy_auto_mode_config 中的 `enabled` 字段（缓存，可能过时）。
 * 如果 GrowthBook 不可用或字段未设置，默认为 'disabled'。
 * 其他表面（IDE、Desktop）应调用此函数来决定是否在其模式选择器中展示 auto 模式。
 */
export function getAutoModeEnabledState(): AutoModeEnabledState {
  // dev 模式下直接启用（绕过 GrowthBook 远程配置默认 disabled）
  if (isEnvTruthy(process.env.ZY_CODE_DEV_AUTO_MODE)) {
    return 'enabled'
  }
  const config = getFeatureValue_CACHED_MAY_BE_STALE<{
    enabled?: AutoModeEnabledState
  }>('zy_auto_mode_config', {})
  return parseAutoModeEnabledState(config?.enabled)
}

/**
 * 类似 getAutoModeEnabledState，但在没有缓存值时返回 undefined
 * （冷启动，GrowthBook 初始化之前）。由 initialPermissionModeFromCLI 中的
 * 同步熔断器检查使用，不能将"尚未获取"与"已获取并禁用"混为一谈 —
 * 前者委托给 verifyAutoModeGateAccess，后者立即阻止。
 */
export function getAutoModeEnabledStateIfCached(): AutoModeEnabledState | undefined {
  // dev 模式下直接启用（绕过 GrowthBook 远程配置默认 disabled）
  if (isEnvTruthy(process.env.ZY_CODE_DEV_AUTO_MODE)) {
    return 'enabled'
  }
  const config = getFeatureValue_CACHED_MAY_BE_STALE<
    { enabled?: AutoModeEnabledState } | typeof NO_CACHED_AUTO_MODE_CONFIG
  >('zy_auto_mode_config', NO_CACHED_AUTO_MODE_CONFIG)
  if (config === NO_CACHED_AUTO_MODE_CONFIG) {
    return undefined
  }
  return parseAutoModeEnabledState(config?.enabled)
}

// ─── Opt-in 查询 ────────────────────────────────────

/**
 * 如果用户通过任何受信任机制 opt-in 了 auto 模式，则返回 true：
 * - CLI 标志（--enable-auto-mode / --permission-mode auto）— 会话范围的可用性请求；
 *   showSetupScreens() 中的启动对话框在 REPL 渲染之前强制执行持久同意。
 * - skipAutoPermissionPrompt 设置（持久化；通过接受 opt-in 对话框或
 *   IDE/Desktop 设置切换来设置）
 */
export function hasAutoModeOptInAnySource(): boolean {
  if (autoModeStateModule?.getAutoModeFlagCli() ?? false) {
    return true
  }
  return hasAutoModeOptIn()
}

export function isDefaultPermissionModeAuto(): boolean {
  // 仅可信源的 defaultMode:auto 生效（project/local 忽略）
  return hasTrustedDefaultModeAuto()
}

/**
 * plan 模式是否应使用 auto 模式语义（分类器在 plan 期间运行）。
 * 当用户已 opt-in auto 模式且门控已启用时为 true。
 * 在权限检查时评估，因此对配置更改是响应式的。
 */
export function shouldPlanUseAutoMode(): boolean {
  return hasAutoModeOptIn() && isAutoModeGateEnabled() && getUseAutoModeDuringPlan()
  return false
}

// ─── 异步门控验证 ──────────────────────────────────

/**
 * auto 模式可用性的异步检查。
 *
 * 返回转换函数（而非预先计算的上下文），调用者在 setAppState(prev => ...)
 * 中针对当前上下文应用。这可以防止异步 GrowthBook await 覆盖轮次中的
 * 模式更改（例如用户在检查进行中 shift-tab 切换到 acceptEdits）。
 *
 * 转换函数会针对新鲜的 ctx 重新检查 mode/prePlanMode，以避免在 await
 * 期间将用户踢出他们已经离开的模式。
 */
export async function verifyAutoModeGateAccess(
  currentContext: ToolPermissionContext,
): Promise<AutoModeGateCheckResult> {
  // auto 模式配置 — 在所有构建中运行（熔断器、轮播、踢出）
  // 重新读取 zy_auto_mode_config.enabled — 此异步检查在 GrowthBook 初始化后运行一次，
  // 是 isAutoModeAvailable 的权威来源。同步启动路径使用过时缓存；此检查进行修正。
  // 熔断器（enabled==='disabled'）在此生效。
  const autoModeConfig = await getDynamicConfig_BLOCKS_ON_INIT<{
    enabled?: AutoModeEnabledState
  }>('zy_auto_mode_config', {})
  const enabledState = parseAutoModeEnabledState(autoModeConfig?.enabled)
  const disabledBySettings = isAutoModeDisabledBySettings()
  // 将设置禁用在熔断器语义上与 GrowthBook 'disabled' 同等对待 —
  // 阻止 SDK/显式重新进入（通过 isAutoModeGateEnabled()）。
  autoModeStateModule?.setAutoModeCircuitBroken(enabledState === 'disabled' || disabledBySettings)

  // 轮播可用性：未被熔断、未被设置禁用、模型支持，且（已启用或已 opt-in）
  const mainModel = getMainLoopModel()!
  const modelSupported = modelSupportsAutoMode(mainModel)
  let carouselAvailable = false
  if (enabledState !== 'disabled' && !disabledBySettings && modelSupported) {
    carouselAvailable = enabledState === 'enabled' || hasAutoModeOptInAnySource()
  }
  // canEnterAuto 门控显式进入（--permission-mode auto、defaultMode: auto）
  // — 显式进入本身就是一种 opt-in，因此我们仅基于熔断器 + 设置 + 模型进行阻止
  const canEnterAuto = enabledState !== 'disabled' && !disabledBySettings && modelSupported
  permLog(
    `[auto-mode] verifyAutoModeGateAccess: enabledState=${enabledState} disabledBySettings=${disabledBySettings} model=${mainModel} modelSupported=${modelSupported} carouselAvailable=${carouselAvailable} canEnterAuto=${canEnterAuto}`,
  )

  // 现在捕获 CLI 标志意图（不依赖于上下文）。
  const autoModeFlagCli = autoModeStateModule?.getAutoModeFlagCli() ?? false

  // 返回转换函数，针对当前上下文重新评估依赖于上下文的条件。
  // 上方的异步 GrowthBook 结果（canEnterAuto、carouselAvailable 等）
  // 被闭包捕获 — 这些不依赖于上下文。但 mode、prePlanMode 和
  // isAutoModeAvailable 检查必须使用新鲜的 ctx，否则 await 期间的
  // shift-tab 会被回退（或者更糟：如果用户在 await 期间进入了 auto 模式，
  // 尽管熔断器已设置，用户仍会留在 auto 中 — 因为 setAutoModeCircuitBroken
  // 在 await 之后才运行）。
  const setAvailable = (ctx: ToolPermissionContext, available: boolean): ToolPermissionContext => {
    if (ctx.isAutoModeAvailable !== available) {
      permLog(
        `[auto-mode] verifyAutoModeGateAccess setAvailable: ${ctx.isAutoModeAvailable} -> ${available}`,
      )
    }
    return ctx.isAutoModeAvailable === available ? ctx : { ...ctx, isAutoModeAvailable: available }
  }

  if (canEnterAuto) {
    return { updateContext: (ctx) => setAvailable(ctx, carouselAvailable) }
  }

  // 门控关闭或熔断 — 确定原因（与上下文无关）。
  let reason: AutoModeUnavailableReason
  if (disabledBySettings) {
    reason = 'settings'
    permLog('auto mode disabled: disableAutoMode in settings', {
      level: 'warn',
    })
  } else if (enabledState === 'disabled') {
    reason = 'circuit-breaker'
    permLog('auto mode disabled: zy_auto_mode_config.enabled === "disabled" (circuit breaker)', {
      level: 'warn',
    })
  } else {
    reason = 'model'
    permLog(`auto mode disabled: model ${getMainLoopModel()} does not support auto mode`, {
      level: 'warn',
    })
  }
  const notification = getAutoModeUnavailableNotification(reason)

  // 统一踢出转换。重新检查新鲜上下文，仅在踢出实际适用时触发
  // 副作用（setAutoModeActive(false)、setNeedsAutoModeExitAttachment）。
  // 这使得 autoModeActive 与 toolPermissionContext.mode 保持同步，
  // 即使用户在 await 期间更改了模式：如果他们已自行离开 auto，
  // handleCycleMode 已停用分类器，我们不再触发；
  // 如果他们在 await 期间进入了 auto（在 setAutoModeCircuitBroken 生效前可能），
  // 我们在这里踢出他们。
  const kickOutOfAutoIfNeeded = (ctx: ToolPermissionContext): ToolPermissionContext => {
    const inAuto = ctx.mode === 'auto'
    permLog(
      `[auto-mode] kickOutOfAutoIfNeeded applying: ctx.mode=${ctx.mode} ctx.prePlanMode=${ctx.prePlanMode} reason=${reason}`,
    )
    // 带 auto 激活的 plan 模式：来自 prePlanMode='auto'（从 auto 进入）或 opt-in（存在 strippedDangerousRules）。
    const inPlanWithAutoActive =
      ctx.mode === 'plan' && (ctx.prePlanMode === 'auto' || !!ctx.strippedDangerousRules)
    if (!inAuto && !inPlanWithAutoActive) {
      return setAvailable(ctx, false)
    }
    if (inAuto) {
      autoModeStateModule?.setAutoModeActive(false)
      setNeedsAutoModeExitAttachment(true)
      return {
        ...applyPermissionUpdate(restoreDangerousPermissions(ctx), {
          type: 'setMode',
          mode: 'default',
          destination: 'session',
        }),
        isAutoModeAvailable: false,
      }
    }
    // plan 模式下 auto 激活：停用 auto、恢复权限、解除 prePlanMode
    // 以便 ExitPlanMode 进入 default。
    autoModeStateModule?.setAutoModeActive(false)
    setNeedsAutoModeExitAttachment(true)
    return {
      ...restoreDangerousPermissions(ctx),
      prePlanMode: ctx.prePlanMode === 'auto' ? 'default' : ctx.prePlanMode,
      isAutoModeAvailable: false,
    }
  }

  // 通知决策使用过时上下文 — 这没问题：我们根据检查启动时用户在做什么来决定
  // 是否通知。（副作用和模式变更在上方转换函数中决定，针对新鲜上下文。）
  const wasInAuto = currentContext.mode === 'auto'
  // auto 在 plan 期间被使用：从 auto 进入或 opt-in auto 已激活
  const autoActiveDuringPlan =
    currentContext.mode === 'plan' &&
    (currentContext.prePlanMode === 'auto' || !!currentContext.strippedDangerousRules)
  const wantedAuto = wasInAuto || autoActiveDuringPlan || autoModeFlagCli

  if (!wantedAuto) {
    // 用户在调用时不需要 auto — 不通知。但仍应用完整的踢出转换：
    // 如果他们在 await 期间 shift-tab 进入了 auto（在 setAutoModeCircuitBroken 生效前），我们需要驱逐他们。
    return { updateContext: kickOutOfAutoIfNeeded }
  }

  if (wasInAuto || autoActiveDuringPlan) {
    // 用户在 auto 中或 plan 期间 auto 已激活 — 踢出 + 通知。
    return { updateContext: kickOutOfAutoIfNeeded, notification }
  }

  // 仅 autoModeFlagCli：defaultMode 为 auto 但同步检查拒绝了它。
  // 如果 isAutoModeAvailable 已经为 false，则抑制通知（已在之前的检查中通知过；
  // 防止在连续切换到不支持的模型时重复通知）。
  return {
    updateContext: kickOutOfAutoIfNeeded,
    notification: currentContext.isAutoModeAvailable ? notification : undefined,
  }
}
