/**
 * 状态栏配置文件加载器。
 *
 * 配置文件路径：~/.zy/statusline.json
 *
 * 独立于 settings.json 的 builtInStatusBar 字段，提供专注的状态栏配置管理。
 * 向后兼容：若 statusline.json 不存在但 settings.json 有 builtInStatusBar 配置，
 * 自动从 settings 迁移并创建 statusline.json。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { getZyConfigHomeDir } from '../../services/infra/envUtils.js'
import { safeParseJSON } from '../../utils/json.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../services/infra/log.js'
import { jsonStringify } from '../../services/infra/slowOperations.js'
import type { StatuslineModuleConfig } from './statuslineTypes.js'

// ─── Schema ────────────────────────────────────────────────────────

const StatuslineModuleSchema = lazySchema(() =>
  z.object({
    id: z.enum(['directory', 'model', 'context', 'tokens', 'cost', 'memory']),
    visible: z.boolean().optional().default(true),
    icon: z.string().optional(),
    color: z.string().optional(),
  }),
)

const StatuslineConfigSchema = lazySchema(() =>
  z.object({
    enabled: z.boolean().optional().default(true),
    modules: z.array(StatuslineModuleSchema()).optional(),
  }),
)

export type StatuslineFileConfig = z.infer<ReturnType<typeof StatuslineConfigSchema>>

// ─── Path ──────────────────────────────────────────────────────────

export function getStatuslineConfigPath(): string {
  return join(getZyConfigHomeDir(), 'statusline.json')
}

// ─── Load / Save ───────────────────────────────────────────────────

/**
 * 加载 statusline.json 配置文件。
 * 返回 null 表示文件不存在或解析失败。
 */
export function loadStatuslineConfig(): StatuslineFileConfig | null {
  try {
    const raw = readFileSync(getStatuslineConfigPath(), 'utf-8')
    const parsed = safeParseJSON(raw, false)
    const result = StatuslineConfigSchema().safeParse(parsed)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

/**
 * 保存 statusline 配置到 statusline.json。
 */
export function saveStatuslineConfig(config: StatuslineFileConfig): void {
  const path = getStatuslineConfigPath()
  writeFileSync(path, `${jsonStringify(config, null, 2)}\n`)
}

// ─── 向后兼容 ──────────────────────────────────────────────────────

/**
 * 获取生效的 statusline 配置，含向后兼容迁移。
 *
 * 优先级：
 * 1. statusline.json（如存在且有效）
 * 2. settings.json 的 builtInStatusBar（如 statusline.json 不存在，自动迁移）
 * 3. 默认配置（如两者均不存在）
 */
export function getEffectiveStatuslineConfig(settingsBuiltInStatusBar?: {
  enabled?: boolean
  modules?: StatuslineModuleConfig[]
}): StatuslineFileConfig {
  // 1. 优先读取 statusline.json
  const fileConfig = loadStatuslineConfig()
  if (fileConfig) {
    return fileConfig
  }

  // 2. 回退到 settings.json 的 builtInStatusBar，并自动迁移
  if (settingsBuiltInStatusBar) {
    const migrated: StatuslineFileConfig = {
      enabled: settingsBuiltInStatusBar.enabled ?? true,
      modules: settingsBuiltInStatusBar.modules,
    }
    try {
      saveStatuslineConfig(migrated)
    } catch (e) {
      logError(e)
    }
    return migrated
  }

  // 3. 使用默认值
  return { enabled: true }
}
