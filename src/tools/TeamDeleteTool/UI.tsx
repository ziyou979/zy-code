import React from 'react'
import { tSync } from '../../i18n/index.js'
import { jsonParse } from '../../services/infra/slowOperations.js'
import type { Output } from './TeamDeleteTool.js'
export function renderToolUseMessage(_input: Record<string, unknown>): React.ReactNode {
  return `${tSync('toolTeamDelete.cleanupTeam')} current`
}
export function renderToolResultMessage(
  content: Output | string,
  _progressMessages: unknown,
  {
    verbose: _verbose,
  }: {
    verbose: boolean
  },
): React.ReactNode {
  const result: Output = typeof content === 'string' ? jsonParse(content) : content

  // Suppress cleanup result - the batched shutdown message covers this
  if ('success' in result && 'team_name' in result && 'message' in result) {
    return null
  }
  return null
}
