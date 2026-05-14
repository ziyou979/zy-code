import * as React from 'react'
import { Help } from '../../components/Help/Help'
import type { LocalJSXCommandCall } from '../../types/command.js'
export const call: LocalJSXCommandCall = async (onDone, { options: { commands } }) => {
  return <Help commands={commands} onClose={onDone} />
}
