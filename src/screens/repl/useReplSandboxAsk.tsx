// Sandbox 权限询问回调 + 初始化副作用 + 不可用通知。
// 抽自 screens/REPL.tsx 2123-2276：
//
// 1. sandboxAskCallback：sandbox-adapter 的网络放行回调。两条路径：
//    - swarm worker：通过 mailbox 把请求转发给 leader，注册回调等响应；
//      mailbox 不可达则回退本地处理
//    - 非 worker：本地排队 sandboxPermissionRequestQueue 渲染 UI；BRIDGE_MODE
//      下并发把请求转发给 REPL bridge（远程控制），任一侧先响应就解掉
//      所有相同 host 的待处理请求，并清掉所有兄弟 bridge 订阅
// 2. SandboxManager.getSandboxUnavailableReason effect：mount 时检查依赖缺失
//    场景 — failIfUnavailable 直接退出；否则发一次 medium 通知指向 /sandbox
// 3. 在渲染中调用 SandboxManager.initialize(sandboxAskCallback)（管理器内
//    部幂等），把回调装进沙盒适配器
//
// `sandboxWireCleanupRef` 由 hook 内部 useRef 创建并 export，因为本地
// 对话框 approval 处理（REPL JSX 中）也要遍历清理同 host 的兄弟订阅。

import { feature } from 'bun:bundle'
import { randomUUID } from 'node:crypto'
import { useCallback, useEffect, useRef } from 'react'
import { SANDBOX_NETWORK_ACCESS_TOOL_NAME } from '../../cli/structuredIO.js'
import type { Notification } from '../../context/notifications.js'
import { registerSandboxPermissionCallback } from '../../hooks/useSwarmPermissionPoller.js'
import { Text } from '../../ink/index.js'
import {
  type NetworkHostPattern,
  type SandboxAskCallback,
  SandboxManager,
} from '../../services/sandbox/sandboxAdapter.js'
import {
  generateSandboxRequestId,
  isSwarmWorker,
  sendSandboxPermissionRequestViaMailbox,
} from '../../services/swarm/permissionSync.js'
import { useAppStateStore, useSetAppState } from '../../state/AppState.js'
import { isAgentSwarmsEnabled } from '../../services/swarm/agentSwarmsEnabled.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { gracefulShutdownSync } from '../../utils/gracefulShutdown.js'

export type SandboxPermissionRequest = {
  hostPattern: NetworkHostPattern
  resolvePromise: (allowConnection: boolean) => void
}

export type UseReplSandboxAskParams = {
  setSandboxPermissionRequestQueue: React.Dispatch<React.SetStateAction<SandboxPermissionRequest[]>>
  addNotification: (n: Notification) => void
}

export type UseReplSandboxAskResult = {
  /** 由本地对话框 approval 路径共享，按 host 取出兄弟 bridge 清理函数 */
  sandboxWireCleanupRef: React.RefObject<Map<string, Array<() => void>>>
}

