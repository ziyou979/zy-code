import { Help } from '../../components/Help/Help.js'
import type { LocalJSXCommandCall } from '../types.js'
export const call: LocalJSXCommandCall = async (onDone, { options: { commands } }) => {
  return <Help commands={commands} onClose={onDone} />
}
