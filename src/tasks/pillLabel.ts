import { DIAMOND_FILLED, DIAMOND_OPEN } from '../constants/figures.js'
import { tSync } from '../i18n/index.js'
import { count } from '../utils/array.js'
import type { BackgroundTaskState } from './types.js'

/**
 * 为一组后台 task 生成紧凑的页脚 pill 标签。
 * 页脚 pill 与 turn-duration transcript 行共同使用，确保两处术语一致。
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
 * pill 应显示弱化的“ · ↓ to view”操作提示时返回 true。
 * 按状态图，只有 needs_input、plan_ready 两种需关注状态显示 CTA；
 * 普通 running 状态只显示菱形和标签。
 */
export function pillNeedsCta(_tasks: BackgroundTaskState[]): boolean {
  // 唯一触发 CTA 的任务类型（remote_agent/ultraplan）已随远端会话栈移除。
  return false
}
