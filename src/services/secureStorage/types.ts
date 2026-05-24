// Secure Storage Types

export interface SecureStorage {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export type SecureStorageData = Record<string, string>
