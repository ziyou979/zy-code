import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type Dirent } from 'node:fs'
import type { Command } from '../../commands.js'
import type { LogOption } from '../../types/logs.js'
import { getZyConfigHomeDir, isInternalBuild } from '../../utils/envUtils.js'
import {
  getProjectsDir,
  getSessionFilesWithMtime,
  loadAllLogsFromSessionFile,
} from '../../services/sessionStorage.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  AggregatedData,
  RemoteHostInfo,
  SessionFacets,
  SessionMeta,
  collectAllRemoteHostData,
  getDataDir,
  getFacetsDir,
  getRunningRemoteHosts,
} from './remoteCollection.js'
import {
  extractFacetsFromAPI,
  hasValidDates,
  loadCachedFacets,
  loadCachedSessionMeta,
  logToSessionMeta,
  saveFacets,
  saveSessionMeta,
} from './sessionAnalysis.js'
import { InsightResults, aggregateData, generateParallelInsights } from './aggregation.js'
import { generateHtmlReport } from './reportRendering.js'
// ============================================================================
// Export Types & Functions
// ============================================================================

/**
 * Structured export format for zyscope consumption
 */
export type InsightsExport = {
  metadata: {
    username: string
    generated_at: string
    zy_code_version: string
    date_range: { start: string; end: string }
    session_count: number
    remote_hosts_collected?: string[]
  }
  aggregated_data: AggregatedData
  insights: InsightResults
  facets_summary?: {
    total: number
    goal_categories: Record<string, number>
    outcomes: Record<string, number>
    satisfaction: Record<string, number>
    friction: Record<string, number>
  }
}

/**
 * Build export data from already-computed values.
 * Used by background upload to S3.
 */
export function buildExportData(
  data: AggregatedData,
  insights: InsightResults,
  facets: Map<string, SessionFacets>,
  remoteStats?: { hosts: RemoteHostInfo[]; totalCopied: number },
): InsightsExport {
  const version = typeof MACRO !== 'undefined' ? MACRO.VERSION : 'unknown'

  const remote_hosts_collected = remoteStats?.hosts
    .filter((h) => h.sessionCount > 0)
    .map((h) => h.name)

  const facets_summary = {
    total: facets.size,
    goal_categories: {} as Record<string, number>,
    outcomes: {} as Record<string, number>,
    satisfaction: {} as Record<string, number>,
    friction: {} as Record<string, number>,
  }
  for (const f of facets.values()) {
    for (const [cat, count] of safeEntries(f.goal_categories)) {
      if (count > 0) {
        facets_summary.goal_categories[cat] = (facets_summary.goal_categories[cat] || 0) + count
      }
    }
    facets_summary.outcomes[f.outcome] = (facets_summary.outcomes[f.outcome] || 0) + 1
    for (const [level, count] of safeEntries(f.user_satisfaction_counts)) {
      if (count > 0) {
        facets_summary.satisfaction[level] = (facets_summary.satisfaction[level] || 0) + count
      }
    }
    for (const [type, count] of safeEntries(f.friction_counts)) {
      if (count > 0) {
        facets_summary.friction[type] = (facets_summary.friction[type] || 0) + count
      }
    }
  }

  return {
    metadata: {
      username: process.env.SAFEUSER || process.env.USER || 'unknown',
      generated_at: new Date().toISOString(),
      zy_code_version: version,
      date_range: data.date_range,
      session_count: data.total_sessions,
      ...(remote_hosts_collected &&
        remote_hosts_collected.length > 0 && {
          remote_hosts_collected,
        }),
    },
    aggregated_data: data,
    insights,
    facets_summary,
  }
}

// ============================================================================
// Lite Session Scanning
// ============================================================================

export type LiteSessionInfo = {
  sessionId: string
  path: string
  mtime: number
  size: number
}

/**
 * Scans all project directories using filesystem metadata only (no JSONL parsing).
 * Returns a list of session file info sorted by mtime descending.
 * Yields to the event loop between project directories to keep the UI responsive.
 */
