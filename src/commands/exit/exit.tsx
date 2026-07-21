import { feature } from 'bun:bundle'
import { spawnSync } from 'node:child_process'
import sample from 'lodash-es/sample.js'
import * as React from 'react'
import { ExitFlow } from '../../components/ExitFlow.js'
import type { LocalJSXCommandOnDone } from '../types.js'
import { isBgSession } from '../../services/session/concurrentSessions.js'
import { gracefulShutdown } from '../../bootstrap/lifecycle/gracefulShutdown.js'
import { getCurrentWorktreeSession } from '../../services/worktree/worktree.js'

const GOODBYE_MESSAGES = ['Goodbye!', 'See ya!', 'Bye!', 'Catch you later!']
function _getRandomGoodbyeMessage(): string {
  return sample(GOODBYE_MESSAGES) ?? 'Goodbye!'
}
export async function call(onDone: LocalJSXCommandOnDone): Promise<React.ReactNode> {
  // Inside a `zy --bg` tmux session: detach instead of kill. The REPL
  // keeps running; `zy attach` can reconnect. Covers /exit, /quit,
  // ctrl+c, ctrl+d — all funnel through here via REPL's handleExit.
  if (feature('BG_SESSIONS') && isBgSession()) {
    onDone()
    spawnSync('tmux', ['detach-client'], {
      stdio: 'ignore',
    })
    return null
  }
  const showWorktree = getCurrentWorktreeSession() !== null
  if (showWorktree) {
    return <ExitFlow showWorktree={showWorktree} onDone={onDone} onCancel={() => onDone()} />
  }
  await gracefulShutdown(0, 'prompt_input_exit')
  return null
}
