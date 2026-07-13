import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import type { SettingsJson } from '../../utils/settings/types.js'

/**
 * 远程托管设置响应的 Schema。
 * 注意：使用宽松的 z.record() 而非 SettingsSchema 以避免循环依赖。
 * 完整验证在 index.ts 中解析后使用 SettingsSchema.safeParse() 执行。
 */
export const RemoteManagedSettingsResponseSchema = lazySchema(() =>
  z.object({
    uuid: z.string(), // 设置的 UUID
    checksum: z.string(),
    settings: z.record(z.string(), z.unknown()) as z.ZodType<SettingsJson>,
  }),
)

export type RemoteManagedSettingsResponse = z.infer<
  ReturnType<typeof RemoteManagedSettingsResponseSchema>
>

/**
 * 获取远程托管设置的结果
 */
export type RemoteManagedSettingsFetchResult = {
  success: boolean
  settings?: SettingsJson | null // null 表示 304 Not Modified（缓存有效）
  checksum?: string
  error?: string
  skipRetry?: boolean // 如果为 true，失败时不重试（例如认证错误）
}