export async function scanAllSessions(): Promise<LiteSessionInfo[]> {
  const projectsDir = getProjectsDir()

  let dirents: Dirent[]
  try {
    dirents = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const projectDirs = dirents
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => join(projectsDir, dirent.name))

  const allSessions: LiteSessionInfo[] = []

  for (let i = 0; i < projectDirs.length; i++) {
    const sessionFiles = await getSessionFilesWithMtime(projectDirs[i]!)
    for (const [sessionId, fileInfo] of sessionFiles) {
      allSessions.push({
        sessionId,
        path: fileInfo.path,
        mtime: fileInfo.mtime,
        size: fileInfo.size,
      })
    }
    // Yield to event loop every 10 project directories
    if (i % 10 === 9) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  // Sort by mtime descending (most recent first)
  allSessions.sort((a, b) => b.mtime - a.mtime)
  return allSessions
}

// ============================================================================
// Main Function
// ============================================================================

export async function generateUsageReport(options?: { collectRemote?: boolean }): Promise<{
  insights: InsightResults
  htmlPath: string
  data: AggregatedData
  remoteStats?: { hosts: RemoteHostInfo[]; totalCopied: number }
  facets: Map<string, SessionFacets>
}> {
  let remoteStats: { hosts: RemoteHostInfo[]; totalCopied: number } | undefined

  // Optionally collect data from remote hosts first (ant-only)
  if (isInternalBuild() && options?.collectRemote) {
    const destDir = join(getZyConfigHomeDir(), 'projects')
    const { hosts, totalCopied } = await collectAllRemoteHostData(destDir)
    remoteStats = { hosts, totalCopied }
  }

  // Phase 1: Lite scan — filesystem metadata only (no JSONL parsing)
  const allScannedSessions = await scanAllSessions()
  const totalSessionsScanned = allScannedSessions.length

  // Phase 2: Load SessionMeta — use cache where available, parse only uncached
  // Read cached metas in parallel batches to avoid blocking the event loop
  const META_BATCH_SIZE = 50
  const MAX_SESSIONS_TO_LOAD = 200
  let allMetas: SessionMeta[] = []
  const uncachedSessions: LiteSessionInfo[] = []

  for (let i = 0; i < allScannedSessions.length; i += META_BATCH_SIZE) {
    const batch = allScannedSessions.slice(i, i + META_BATCH_SIZE)
    const results = await Promise.all(
      batch.map(async (sessionInfo) => ({
        sessionInfo,
        cached: await loadCachedSessionMeta(sessionInfo.sessionId),
      })),
    )
    for (const { sessionInfo, cached } of results) {
      if (cached) {
        allMetas.push(cached)
      } else if (uncachedSessions.length < MAX_SESSIONS_TO_LOAD) {
        uncachedSessions.push(sessionInfo)
      }
    }
  }

  // Load full message data only for uncached sessions and compute SessionMeta
  const logsForFacets = new Map<string, LogOption>()

  // Filter out /insights meta-sessions (facet extraction API calls get logged as sessions)
  const isMetaSession = (log: LogOption): boolean => {
    for (const msg of log.messages.slice(0, 5)) {
      if (msg.type === 'user' && msg.message) {
        const content = msg.message.content
        for (const block of content) {
          if (
            block.type === 'text' &&
            'text' in block &&
            ((block.text as string).includes('RESPOND WITH ONLY A VALID JSON OBJECT') ||
              (block.text as string).includes('record_facets'))
          ) {
            return true
          }
        }
      }
    }
    return false
  }

  // Load uncached sessions in batches to yield to event loop between batches
  const LOAD_BATCH_SIZE = 10
  for (let i = 0; i < uncachedSessions.length; i += LOAD_BATCH_SIZE) {
    const batch = uncachedSessions.slice(i, i + LOAD_BATCH_SIZE)
    const batchResults = await Promise.all(
      batch.map(async (sessionInfo) => {
        try {
          return await loadAllLogsFromSessionFile(sessionInfo.path)
        } catch {
          return []
        }
      }),
    )
    // Collect metas synchronously, then save them in parallel (independent writes)
    const metasToSave: SessionMeta[] = []
    for (const logs of batchResults) {
      for (const log of logs) {
        if (isMetaSession(log) || !hasValidDates(log)) {
          continue
        }
        const meta = logToSessionMeta(log)
        allMetas.push(meta)
        metasToSave.push(meta)
        // Keep the log around for potential facet extraction
        logsForFacets.set(meta.session_id, log)
      }
    }
    await Promise.all(metasToSave.map((meta) => saveSessionMeta(meta)))
  }

  // Deduplicate session branches (keep the one with most user messages per session_id)
  // This prevents inflated totals when a session has multiple conversation branches
  const bestBySession = new Map<string, SessionMeta>()
  for (const meta of allMetas) {
    const existing = bestBySession.get(meta.session_id)
    if (
      !existing ||
      meta.user_message_count > existing.user_message_count ||
      (meta.user_message_count === existing.user_message_count &&
        meta.duration_minutes > existing.duration_minutes)
    ) {
      bestBySession.set(meta.session_id, meta)
    }
  }
  // Replace allMetas with deduplicated list and remove unused logs from logsForFacets
  const keptSessionIds = new Set(bestBySession.keys())
  allMetas = [...bestBySession.values()]
  for (const sessionId of logsForFacets.keys()) {
    if (!keptSessionIds.has(sessionId)) {
      logsForFacets.delete(sessionId)
    }
  }

  // Sort all metas by start_time descending (most recent first)
  allMetas.sort((a, b) => b.start_time.localeCompare(a.start_time))

  // Pre-filter obviously minimal sessions to save API calls
  // (matching Python's substantive filtering concept)
  const isSubstantiveSession = (meta: SessionMeta): boolean => {
    // Skip sessions with very few user messages
    if (meta.user_message_count < 2) {
      return false
    }
    // Skip very short sessions (< 1 minute)
    if (meta.duration_minutes < 1) {
      return false
    }
    return true
  }

  const substantiveMetas = allMetas.filter(isSubstantiveSession)

  // Phase 3: Facet extraction — only for sessions without cached facets
  const facets = new Map<string, SessionFacets>()
  const toExtract: Array<{ log: LogOption; sessionId: string }> = []
  const MAX_FACET_EXTRACTIONS = 50

  // Load cached facets for all substantive sessions in parallel
  const cachedFacetResults = await Promise.all(
    substantiveMetas.map(async (meta) => ({
      sessionId: meta.session_id,
      cached: await loadCachedFacets(meta.session_id),
    })),
  )
  for (const { sessionId, cached } of cachedFacetResults) {
    if (cached) {
      facets.set(sessionId, cached)
    } else {
      const log = logsForFacets.get(sessionId)
      if (log && toExtract.length < MAX_FACET_EXTRACTIONS) {
        toExtract.push({ log, sessionId })
      }
    }
  }

  // Extract facets for sessions that need them (50 concurrent)
  const CONCURRENCY = 50
  for (let i = 0; i < toExtract.length; i += CONCURRENCY) {
    const batch = toExtract.slice(i, i + CONCURRENCY)
    const results = await Promise.all(
      batch.map(async ({ log, sessionId }) => {
        const newFacets = await extractFacetsFromAPI(log, sessionId)
        return { sessionId, newFacets }
      }),
    )
    // Collect facets synchronously, save in parallel (independent writes)
    const facetsToSave: SessionFacets[] = []
    for (const { sessionId, newFacets } of results) {
      if (newFacets) {
        facets.set(sessionId, newFacets)
        facetsToSave.push(newFacets)
      }
    }
    await Promise.all(facetsToSave.map((f) => saveFacets(f)))
  }

  // Filter out warmup/minimal sessions (matching Python's is_minimal)
  // A session is minimal if warmup_minimal is the ONLY goal category
  const isMinimalSession = (sessionId: string): boolean => {
    const sessionFacets = facets.get(sessionId)
    if (!sessionFacets) {
      return false
    }
    const cats = sessionFacets.goal_categories
    const catKeys = safeKeys(cats).filter((k) => (cats[k] ?? 0) > 0)
    return catKeys.length === 1 && catKeys[0] === 'warmup_minimal'
  }

  const substantiveSessions = substantiveMetas.filter((s) => !isMinimalSession(s.session_id))

  const substantiveFacets = new Map<string, SessionFacets>()
  for (const [sessionId, f] of facets) {
    if (!isMinimalSession(sessionId)) {
      substantiveFacets.set(sessionId, f)
    }
  }

  const aggregated = aggregateData(substantiveSessions, substantiveFacets)
  aggregated.total_sessions_scanned = totalSessionsScanned

  // Generate parallel insights from Zy (6 sections)
  const insights = await generateParallelInsights(aggregated, facets)

  // Generate HTML report
  const htmlReport = generateHtmlReport(aggregated, insights)

  // Save reports
  try {
    await mkdir(getDataDir(), { recursive: true })
  } catch {
    // Directory may already exist
  }

  const htmlPath = join(getDataDir(), 'report.html')
  await writeFile(htmlPath, htmlReport, {
    encoding: 'utf-8',
    mode: 0o600,
  })

  return {
    insights,
    htmlPath,
    data: aggregated,
    remoteStats,
    facets: substantiveFacets,
  }
}

export function safeEntries<V>(obj: Record<string, V> | undefined | null): [string, V][] {
  return obj ? Object.entries(obj) : []
}

export function safeKeys(obj: Record<string, unknown> | undefined | null): string[] {
  return obj ? Object.keys(obj) : []
}

// ============================================================================
// Command Definition
// ============================================================================

export const usageReport: Command = {
  type: 'prompt',
  name: 'insights',
  description: 'Generate a report analyzing your ZY Code sessions',
  contentLength: 0, // Dynamic content
  progressMessage: 'analyzing your sessions',
  source: 'builtin',
  async getPromptForCommand(args) {
    let collectRemote = false
    let remoteHosts: string[] = []
    let hasRemoteHosts = false

    if (isInternalBuild()) {
      // Parse --homespaces flag
      collectRemote = args?.includes('--homespaces') ?? false

      // Check for available remote hosts
      remoteHosts = await getRunningRemoteHosts()
      hasRemoteHosts = remoteHosts.length > 0

      // Show collection message if collecting
      if (collectRemote && hasRemoteHosts) {
        // biome-ignore lint/suspicious/noConsole: intentional
        console.error(
          `Collecting sessions from ${remoteHosts.length} homespace(s): ${remoteHosts.join(', ')}...`,
        )
      }
    }

    const { insights, htmlPath, data, remoteStats } = await generateUsageReport({ collectRemote })

    const reportUrl = `file://${htmlPath}`
    const uploadHint = ''

    // TODO: 自建报告存储服务后恢复内部上传逻辑（原 ant.dev S3 不可访问）
    // if (isInternalBuild()) {
    //   const timestamp = new Date()
    //     .toISOString()
    //     .replace(/[-:]/g, '')
    //     .replace('T', '_')
    //     .slice(0, 15)
    //   const username = process.env.SAFEUSER || process.env.USER || 'unknown'
    //   const filename = `${username}_insights_${timestamp}.html`
    //   const s3Path = `s3://anthropic-serve/atamkin/cc-user-reports/${filename}`
    //   const s3Url = `https://s3-frontend.infra.ant.dev/anthropic-serve/atamkin/cc-user-reports/${filename}`
    //   reportUrl = s3Url
    //   try {
    //     execFileSync('ff', ['cp', htmlPath, s3Path], {
    //       timeout: 60000,
    //       stdio: 'pipe',
    //     })
    //   } catch {
    //     reportUrl = `file://${htmlPath}`
    //     uploadHint = `\nAutomatic upload failed. Are you on the boron namespace? Try \`use-bo\` and ensure you've run \`sso\`.
    // To share, run: ff cp ${htmlPath} ${s3Path}
    // Then access at: ${s3Url}`
    //   }
    // }

    // Build header with stats
    const sessionLabel =
      data.total_sessions_scanned && data.total_sessions_scanned > data.total_sessions
        ? `${data.total_sessions_scanned.toLocaleString()} sessions total · ${data.total_sessions} analyzed`
        : `${data.total_sessions} sessions`
    const stats = [
      sessionLabel,
      `${data.total_messages.toLocaleString()} messages`,
      `${Math.round(data.total_duration_hours)}h`,
      `${data.git_commits} commits`,
    ].join(' · ')

    // Build remote host info (ant-only)
    let remoteInfo = ''
    if (isInternalBuild()) {
      if (remoteStats && remoteStats.totalCopied > 0) {
        const hsNames = remoteStats.hosts
          .filter((h) => h.sessionCount > 0)
          .map((h) => h.name)
          .join(', ')
        remoteInfo = `\n_Collected ${remoteStats.totalCopied} new sessions from: ${hsNames}_\n`
      } else if (!collectRemote && hasRemoteHosts) {
        // Suggest using --homespaces if they have remote hosts but didn't use the flag
        remoteInfo = `\n_Tip: Run \`/insights --homespaces\` to include sessions from your ${remoteHosts.length} running homespace(s)_\n`
      }
    }

    // Build markdown summary from insights
    const atAGlance = insights.at_a_glance
    const summaryText = atAGlance
      ? `## At a Glance

${atAGlance.whats_working ? `**What's working:** ${atAGlance.whats_working} See _Impressive Things You Did_.` : ''}

${atAGlance.whats_hindering ? `**What's hindering you:** ${atAGlance.whats_hindering} See _Where Things Go Wrong_.` : ''}

${atAGlance.quick_wins ? `**Quick wins to try:** ${atAGlance.quick_wins} See _Features to Try_.` : ''}

${atAGlance.ambitious_workflows ? `**Ambitious workflows:** ${atAGlance.ambitious_workflows} See _On the Horizon_.` : ''}`
      : '_No insights generated_'

    const header = `# ZY Code Insights

${stats}
${data.date_range.start} to ${data.date_range.end}
${remoteInfo}
`

    const userSummary = `${header}${summaryText}

Your full shareable insights report is ready: ${reportUrl}${uploadHint}`

    // Return prompt for Zy to respond to
    return [
      {
        type: 'text',
        text: `The user just ran /insights to generate a usage report analyzing their ZY Code sessions.

Here is the full insights data:
${jsonStringify(insights, null, 2)}

Report URL: ${reportUrl}
HTML file: ${htmlPath}
Facets directory: ${getFacetsDir()}

Here is what the user sees:
${userSummary}

Now output the following message exactly:

<message>
Your shareable insights report is ready:
${reportUrl}${uploadHint}

Want to dig into any section or try one of the suggestions?
</message>`,
      },
    ]
  },
}

export function isValidSessionFacets(obj: unknown): obj is SessionFacets {
  if (!obj || typeof obj !== 'object') {
    return false
  }
  const o = obj as Record<string, unknown>
  return (
    typeof o.underlying_goal === 'string' &&
    typeof o.outcome === 'string' &&
    typeof o.brief_summary === 'string' &&
    o.goal_categories !== null &&
    typeof o.goal_categories === 'object' &&
    o.user_satisfaction_counts !== null &&
    typeof o.user_satisfaction_counts === 'object' &&
    o.friction_counts !== null &&
    typeof o.friction_counts === 'object'
  )
}

export default usageReport
