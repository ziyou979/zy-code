/**
 * 从 --add-dir 目录读取插件相关设置（enabledPlugins、extraKnownMarketplaces）。
 *
 * 这些设置优先级最低；调用方必须在其上展开标准设置，使
 * user/project/local/flag/policy 来源均可覆盖。
 */

import { join } from 'node:path'
import type { z } from 'zod/v4'
import { getAdditionalDirectoriesForAgentsMd } from '../../bootstrap/runtime/runtimeContext.js'
import { parseSettingsFile } from '../settings/settings.js'
import type { ExtraKnownMarketplaceSchema, SettingsJson } from '../settings/types.js'

type ExtraKnownMarketplace = z.infer<ReturnType<typeof ExtraKnownMarketplaceSchema>>

const SETTINGS_FILES = ['settings.json', 'settings.local.json'] as const

/**
 * 返回合并了所有 --add-dir 目录的 enabledPlugins 记录。
 *
 * 每个目录内先处理 settings.json，再处理 settings.local.json，因此 local 胜出；
 * 多个目录间发生冲突时，CLI 顺序靠后的目录胜出。
 *
 * 此记录优先级最低；调用方必须在其上展开标准设置，允许
 * user/project/local/flag/policy 覆盖。
 */
export function getAddDirEnabledPlugins(): NonNullable<SettingsJson['enabledPlugins']> {
  const result: NonNullable<SettingsJson['enabledPlugins']> = {}
  for (const dir of getAdditionalDirectoriesForAgentsMd()) {
    for (const file of SETTINGS_FILES) {
      const { settings } = parseSettingsFile(join(dir, '.zy', file))
      if (!settings?.enabledPlugins) {
        continue
      }
      Object.assign(result, settings.enabledPlugins)
    }
  }
  return result
}

/**
 * 返回合并了所有 --add-dir 目录的 extraKnownMarketplaces 记录。
 *
 * 优先级规则与 getAddDirEnabledPlugins 相同：每个目录内 settings.local.json
 * 胜出，调用方再在其上展开标准设置。
 */
export function getAddDirExtraMarketplaces(): Record<string, ExtraKnownMarketplace> {
  const result: Record<string, ExtraKnownMarketplace> = {}
  for (const dir of getAdditionalDirectoriesForAgentsMd()) {
    for (const file of SETTINGS_FILES) {
      const { settings } = parseSettingsFile(join(dir, '.zy', file))
      if (!settings?.extraKnownMarketplaces) {
        continue
      }
      Object.assign(result, settings.extraKnownMarketplaces)
    }
  }
  return result
}
