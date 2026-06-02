/**
 * 跨模块共享的延迟 / feature-gated 模块引用。
 *
 * 拆出独立文件的两个原因：
 * 1. **避免循环依赖**：teammate / swarm / assistant 子树会反向引用 main.tsx，
 *    所以这些模块都通过 `() => require(...)` 包一层延迟加载。
 * 2. **构建期 dead-code elimination**：bun 的 `feature('X')` 宏要求直接出现在
 *    `if` / 三元的条件位置才能被 DCE。因此 `feature('X') ? require : null`
 *    必须保留这种字面形态 —— 不能合并到 `&&` / `??` 等表达式里，也不能赋给
 *    中间变量再判断。
 *
 * 在任何 caller 模块（main.tsx、cli/commands/root.ts 等）import 这里的符号
 * 都不影响 DCE，因为 `feature()` 调用仍然在本模块内、并且仍然在三元条件位置。
 */

// biome-ignore-all lint/suspicious/noExplicitAny: bun:bundle macro file
import { feature } from 'bun:bundle'

/* eslint-disable @typescript-eslint/no-require-imports */
// 延迟加载以避免循环依赖：teammate.ts -> AppState.tsx -> ... -> main.tsx
export const getTeammateUtils = () =>
  require('../utils/teammate.js') as typeof import('../utils/teammate.js')
export const getTeammatePromptAddendum = () =>
  require('../services/swarm/teammatePromptAddendum.js') as typeof import('../services/swarm/teammatePromptAddendum.js')
export const getTeammateModeSnapshot = () =>
  require('../services/swarm/backends/teammateModeSnapshot.js') as typeof import('../services/swarm/backends/teammateModeSnapshot.js')
/* eslint-enable @typescript-eslint/no-require-imports */

// 死代码消除：COORDINATOR_MODE 的条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
export const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? (require('../coordinator/coordinatorMode.js') as typeof import('../coordinator/coordinatorMode.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

// 死代码消除：KAIROS（助手模式）的条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
export const assistantModule = feature('KAIROS')
  ? (require('../assistant/index.js') as typeof import('../assistant/index.js'))
  : null

// 辅助函数：在 KAIROS 已守卫的代码块中安全获取 assistant 模块
export function getAssistant() {
  return assistantModule!
}

export const kairosGate = feature('KAIROS')
  ? (require('../assistant/gate.js') as typeof import('../assistant/gate.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

// 死代码消除：TRANSCRIPT_CLASSIFIER 自动模式 state 模块
/* eslint-disable @typescript-eslint/no-require-imports */
export const autoModeStateModule = true
  ? (require('../utils/permissions/autoModeState.js') as typeof import('../utils/permissions/autoModeState.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

// 死代码消除：proactive / loop 模式（PROACTIVE 或 KAIROS 任一启用即生效）
/* eslint-disable @typescript-eslint/no-require-imports */
export const proactiveModule =
  feature('PROACTIVE') || feature('KAIROS')
    ? (require('../proactive/index.js') as typeof import('../proactive/index.js'))
    : null
/* eslint-enable @typescript-eslint/no-require-imports */
