import type { SecureStorage, SecureStorageData } from './types.js'

/**
 * Interface extending SecureStorage with optional name property for display.
 */
interface SecureStorageWithName extends SecureStorage {
  name?: string
}

/**
 * 创建后备存储：优先使用主存储，失败时回退到次级存储。
 */
export function createFallbackStorage(
  primary: SecureStorage,
  secondary: SecureStorage,
): SecureStorage {
  const primaryWithName = primary as SecureStorageWithName
  const secondaryWithName = secondary as SecureStorageWithName
  const result: SecureStorageWithName = {
    name: `${primaryWithName.name ?? 'unknown'}-with-${secondaryWithName.name ?? 'unknown'}-fallback`,
    read(): SecureStorageData {
      const result = primary.read()
      if (result !== null && result !== undefined) {
        return result
      }
      return secondary.read() || {}
    },
    async readAsync(): Promise<SecureStorageData | null> {
      const result = await primary.readAsync()
      if (result !== null && result !== undefined) {
        return result
      }
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
    delete(): Promise<void> {
      const primarySuccess = primary.delete()
      const secondarySuccess = secondary.delete()

      return Promise.all([primarySuccess, secondarySuccess]).then(() => {})
    },
  }
  return result
}
