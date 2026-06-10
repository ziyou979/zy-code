// Secure Storage Types

export interface SecureStorage {
  read(): SecureStorageData | null
  readAsync(): Promise<SecureStorageData | null>
  update(data: SecureStorageData): { success: boolean; warning?: string }
  delete(): Promise<void>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SecureStorageData = Record<string, any>
