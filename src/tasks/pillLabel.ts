import { DIAMOND_FILLED, DIAMOND_OPEN } from '../constants/figures.js'
import { tSync } from '../i18n/index.js'
import { count } from '../utils/array.js'
import type { BackgroundTaskState } from './types.js'

/**
 * Produces the compact footer-pill label for a set of background tasks.
 * Used by both the footer pill and the turn-duration transcript line so the
 * two surfaces agree on terminology.
 */
export function getPillLabel(tasks: BackgroundTaskState[]): string {
  const n = tasks.length
  const allSameType = tasks.every((t) => t.type === tasks[0]!.type)

  if (allSameType) {
    switch (tasks[0]!.type) {
      case 'local_bash': {
        const monitors = count(tasks, (t) => t.type === 'local_bash' && t.kind === 'monitor')
        const shells = n - monitors
        const parts: string[] = []
        if (shells > 0) {
          parts.push(tSync(shells === 1 ? 'pill.shell_one' : 'pill.shell_other', { count: shells }))
        }
        if (monitors > 0) {
          parts.push(
            tSync(monitors === 1 ? 'pill.monitor_one' : 'pill.monitor_other', { count: monitors }),
          )
        }
        return parts.join(', ')
      }
      case 'in_process_teammate': {
        const teamCount = new Set(
          tasks.map((t) => (t.type === 'in_process_teammate' ? t.identity.teamName : '')),
        ).size
        return tSync(teamCount === 1 ? 'pill.team_one' : 'pill.team_other', { count: teamCount })
      }
      case 'local_agent':
        return tSync(n === 1 ? 'pill.localAgent_one' : 'pill.localAgent_other', { count: n })
      case 'remote_agent': {
        const first = tasks[0]!
        if (n === 1 && first.type === 'remote_agent' && first.isUltraplan) {
          switch (first.ultraplanPhase) {
            case 'plan_ready':
              return `${DIAMOND_FILLED} ${tSync('pill.ultraplanReady')}`
            case 'needs_input':
              return `${DIAMOND_OPEN} ${tSync('pill.ultraplanNeedsInput')}`
            default:
              return `${DIAMOND_OPEN} ${tSync('pill.ultraplan')}`
          }
        }
        return tSync(n === 1 ? 'pill.cloudSession_one' : 'pill.cloudSession_other', { count: n })
      }
      case 'local_workflow':
        return tSync(n === 1 ? 'pill.backgroundWorkflow_one' : 'pill.backgroundWorkflow_other', {
          count: n,
        })
      case 'monitor_mcp':
        return tSync(n === 1 ? 'pill.monitor_one' : 'pill.monitor_other', { count: n })
      case 'dream':
        return tSync('pill.dreaming')
    }
  }

  return tSync(n === 1 ? 'pill.backgroundTask_one' : 'pill.backgroundTask_other', { count: n })
}

/**
 * True when the pill should show the dimmed " · ↓ to view" call-to-action.
 * Per the state diagram: only the two attention states (needs_input,
 * plan_ready) surface the CTA; plain running shows just the diamond + label.
 */
export function pillNeedsCta(tasks: BackgroundTaskState[]): boolean {
  if (tasks.length !== 1) {
    return false
  }
  const t = tasks[0]!
  return t.type === 'remote_agent' && t.isUltraplan === true && t.ultraplanPhase !== undefined
}
