import { constants as fsConstants } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { getDefaultAdvancedModel } from '../../services/model/model.js'
import { getZyConfigHomeDir, isInternalBuild } from '../../utils/envUtils.js'
import { execFileNoThrow } from '../../services/shell/execFileNoThrow.js'
import { jsonParse } from '../../utils/slowOperations.js'
// Model for facet extraction and summarization (advanced - best quality)
export function getAnalysisModel(): string {
  return getDefaultAdvancedModel()!
}

// Model for narrative insights (advanced - best quality)
export function getInsightsModel(): string {
  return getDefaultAdvancedModel()!
}

// ============================================================================
// Homespace Data Collection
// ============================================================================

export type RemoteHostInfo = {
  name: string
  sessionCount: number
}

/* eslint-disable custom-rules/no-process-env-top-level */
export const getRunningRemoteHosts: () => Promise<string[]> = isInternalBuild()
  ? async () => {
      const { stdout, code } = await execFileNoThrow('coder', ['list', '-o', 'json'], {
        timeout: 30000,
      })
      if (code !== 0) {
        return []
      }
      try {
        const workspaces = jsonParse(stdout) as Array<{
          name: string
          latest_build?: { status?: string }
        }>
        return workspaces.filter((w) => w.latest_build?.status === 'running').map((w) => w.name)
      } catch {
        return []
      }
    }
  : async () => []

export const getRemoteHostSessionCount: (hs: string) => Promise<number> = isInternalBuild()
  ? async (homespace: string) => {
      const { stdout, code } = await execFileNoThrow(
        'ssh',
        [`${homespace}.coder`, 'find /root/.zy/projects -name "*.jsonl" 2>/dev/null | wc -l'],
        { timeout: 30000 },
      )
      if (code !== 0) {
        return 0
      }
      return parseInt(stdout.trim(), 10) || 0
    }
  : async () => 0

export const collectFromRemoteHost: (
  hs: string,
  destDir: string,
) => Promise<{ copied: number; skipped: number }> = isInternalBuild()
  ? async (homespace: string, destDir: string) => {
      const result = { copied: 0, skipped: 0 }

      // Create temp directory
      const tempDir = await mkdtemp(join(tmpdir(), 'zy', 'zy-insights-hs-'))

      try {
        // SCP the projects folder
        const scpResult = await execFileNoThrow(
          'scp',
          ['-rq', `${homespace}.coder:/root/.zy/projects/`, tempDir],
          { timeout: 300000 },
        )
        if (scpResult.code !== 0) {
          // SCP failed
          return result
        }

        const projectsDir = join(tempDir, 'projects')
        let projectDirents: Awaited<ReturnType<typeof readdir>>
        try {
          // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
          projectDirents = (await readdir(projectsDir, { withFileTypes: true })) as any
        } catch {
          return result
        }

        // Merge into destination (parallel per project directory)
        await Promise.all(
          projectDirents.map(async (dirent) => {
            // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
            const projectName = (dirent as any).name
            const projectPath = join(projectsDir, projectName)

            // Skip if not a directory
            if (!dirent.isDirectory()) {
              return
            }

            const destProjectName = `${projectName}__${homespace}`
            const destProjectPath = join(destDir, destProjectName)

            try {
              await mkdir(destProjectPath, { recursive: true })
            } catch {
              // Directory may already exist
            }

            // Copy session files (skip existing)
            let files: Awaited<ReturnType<typeof readdir>>
            try {
              // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
              files = (await readdir(projectPath, { withFileTypes: true })) as any
            } catch {
              return
            }
            await Promise.all(
              files.map(async (fileDirent) => {
                // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
                const fileName = (fileDirent as any).name
                // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
                if (!(fileName as any).endsWith('.jsonl')) {
                  return
                }

                // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
                const srcFile = join(projectPath, fileName as any)
                // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
                const destFile = join(destProjectPath, fileName as any)

                try {
                  await copyFile(srcFile, destFile, fsConstants.COPYFILE_EXCL)
                  result.copied++
                } catch {
                  // EEXIST from COPYFILE_EXCL means dest already exists
                  result.skipped++
                }
              }),
            )
          }),
        )
      } finally {
        try {
          await rm(tempDir, { recursive: true, force: true })
        } catch {
          // Ignore cleanup errors
        }
      }

      return result
    }
  : async () => ({ copied: 0, skipped: 0 })

