import { createFallbackStorage } from './fallbackStorage.js'
import { macOsKeychainStorage } from './macOsKeychainStorage.js'
import { plainTextStorage } from './plainTextStorage.js'
import type { SecureStorage } from './types.js'

/**
 * Get the appropriate secure storage implementation for the current platform
 */
export function getSecureStorage(): SecureStorage {
  if (process.platform === 'darwin') {
    // biome-ignore lint/suspicious/noExplicitAny: 安全存储适配层类型处理
    return createFallbackStorage(macOsKeychainStorage as any, plainTextStorage as any) as any
  }

  // TODO: add libsecret support for Linux

  // biome-ignore lint/suspicious/noExplicitAny: 安全存储适配层类型处理
  return plainTextStorage as any
}
