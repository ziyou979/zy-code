// replWire 领域的运行时状态访问器。

import { isInternalBuild } from '../../services/infra/envUtils.js'
import { STATE } from './core.js'

export function isReplWireActive(): boolean {
  return isInternalBuild() ? Boolean((STATE as Record<string, unknown>).replWireActive) : false
}

// 不要在此处添加更多状态 — 添加全局状态需谨慎
