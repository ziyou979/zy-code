import type { SecureStorage, SecureStorageData } from './types.js'

/**
 * Creates a fallback storage that tries to use the primary storage first,
 * and if that fails, falls back to the secondary storage
 */
export function createFallbackStorage(
  primary: SecureStorage,
  secondary: SecureStorage,
): SecureStorage {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: 安全存储适配层类型处理
    name: `${(primary as any).name}-with-${(secondary as any).name}-fallback`,
    read(): SecureStorageData {
      // biome-ignore lint/suspicious/noExplicitAny: 安全存储适配层类型处理
      const result = (primary as any).read()
      if (result !== null && result !== undefined) {
        return result
      }
      // biome-ignore lint/suspicious/noExplicitAny: 安全存储适配层类型处理
      return (secondary as any).read() || {}
    },
    async readAsync(): Promise<SecureStorageData | null> {
      // biome-ignore lint/suspicious/noExplicitAny: 安全存储适配层类型处理
      const result = await (primary as any).readAsync()
      if (result !== null && result !== undefined) {
        return result
      }
      // biome-ignore lint/suspicious/noExplicitAny: 安全存储适配层类型处理
      return (await (secondary as any).readAsync()) || {}
    },
    update(data: SecureStorageData): { success: boolean; warning?: string } {
      // Capture state before update
      // biome-ignore lint/suspicious/noExplicitAny: 安全存储适配层类型处理
      const primaryDataBefore = (primary as any).read()

      // biome-ignore lint/suspicious/noExplicitAny: 安全存储适配层类型处理
      const result = (primary as any).update(data)

      if (result.success) {
        // Delete secondary when migrating to primary for the first time
        // This preserves credentials when sharing .zy between host and containers
        // See: https://github.com/anthropics/zy-code/issues/1414
        if (primaryDataBefore === null) {
          // biome-ignore lint/suspicious/noExplicitAny: 安全存储适配层类型处理
          ;(secondary as any).delete()
        }
        return result
      }

      // biome-ignore lint/suspicious/noExplicitAny: 安全存储适配层类型处理
      const fallbackResult = (secondary as any).update(data)

      if (fallbackResult.success) {
        // Primary write failed but primary may still hold an *older* valid
        // entry. read() prefers primary whenever it returns non-null, so that
        // stale entry would shadow the fresh data we just wrote to secondary —
        // e.g. a refresh token the server has already rotated away, causing a
        // /login loop (#30337). Best-effort delete; if this also fails the
        // user's keychain is in a bad state we can't fix from here.
        if (primaryDataBefore !== null) {
          // biome-ignore lint/suspicious/noExplicitAny: 安全存储适配层类型处理
          ;(primary as any).delete()
        }
        return {
          success: true,
          warning: fallbackResult.warning,
        }
      }

      return { success: false }
    },
    delete(): boolean {
      // biome-ignore lint/suspicious/noExplicitAny: 安全存储适配层类型处理
      const primarySuccess = (primary as any).delete()
      // biome-ignore lint/suspicious/noExplicitAny: 安全存储适配层类型处理
      const secondarySuccess = (secondary as any).delete()

      return primarySuccess || secondarySuccess
    },
  // biome-ignore lint/suspicious/noExplicitAny: 安全存储适配层类型处理
  } as any
}
