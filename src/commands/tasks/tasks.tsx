import * as React from 'react'
import type { LocalJSXCommandContext } from '../../commands/index.js'
import { BackgroundTasksDialog } from '../../components/tasks/BackgroundTasksDialog.js'
import type { LocalJSXCommandOnDone } from '../types.js'
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return <BackgroundTasksDialog toolUseContext={context} onDone={onDone} />
}
