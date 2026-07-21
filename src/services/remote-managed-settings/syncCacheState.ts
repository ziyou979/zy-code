/**
 * 远程托管设置同步缓存的叶子状态模块。
 *
 * 从 syncCache.ts 拆分出来，以打破 settings.ts → syncCache.ts → auth.ts →
 * settings.ts 的循环。auth.ts 位于大型设置 SCC 内；从 settings.ts 自己的依赖链
 * 中导入它会在启动时将数百个模块拉入急切求值的 SCC。
 *
 * 此模块仅导入叶子节点（path、envUtils、file、json、types、
 * settings/settingsCache — 也是叶子节点，仅类型导入验证）。settings.ts
 * 从这里读取缓存。syncCache.ts 保留 isRemoteManagedSettingsEligible
 * （涉及 auth 的部分）并从此处重新导出所有内容，供不关心循环的调用者使用。
 *
 * 资格状态在这里是三态的：undefined（尚未确定 — 返回 null）、
 * false（不符合资格 — 返回 null）、true（继续）。managedEnv.ts
 * 在读取 policySettings 之前调用 isRemoteManagedSettingsEligible() —
 * 在应用 userSettings/flagSettings 环境变量之后，因此检查能看到
 * 配置提供的 ZY_CODE_USE_BEDROCK/ZY_CODE_BASE_URL。该调用计算一次
 * 并通过 setEligibility() 将结果镜像到这里。每次后续读取都会命中
 * 缓存的布尔值，而不是重新运行 auth 链。
 */

import { join } from 'node:path'
import { getZyConfigHomeDir } from '../../services/infra/envUtils.js'
import { readFileSync } from '../file-persistence/fileRead.js'
import { stripBOM } from '../file-persistence/jsonRead.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import type { SettingsJson } from '../settings/types.js'
import { jsonParse } from '../../services/infra/slowOperations.js'

const SETTINGS_FILENAME = 'remote-settings.json'

let sessionCache: SettingsJson | null = null
let eligible: boolean | undefined

export function setSessionCache(value: SettingsJson | null): void {
  sessionCache = value
}

export function resetSyncCache(): void {
  sessionCache = null
  eligible = undefined
}

export function setEligibility(v: boolean): boolean {
  eligible = v
  return v
}

export function getSettingsPath(): string {
  return join(getZyConfigHomeDir(), SETTINGS_FILENAME)
}

// 同步 IO — 设置管线是同步的。fileRead 和 jsonRead 是叶子节点；
// file.ts 和 json.ts 都位于设置 SCC 中。
function loadSettings(): SettingsJson | null {
  try {
    const content = readFileSync(getSettingsPath())
    const data: unknown = jsonParse(stripBOM(content))
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return null
    }
    return data as SettingsJson
  } catch {
    return null
  }
}

export function getRemoteManagedSettingsSyncFromCache(): SettingsJson | null {
  if (eligible !== true) {
    return null
  }
  if (sessionCache) {
    return sessionCache
  }
  const cachedSettings = loadSettings()
  if (cachedSettings) {
    sessionCache = cachedSettings
    // 远程设置首次变为可用。在此之前缓存的任何合并的
    // getInitialSettings() 结果都缺少 policySettings 层
    // （上面的 `eligible !== true` 守卫返回了 null）。刷新以便
    // 下次合并读取时能看到此层。
    //
    // 最多触发一次：后续调用会命中上面的 `if (sessionCache)`。
    // 当从 loadSettingsFromDisk() 调用时（settings.ts:546），合并
    // 缓存仍为 null（setSessionSettingsCache 在 :732 运行，在
    // loadSettingsFromDisk 返回之后）— 空操作。异步获取分支
    // （index.ts setSessionCache + notifyChange）已处理自己的重置。
    //
    // gh-23085: main.tsx Commander 定义时的 isBridgeEnabled()
    // （在 preAction → init() → isRemoteManagedSettingsEligible() 之前）
    // 访问了 auth.ts:115 的 getInitialSettings()。bridgeEnabled 中的
    // try/catch 吞掉了后续 getGlobalConfig() 的抛出，但合并设置缓存
    // 已经被污染。参见 managedSettingsHeadless.int.test.ts。
    resetSettingsCache()
    return cachedSettings
  }
  return null
}
