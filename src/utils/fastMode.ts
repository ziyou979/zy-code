import {
    getIsNonInteractiveSession,
    preferThirdPartyAuthentication,
} from '../bootstrap/state.js'
import {
    type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    logEvent,
} from '../services/analytics/index.js'
import {logForDebugging} from './debug.js'
import {isEnvTruthy} from './envUtils.js'
import {
    type ModelSetting,
} from './model/model.js'
import {
    getInitialSettings,
    getSettingsForSource,
    updateSettingsForSource,
} from './settings/settings.js'
import {createSignal} from './signal.js'

export function isFastModeEnabled(): boolean {
    return !isEnvTruthy(process.env.ZY_CODE_DISABLE_FAST_MODE)
}

export function isFastModeAvailable(): boolean {
    if (!isFastModeEnabled()) {
        return false
    }
    return getFastModeUnavailableReason() === null
}

export function getFastModeUnavailableReason(): string | null {
    if (!isFastModeEnabled()) {
        return 'Fast mode is not available'
    }

    // Check if a fast model is configured
    const settings = getInitialSettings()
    if (!settings.fastModel) {
        return 'Fast mode requires a fast model to be configured · Set fastModel in settings.json'
    }

    // Not available in the SDK unless explicitly opted in via --settings.
    if (
        getIsNonInteractiveSession() &&
        preferThirdPartyAuthentication()
    ) {
        const flagFastMode = getSettingsForSource('flagSettings')?.fastMode
        if (!flagFastMode) {
            const reason = 'Fast mode is not available in the Agent SDK'
            logForDebugging(`Fast mode unavailable: ${reason}`)
            return reason
        }
    }

    return null
}

/**
 * Get the model to use when fast mode is enabled.
 * Returns the user-configured fastModel, or null if not set.
 */
export function getFastModeModel(): string | null {
    const settings = getInitialSettings()
    return settings.fastModel ?? null
}

/**
 * Get the display name for the fast mode model.
 */
export function getFastModeModelDisplay(): string {
    return getFastModeModel() ?? 'Fast Model'
}

export function getInitialFastModeSetting(model: ModelSetting): boolean {
    if (!isFastModeEnabled()) {
        return false
    }
    if (!isFastModeAvailable()) {
        return false
    }
    if (!isFastModeSupportedByModel(model)) {
        return false
    }
    const settings = getInitialSettings()
    // If per-session opt-in is required, fast mode starts off each session
    if (settings.fastModePerSessionOptIn) {
        return false
    }
    return settings.fastMode === true
}

export function isFastModeSupportedByModel(
    _modelSetting: ModelSetting,
): boolean {
    if (!isFastModeEnabled()) {
        return false
    }
    // Fast mode is supported when a fast model is configured
    return !!getFastModeModel()
}

// --- Fast mode runtime state ---
// Separate from user preference (settings.fastMode). This tracks the actual
// operational state: whether we're actively sending fast speed or in cooldown
// after a rate limit.

export type FastModeRuntimeState =
    | { status: 'active' }
    | { status: 'cooldown'; resetAt: number; reason: CooldownReason }

let runtimeState: FastModeRuntimeState = {status: 'active'}
let hasLoggedCooldownExpiry = false

// --- Cooldown event listeners ---
export type CooldownReason = 'rate_limit' | 'overloaded'

const cooldownTriggered =
    createSignal<[resetAt: number, reason: CooldownReason]>()
const cooldownExpired = createSignal()
export const onCooldownTriggered = cooldownTriggered.subscribe
export const onCooldownExpired = cooldownExpired.subscribe

export function getFastModeRuntimeState(): FastModeRuntimeState {
    if (
        runtimeState.status === 'cooldown' &&
        Date.now() >= runtimeState.resetAt
    ) {
        if (isFastModeEnabled() && !hasLoggedCooldownExpiry) {
            logForDebugging('Fast mode cooldown expired, re-enabling fast mode')
            hasLoggedCooldownExpiry = true
            cooldownExpired.emit()
        }
        runtimeState = {status: 'active'}
    }
    return runtimeState
}

export function triggerFastModeCooldown(
    resetTimestamp: number,
    reason: CooldownReason,
): void {
    if (!isFastModeEnabled()) {
        return
    }
    runtimeState = {status: 'cooldown', resetAt: resetTimestamp, reason}
    hasLoggedCooldownExpiry = false
    const cooldownDurationMs = resetTimestamp - Date.now()
    logForDebugging(
        `Fast mode cooldown triggered (${reason}), duration ${Math.round(cooldownDurationMs / 1000)}s`,
    )
    logEvent('tengu_fast_mode_fallback_triggered', {
        cooldown_duration_ms: cooldownDurationMs,
        cooldown_reason:
            reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    cooldownTriggered.emit(resetTimestamp, reason)
}

export function clearFastModeCooldown(): void {
    runtimeState = {status: 'active'}
}

/**
 * Called when the API rejects a fast mode request.
 * Disables fast mode using the same flow as when the prefetch discovers it's disabled.
 */
export function handleFastModeRejectedByAPI(): void {
    updateSettingsForSource('userSettings', {fastMode: undefined})
}

// --- Overage rejection listeners ---
const overageRejection = createSignal<[message: string]>()
export const onFastModeOverageRejection = overageRejection.subscribe

export function handleFastModeOverageRejection(reason: string | null): void {
    const message = reason ? `Fast mode disabled: ${reason}` : 'Fast mode disabled'
    logForDebugging(`Fast mode overage rejection: ${message}`)
    updateSettingsForSource('userSettings', {fastMode: undefined})
    overageRejection.emit(message)
}

export function isFastModeCooldown(): boolean {
    return getFastModeRuntimeState().status === 'cooldown'
}

export function getFastModeState(
    model: ModelSetting,
    fastModeUserEnabled: boolean | undefined,
): 'off' | 'cooldown' | 'on' {
    const enabled =
        isFastModeEnabled() &&
        isFastModeAvailable() &&
        !!fastModeUserEnabled &&
        isFastModeSupportedByModel(model)
    if (enabled && isFastModeCooldown()) {
        return 'cooldown'
    }
    if (enabled) {
        return 'on'
    }
    return 'off'
}
