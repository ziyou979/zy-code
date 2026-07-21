/**
 * errno / Axios 错误分类纯函数。
 *
 * 从 errors.ts 提取。只对传入的 unknown 做运行时类型检查，无 IO 无副作用。
 */

/**
 * Extract the errno code (e.g., 'ENOENT', 'EACCES') from a caught error.
 */
export function getErrnoCode(e: unknown): string | undefined {
  if (e && typeof e === 'object' && 'code' in e && typeof e.code === 'string') {
    return e.code
  }
  return undefined
}

/**
 * True if the error is ENOENT (file or directory does not exist).
 */
export function isENOENT(e: unknown): boolean {
  return getErrnoCode(e) === 'ENOENT'
}

/**
 * Extract the errno path from a caught error.
 */
export function getErrnoPath(e: unknown): string | undefined {
  if (e && typeof e === 'object' && 'path' in e && typeof e.path === 'string') {
    return e.path
  }
  return undefined
}

/**
 * True if the error means the path is missing, inaccessible, or
 * structurally unreachable.
 */
export function isFsInaccessible(e: unknown): e is NodeJS.ErrnoException {
  const code = getErrnoCode(e)
  return (
    code === 'ENOENT' ||
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'ENOTDIR' ||
    code === 'ELOOP'
  )
}

export type AxiosErrorKind = 'auth' | 'timeout' | 'network' | 'http' | 'other'

/** Local errorMessage to avoid circular dep. */
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object' && 'message' in e) return String(e.message)
  return String(e)
}

/**
 * Classify a caught error from an axios request into one of a few buckets.
 */
export function classifyAxiosError(e: unknown): {
  kind: AxiosErrorKind
  status?: number
  message: string
} {
  const message = errorMessage(e)
  if (!e || typeof e !== 'object' || !('isAxiosError' in e) || !e.isAxiosError) {
    return { kind: 'other', message }
  }
  const axiosErr = e as { code?: string; response?: { status?: number } }
  if (axiosErr.response) {
    const s = axiosErr.response.status
    if (s === 401 || s === 403) return { kind: 'auth', status: s, message }
    if (s && s >= 400) return { kind: 'http', status: s, message }
  }
  if (axiosErr.code === 'ECONNABORTED') return { kind: 'timeout', message }
  if (
    axiosErr.code === 'ECONNREFUSED' ||
    axiosErr.code === 'ENOTFOUND' ||
    axiosErr.code === 'ECONNRESET'
  ) {
    return { kind: 'network', message }
  }
  return { kind: 'other', message }
}