export function useReplSandboxAsk({
  setSandboxPermissionRequestQueue,
  addNotification,
}: UseReplSandboxAskParams): UseReplSandboxAskResult {
  const setAppState = useSetAppState()
  const store = useAppStateStore()
  const sandboxWireCleanupRef = useRef<Map<string, Array<() => void>>>(new Map())

  const sandboxAskCallback: SandboxAskCallback = useCallback(
    async (hostPattern: NetworkHostPattern) => {
      // worker → mailbox 转发到 leader
      if (isAgentSwarmsEnabled() && isSwarmWorker()) {
        const requestId = generateSandboxRequestId()
        const sent = await sendSandboxPermissionRequestViaMailbox(hostPattern.host, requestId)
        return new Promise((resolveShouldAllowHost) => {
          if (!sent) {
            // mailbox 不可达回退本地
            setSandboxPermissionRequestQueue((prev) => [
              ...prev,
              { hostPattern, resolvePromise: resolveShouldAllowHost },
            ])
            return
          }
          registerSandboxPermissionCallback({
            requestId,
            host: hostPattern.host,
            resolve: resolveShouldAllowHost,
          })
          setAppState((prev) => ({
            ...prev,
            pendingSandboxRequest: { requestId, host: hostPattern.host },
          }))
        })
      }

      // 非 worker：本地 UI + 可选 bridge 远程控制竞争
      return new Promise((resolveShouldAllowHost) => {
        let resolved = false
        const resolveOnce = (allow: boolean): void => {
          if (resolved) {
            return
          }
          resolved = true
          resolveShouldAllowHost(allow)
        }

        setSandboxPermissionRequestQueue((prev) => [
          ...prev,
          { hostPattern, resolvePromise: resolveOnce },
        ])

        // BRIDGE_MODE：把请求作为 can_use_tool control_request 转给远端
        if (feature('BRIDGE_MODE')) {
          const bridgeCallbacks = store.getState().replWirePermissionCallbacks
          if (bridgeCallbacks) {
            const bridgeRequestId = randomUUID()
            bridgeCallbacks.sendRequest(
              bridgeRequestId,
              SANDBOX_NETWORK_ACCESS_TOOL_NAME,
              { host: hostPattern.host },
              randomUUID(),
              `Allow network connection to ${hostPattern.host}?`,
            )
            const unsubscribe = bridgeCallbacks.onResponse(bridgeRequestId, (response) => {
              unsubscribe()
              const allow = response.behavior === 'allow'
              // 解析 ALL 同 host 的待处理请求，镜像本地对话框路径
              setSandboxPermissionRequestQueue((queue) => {
                queue
                  .filter((item) => item.hostPattern.host === hostPattern.host)
                  .forEach((item) => item.resolvePromise(allow))
                return queue.filter((item) => item.hostPattern.host !== hostPattern.host)
              })
              const siblingCleanups = sandboxWireCleanupRef.current.get(hostPattern.host)
              if (siblingCleanups) {
                for (const fn of siblingCleanups) {
                  fn()
                }
                sandboxWireCleanupRef.current.delete(hostPattern.host)
              }
            })

            // 注册清理：本地对话框先响应时取消远程订阅
            const cleanup = () => {
              unsubscribe()
              bridgeCallbacks.cancelRequest(bridgeRequestId)
            }
            const existing = sandboxWireCleanupRef.current.get(hostPattern.host) ?? []
            existing.push(cleanup)
            sandboxWireCleanupRef.current.set(hostPattern.host, existing)
          }
        }
      })
    },
    [setAppState, setSandboxPermissionRequestQueue, store],
  )

  // #34044：sandbox.enabled=true 但依赖缺失时 isSandboxingEnabled 静默返回
  // false。mount 一次显示原因；failIfUnavailable 则直接 graceful shutdown。
  // addNotification 稳定（useCallback）所以 effect 仅触发一次。
  useEffect(() => {
    const reason = SandboxManager.getSandboxUnavailableReason()
    if (!reason) {
      return
    }
    if (SandboxManager.isSandboxRequired()) {
      process.stderr.write(
        `\nError: sandbox required but unavailable: ${reason}\n` +
          `  sandbox.failIfUnavailable is set — refusing to start without a working sandbox.\n\n`,
      )
      gracefulShutdownSync(1, 'other')
      return
    }
    logForDebugging(`sandbox disabled: ${reason}`, { level: 'warn' })
    addNotification({
      key: 'sandbox-unavailable',
      jsx: (
        <>
          <Text color="warning">sandbox disabled</Text>
          <Text dimColor> · /sandbox</Text>
        </>
      ),
      priority: 'medium',
    })
  }, [addNotification])

  // SandboxManager.initialize 每次渲染调用（内部幂等）；失败则 graceful exit
  if (SandboxManager.isSandboxingEnabled()) {
    SandboxManager.initialize(sandboxAskCallback).catch((err) => {
      process.stderr.write(`\n❌ Sandbox Error: ${errorMessage(err)}\n`)
      gracefulShutdownSync(1, 'other')
    })
  }

  return { sandboxWireCleanupRef }
}
