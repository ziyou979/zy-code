import type { LocalJSXCommandCall } from '../types.js'
export const call: LocalJSXCommandCall = async (onDone, context) => {
  const { DiffDialog } = await import('../../components/diff/DiffDialog.js')
  return <DiffDialog messages={context.messages} onDone={onDone} />
}
