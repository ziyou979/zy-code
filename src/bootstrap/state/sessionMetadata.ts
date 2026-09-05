// sessionMetadata 领域的运行时状态访问器。

import { STATE } from './core.js'

export function getPlanSlugCache(): Map<string, string> {
  return STATE.planSlugCache
}

export function getSessionCreatedTeams(): Set<string> {
  return STATE.sessionCreatedTeams
}
