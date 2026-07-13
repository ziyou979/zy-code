// 导出用于测试
export function getNodeEnv(): string {
  return process.env.NODE_ENV || 'development'
}

// 导出用于测试
export function getUserType(): string {
  return process.env.USER_TYPE || 'external'
}

export function getEntrypoint(): string | undefined {
  return process.env.ZY_CODE_ENTRYPOINT
}

export function isCustomTitleEnabled(): boolean {
  return true
}
