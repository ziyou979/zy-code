import * as React from 'react'
import type { LocalJSXCommandContext } from '../../commands/index.js'
import type { LocalJSXCommandOnDone } from '../types.js'
import { openBrowser } from '../../services/browser/browser.js'
import { logError } from '../../utils/log.js'
import { Login } from '../login/login.js'
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode | null> {
  try {
    const url = 'https://zy.ai/upgrade/max'
    await openBrowser(url)
    return (
      <Login
        startingMessage={
          'Starting new login following /upgrade. Exit with Ctrl-C to use existing account.'
        }
        onDone={(success: boolean) => {
          context.onChangeAPIKey()
          onDone(success ? 'Login successful' : 'Login interrupted')
        }}
      />
    )
  } catch (error) {
    logError(error as Error)
    setTimeout(
      onDone,
      0,
      'Failed to open browser. Please visit https://zy.ai/upgrade/max to upgrade.',
    )
  }
  return null
}
