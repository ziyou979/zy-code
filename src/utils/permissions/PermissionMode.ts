import { feature } from 'bun:bundle'
import z from 'zod/v4'
import { PAUSE_ICON } from '../../constants/figures.js'
// 类型定义已提取到 src/types/permissions.ts 以打破导入循环
import {
  EXTERNAL_PERMISSION_MODES,
  type ExternalPermissionMode,
  PERMISSION_MODES,
  type PermissionMode,
} from '../../types/permissions.js'
import { isInternalBuild } from '../envUtils.js'
import { lazySchema } from '../lazySchema.js'

// 为向后兼容而重新导出
export {
  EXTERNAL_PERMISSION_MODES,
  type ExternalPermissionMode,
  PERMISSION_MODES,
  type PermissionMode,
}

export const permissionModeSchema = lazySchema(() => z.enum(PERMISSION_MODES))
export const externalPermissionModeSchema = lazySchema(() => z.enum(EXTERNAL_PERMISSION_MODES))

type ModeColorKey = 'text' | 'planMode' | 'permission' | 'autoAccept' | 'error' | 'warning'

type PermissionModeConfig = {
  title: string
  shortTitle: string
  symbol: string
  color: ModeColorKey
  external: ExternalPermissionMode
}

import { tSync } from '../../i18n/index.js'

const PERMISSION_MODE_CONFIG: Partial<Record<PermissionMode, PermissionModeConfig>> = {
  default: {
    title: 'permissionMode.default',
    shortTitle: 'permissionMode.defaultShort',
    symbol: '',
    color: 'text',
    external: 'default',
  },
  plan: {
    title: 'permissionMode.plan',
    shortTitle: 'permissionMode.planShort',
    symbol: PAUSE_ICON,
    color: 'planMode',
    external: 'plan',
  },
  acceptEdits: {
    title: 'permissionMode.acceptEdits',
    shortTitle: 'permissionMode.acceptEditsShort',
    symbol: '⏵⏵',
    color: 'autoAccept',
    external: 'acceptEdits',
  },
  bypassPermissions: {
    title: 'permissionMode.bypassPermissions',
    shortTitle: 'permissionMode.bypassPermissionsShort',
    symbol: '⏵⏵',
    color: 'error',
    external: 'bypassPermissions',
  },
  dontAsk: {
    title: 'permissionMode.dontAsk',
    shortTitle: 'permissionMode.dontAskShort',
    symbol: '⏵⏵',
    color: 'error',
    external: 'dontAsk',
  },
  ...(feature('TRANSCRIPT_CLASSIFIER')
    ? {
        auto: {
          title: 'permissionMode.auto',
          shortTitle: 'permissionMode.autoShort',
          symbol: '⏵⏵',
          color: 'warning' as ModeColorKey,
          external: 'default' as ExternalPermissionMode,
        },
      }
    : {}),
}

/**
 * 类型守卫：检查 PermissionMode 是否为 ExternalPermissionMode。
 * auto 模式仅限内部使用，不包含在外部模式中。
 */
export function isExternalPermissionMode(mode: PermissionMode): mode is ExternalPermissionMode {
  // 外部用户无法使用 auto 模式，因此对他们始终返回 true
  if (!isInternalBuild()) {
    return true
  }
  return mode !== 'auto' && mode !== 'bubble'
}

function getModeConfig(mode: PermissionMode): PermissionModeConfig {
  return PERMISSION_MODE_CONFIG[mode] ?? PERMISSION_MODE_CONFIG.default!
}

export function toExternalPermissionMode(mode: PermissionMode): ExternalPermissionMode {
  return getModeConfig(mode).external
}

export function permissionModeFromString(str: string): PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(str) ? (str as PermissionMode) : 'default'
}

export function permissionModeTitle(mode: PermissionMode): string {
  return tSync(getModeConfig(mode).title)
}

export function isDefaultMode(mode: PermissionMode | undefined): boolean {
  return mode === 'default' || mode === undefined
}

export function permissionModeShortTitle(mode: PermissionMode): string {
  return tSync(getModeConfig(mode).shortTitle)
}

export function permissionModeSymbol(mode: PermissionMode): string {
  return getModeConfig(mode).symbol
}

export function getModeColor(mode: PermissionMode): ModeColorKey {
  return getModeConfig(mode).color
}
