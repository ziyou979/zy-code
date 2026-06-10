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
    // biome-ignore lint/suspicious/noExplicitAny: name 是实现细节，接口未声明
    name: `${(primary as any).name}-with-${(secondary as any).name}-fallback`,
    read(): SecureStorageData {
      const result = primary.read()
      if (result !== null && result !== undefined) {
        return result
      }
      return secondary.read() || {}
    },
    async readAsync(): Promise<SecureStorageData | null> {
      // biome-ignore lint/suspicious/noExplicitAny: readAsync 是扩展方法，接口未声明
      const result = await primary.readAsync()
      if (result !== null && result !== undefined) {
        return result
      }
      // biome-ignore lint/suspicious/noExplicitAny: readAsync 是扩展方法，接口未声明
      return (await secondary.readAsync()) || {}
    },
    update(data: SecureStorageData): { success: boolean; warning?: string } {
      const primaryDataBefore = primary.read()

      const result = primary.update(data)

      if (result.success) {
        if (primaryDataBefore === null) {
          secondary.delete()
        }
        return result
      }

      const fallbackResult = secondary.update(data)

      if (fallbackResult.success) {
        if (primaryDataBefore !== null) {
          primary.delete()
        }
        return {
          success: true,
          warning: fallbackResult.warning,
        }
      }

      return { success: false }
    },
    delete(): boolean {
      // biome-ignore lint/suspicious/noExplicitAny: delete() 返回 boolean 而非 Promise<void>
      const primarySuccess = (primary as any).delete()
      // biome-ignore lint/suspicious/noExplicitAny: delete() 返回 boolean 而非 Promise<void>
      const secondarySuccess = (secondary as any).delete()

      return primarySuccess || secondarySuccess
    },
    // biome-ignore lint/suspicious/noExplicitAny: 安全存储适配层类型处理
  } as any
}
