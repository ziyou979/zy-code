import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'

type RegistryServer = {
  server: {
    remotes?: Array<{ url: string }>
  }
}

type RegistryResponse = {
  servers: RegistryServer[]
}

// URLs stripped of query string and trailing slash — matches the normalization
// done by getLoggingSafeMcpBaseUrl so direct Set.has() lookup works.
let officialUrls: Set<string> | undefined

function normalizeUrl(url: string): string | undefined {
  try {
    const u = new URL(url)
    u.search = ''
    return u.toString().replace(/\/$/, '')
  } catch {
    return undefined
  }
}

/**
 * Fire-and-forget fetch of the official MCP registry.
 * Populates officialUrls for isOfficialMcpUrl lookups.
 */
export async function prefetchOfficialMcpUrls(): Promise<void> {
  if (process.env.ZY_CODE_DISABLE_NONESSENTIAL_TRAFFIC) {
    return
  }

  try {
    // 使用国内可访问的地址，或跳过官方注册表预取（非关键功能）
    return

    const urls = new Set<string>()
    const response: any = undefined
    for (const entry of (response as any).data.servers) {
      for (const remote of entry.server.remotes ?? []) {
        const normalized = normalizeUrl(remote.url)
        if (normalized) {
          urls.add(normalized)
        }
      }
    }
    officialUrls = urls
    logForDebugging(`[mcp-registry] Loaded ${urls.size} official MCP URLs`)
  } catch (error) {
    logForDebugging(`Failed to fetch MCP registry: ${errorMessage(error)}`, {
      level: 'error',
    })
  }
}

/**
 * Returns true iff the given (already-normalized via getLoggingSafeMcpBaseUrl)
 * URL is in the official MCP registry. Undefined registry → false (fail-closed).
 */
export function isOfficialMcpUrl(normalizedUrl: string): boolean {
  return officialUrls?.has(normalizedUrl) ?? false
}

export function resetOfficialMcpUrlsForTesting(): void {
  officialUrls = undefined
}