export const collectAllRemoteHostData: (destDir: string) => Promise<{
  hosts: RemoteHostInfo[]
  totalCopied: number
  totalSkipped: number
}> = isInternalBuild()
  ? async (destDir: string) => {
      const rHosts = await getRunningRemoteHosts()
      const result: RemoteHostInfo[] = []
      let totalCopied = 0
      let totalSkipped = 0

      // Collect from all hosts in parallel (SCP per host can take seconds)
      const hostResults = await Promise.all(
        rHosts.map(async (hs) => {
          const sessionCount = await getRemoteHostSessionCount(hs)
          if (sessionCount > 0) {
            const { copied, skipped } = await collectFromRemoteHost(hs, destDir)
            return { name: hs, sessionCount, copied, skipped }
          }
          return { name: hs, sessionCount, copied: 0, skipped: 0 }
        }),
      )

      for (const hr of hostResults) {
        result.push({ name: hr.name, sessionCount: hr.sessionCount })
        totalCopied += hr.copied
        totalSkipped += hr.skipped
      }

      return { hosts: result, totalCopied, totalSkipped }
    }
  : async () => ({ hosts: [], totalCopied: 0, totalSkipped: 0 })

/* eslint-enable custom-rules/no-process-env-top-level */

// ============================================================================
// Types
// ============================================================================

export type SessionMeta = {
  session_id: string
  project_path: string
  start_time: string
  duration_minutes: number
  user_message_count: number
  assistant_message_count: number
  tool_counts: Record<string, number>
  languages: Record<string, number>
  git_commits: number
  git_pushes: number
  input_tokens: number
  output_tokens: number
  first_prompt: string
  summary?: string
  // New stats
  user_interruptions: number
  user_response_times: number[]
  tool_errors: number
  tool_error_categories: Record<string, number>
  uses_task_agent: boolean
  uses_mcp: boolean
  uses_web_search: boolean
  uses_web_fetch: boolean
  // Additional stats
  lines_added: number
  lines_removed: number
  files_modified: number
  message_hours: number[]
  user_message_timestamps: string[] // ISO timestamps for multi-clauding detection
}

export type SessionFacets = {
  session_id: string
  underlying_goal: string
  goal_categories: Record<string, number>
  outcome: string
  user_satisfaction_counts: Record<string, number>
  zy_helpfulness: string
  session_type: string
  friction_counts: Record<string, number>
  friction_detail: string
  primary_success: string
  brief_summary: string
  user_instructions_to_Zy?: string[]
}

export type AggregatedData = {
  total_sessions: number
  total_sessions_scanned?: number
  sessions_with_facets: number
  date_range: { start: string; end: string }
  total_messages: number
  total_duration_hours: number
  total_input_tokens: number
  total_output_tokens: number
  tool_counts: Record<string, number>
  languages: Record<string, number>
  git_commits: number
  git_pushes: number
  projects: Record<string, number>
  goal_categories: Record<string, number>
  outcomes: Record<string, number>
  satisfaction: Record<string, number>
  helpfulness: Record<string, number>
  session_types: Record<string, number>
  friction: Record<string, number>
  success: Record<string, number>
  session_summaries: Array<{
    id: string
    date: string
    summary: string
    goal?: string
  }>
  // New aggregated stats
  total_interruptions: number
  total_tool_errors: number
  tool_error_categories: Record<string, number>
  user_response_times: number[]
  median_response_time: number
  avg_response_time: number
  sessions_using_task_agent: number
  sessions_using_mcp: number
  sessions_using_web_search: number
  sessions_using_web_fetch: number
  // Additional stats from Python reference
  total_lines_added: number
  total_lines_removed: number
  total_files_modified: number
  days_active: number
  messages_per_day: number
  message_hours: number[] // Hour of day for each user message (for time of day chart)
  // Multi-clauding stats (matching Python reference)
  multi_clauding: {
    overlap_events: number
    sessions_involved: number
    user_messages_during: number
  }
}

// ============================================================================
// Constants
// ============================================================================

export const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.py': 'Python',
  '.rb': 'Ruby',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.md': 'Markdown',
  '.json': 'JSON',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.sh': 'Shell',
  '.css': 'CSS',
  '.html': 'HTML',
}

