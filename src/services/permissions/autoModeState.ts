// Auto mode 状态函数单独放在本模块，使调用方可在条件为 true 时才 require()。

let autoModeActive = false
let autoModeFlagCli = false
// 异步 verifyAutoModeGateAccess 从 GrowthBook 读取到最新的
// zy_auto_mode_config.enabled === 'disabled' 时设置。isAutoModeGateEnabled() 据此阻止
// 被移出后的 SDK 或显式重新进入。
let autoModeCircuitBroken = false

export function setAutoModeActive(active: boolean): void {
  autoModeActive = active
}

export function isAutoModeActive(): boolean {
  return autoModeActive
}

export function setAutoModeFlagCli(passed: boolean): void {
  autoModeFlagCli = passed
}

export function getAutoModeFlagCli(): boolean {
  return autoModeFlagCli
}

export function setAutoModeCircuitBroken(broken: boolean): void {
  autoModeCircuitBroken = broken
}

export function isAutoModeCircuitBroken(): boolean {
  return autoModeCircuitBroken
}

export function _resetForTesting(): void {
  autoModeActive = false
  autoModeFlagCli = false
  autoModeCircuitBroken = false
}
