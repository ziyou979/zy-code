// viewed-agent bootstrap effect。
// 抽自 screens/REPL.tsx 556-590：当用户切换到一个 retain=true 但尚未 diskLoaded
// 的 local_agent task 时，从 sidechain JSONL 读取磁盘消息，与 stream 已追加的
// live 消息按 UUID 合并，把前缀（disk-only）拼到当前消息列表前面。
//
// 不变量：
// - Stream 在 retain 时立即追加（不延迟）；本 bootstrap 只负责填充前缀。
// - 磁盘写入先于 yield，所以 live 始终是 disk 的后缀。
// - 合并按 UUID 去重，避免 disk 与 live 重叠部分被打印两次。

import { useEffect } from 'react'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { asAgentId } from '../../types/ids.js'
import { getAgentTranscript } from '../../utils/sessionStorage.js'

export function useViewedAgentBootstrap(): void {
  const viewingAgentTaskId = useAppState((s) => s.viewingAgentTaskId)
  const tasks = useAppState((s) => s.tasks)
  const setAppState = useSetAppState()

  const viewedLocalAgent = viewingAgentTaskId ? tasks[viewingAgentTaskId] : undefined
  const needsBootstrap =
    isLocalAgentTask(viewedLocalAgent) && viewedLocalAgent.retain && !viewedLocalAgent.diskLoaded

  useEffect(() => {
    if (!viewingAgentTaskId || !needsBootstrap) {
      return
    }
    const taskId = viewingAgentTaskId
    void getAgentTranscript(asAgentId(taskId)).then((result) => {
      setAppState((prev) => {
        const t = prev.tasks[taskId]
        if (!isLocalAgentTask(t) || t.diskLoaded || !t.retain) {
          return prev
        }
        const live = t.messages ?? []
        const liveUuids = new Set(live.map((m) => m.uuid))
        const diskOnly = result ? result.messages.filter((m) => !liveUuids.has(m.uuid)) : []
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [taskId]: {
              ...t,
              messages: [...diskOnly, ...live],
              diskLoaded: true,
            },
          },
        }
      })
    })
  }, [viewingAgentTaskId, needsBootstrap, setAppState])
}