// Label map for cleaning up category names (matching Python reference)
export const LABEL_MAP: Record<string, string> = {
  // Goal categories
  debug_investigate: 'Debug/Investigate',
  implement_feature: 'Implement Feature',
  fix_bug: 'Fix Bug',
  write_script_tool: 'Write Script/Tool',
  refactor_code: 'Refactor Code',
  configure_system: 'Configure System',
  create_pr_commit: 'Create PR/Commit',
  analyze_data: 'Analyze Data',
  understand_codebase: 'Understand Codebase',
  write_tests: 'Write Tests',
  write_docs: 'Write Docs',
  deploy_infra: 'Deploy/Infra',
  warmup_minimal: 'Cache Warmup',
  // Success factors
  fast_accurate_search: 'Fast/Accurate Search',
  correct_code_edits: 'Correct Code Edits',
  good_explanations: 'Good Explanations',
  proactive_help: 'Proactive Help',
  multi_file_changes: 'Multi-file Changes',
  handled_complexity: 'Multi-file Changes',
  good_debugging: 'Good Debugging',
  // Friction types
  misunderstood_request: 'Misunderstood Request',
  wrong_approach: 'Wrong Approach',
  buggy_code: 'Buggy Code',
  user_rejected_action: 'User Rejected Action',
  zy_got_blocked: 'Zy Got Blocked',
  user_stopped_early: 'User Stopped Early',
  wrong_file_or_location: 'Wrong File/Location',
  excessive_changes: 'Excessive Changes',
  slow_or_verbose: 'Slow/Verbose',
  tool_failed: 'Tool Failed',
  user_unclear: 'User Unclear',
  external_issue: 'External Issue',
  // Satisfaction labels
  frustrated: 'Frustrated',
  dissatisfied: 'Dissatisfied',
  likely_satisfied: 'Likely Satisfied',
  satisfied: 'Satisfied',
  happy: 'Happy',
  unsure: 'Unsure',
  neutral: 'Neutral',
  delighted: 'Delighted',
  // Session types
  single_task: 'Single Task',
  multi_task: 'Multi Task',
  iterative_refinement: 'Iterative Refinement',
  exploration: 'Exploration',
  quick_question: 'Quick Question',
  // Outcomes
  fully_achieved: 'Fully Achieved',
  mostly_achieved: 'Mostly Achieved',
  partially_achieved: 'Partially Achieved',
  not_achieved: 'Not Achieved',
  unclear_from_transcript: 'Unclear',
  // Helpfulness
  unhelpful: 'Unhelpful',
  slightly_helpful: 'Slightly Helpful',
  moderately_helpful: 'Moderately Helpful',
  very_helpful: 'Very Helpful',
  essential: 'Essential',
}

// Lazy getters: getZyConfigHomeDir() is memoized and reads process.env.
// Calling it at module scope would populate the memoize cache before
// entrypoints can set ZY_CONFIG_DIR, breaking all 150+ other callers.
export function getDataDir(): string {
  return join(getZyConfigHomeDir(), 'usage-data')
}

export function getFacetsDir(): string {
  return join(getDataDir(), 'facets')
}

export function getSessionMetaDir(): string {
  return join(getDataDir(), 'session-meta')
}

export const FACET_EXTRACTION_PROMPT = `Analyze this ZY Code session and extract structured facets.

CRITICAL GUIDELINES:

1. **goal_categories**: Count ONLY what the USER explicitly asked for.
   - DO NOT count Zy's autonomous codebase exploration
   - DO NOT count work Zy decided to do on its own
   - ONLY count when user says "can you...", "please...", "I need...", "let's..."

2. **user_satisfaction_counts**: Base ONLY on explicit user signals.
   - "Yay!", "great!", "perfect!" → happy
   - "thanks", "looks good", "that works" → satisfied
   - "ok, now let's..." (continuing without complaint) → likely_satisfied
   - "that's not right", "try again" → dissatisfied
   - "this is broken", "I give up" → frustrated

3. **friction_counts**: Be specific about what went wrong.
   - misunderstood_request: Zy interpreted incorrectly
   - wrong_approach: Right goal, wrong solution method
   - buggy_code: Code didn't work correctly
   - user_rejected_action: User said no/stop to a tool call
   - excessive_changes: Over-engineered or changed too much

4. If very short or just warmup, use warmup_minimal for goal_category

SESSION:
`

// ============================================================================
// Helper Functions
// ============================================================================

export function getLanguageFromPath(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase()
  return EXTENSION_TO_LANGUAGE[ext] || null
}
