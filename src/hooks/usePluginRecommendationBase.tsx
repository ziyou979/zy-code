/**
 * 插件推荐 hook（LSP、zy-code-hint）共用的状态机和安装辅助逻辑。
 * 集中处理门控链、异步保护以及成功/失败通知 JSX，让新增推荐来源保持精简。
 */

import * as React from 'react'
import { getIsRemoteMode } from 'src/bootstrap/runtime/runtimeContext.js'
import { TICK } from '../constants/figures.js'
import type { useNotifications } from '../context/notifications.js'
import { Text } from '../ink/index.js'
import { logError } from '../services/infra/log.js'
import { getPluginById } from '../services/plugins/marketplaceManager.js'

type AddNotification = ReturnType<typeof useNotifications>['addNotification']
type PluginData = NonNullable<Awaited<ReturnType<typeof getPluginById>>>

/**
 * 在 useEffect 内调用 tryResolve；它先应用标准门控（remote 模式、已有展示、正在处理），
 * 再运行 resolve()，非 null 返回值会成为推荐项。effect 依赖中需包含 tryResolve；
 * 它的引用会随 recommendation 变化，因此清除推荐后会重新触发解析。
 */
export function usePluginRecommendationBase<T>() {
  const [recommendation, setRecommendation] = React.useState<T | null>(null)
  const isCheckingRef = React.useRef(false)
  const tryResolve = (resolve: () => Promise<T | null | undefined>) => {
    if (getIsRemoteMode()) {
      return
    }
    if (recommendation) {
      return
    }
    if (isCheckingRef.current) {
      return
    }
    isCheckingRef.current = true
    resolve()
      .then((rec: T | null | undefined) => {
        if (rec) {
          setRecommendation(rec)
        }
      })
      .catch(logError)
      .finally(() => {
        isCheckingRef.current = false
      })
  }
  const clearRecommendation = () => setRecommendation(null)
  return {
    recommendation,
    clearRecommendation,
    tryResolve,
  }
}

/** 查找插件、运行 install()，并发出标准的成功或失败通知。 */
export async function installPluginAndNotify(
  pluginId: string,
  pluginName: string,
  keyPrefix: string,
  addNotification: AddNotification,
  install: (pluginData: PluginData) => Promise<void>,
): Promise<void> {
  try {
    const pluginData = await getPluginById(pluginId)
    if (!pluginData) {
      throw new Error(`Plugin ${pluginId} not found in marketplace`)
    }
    await install(pluginData)
    addNotification({
      key: `${keyPrefix}-installed`,
      jsx: (
        <Text color="success">
          {TICK} {pluginName} installed · restart to apply
        </Text>
      ),
      priority: 'immediate',
      timeoutMs: 5000,
    })
  } catch (error) {
    logError(error)
    addNotification({
      key: `${keyPrefix}-install-failed`,
      jsx: <Text color="error">Failed to install {pluginName}</Text>,
      priority: 'immediate',
      timeoutMs: 5000,
    })
  }
}
