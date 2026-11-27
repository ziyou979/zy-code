import * as React from 'react'
import type { LocalJSXCommandContext } from '../../commands/index.js'
import { Feedback } from '../../components/Feedback.js'
import type { LocalJSXCommandOnDone } from '../types.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode> {
  return (
    <Feedback
      abortSignal={context.abortController.signal}
      initialDescription={args ?? ''}
      onDone={onDone}
    />
  )
}
