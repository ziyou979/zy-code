import { performHeapDump } from '../../services/diagnostics/heapDumpService.js'
import { tSync } from '../../i18n/index.js'

export async function call(): Promise<{ type: 'text'; value: string }> {
  const result = await performHeapDump()

  if (!result.success) {
    return {
      type: 'text',
      value: tSync('commands.out.heapdump.failed', { error: String(result.error) }),
    }
  }

  return {
    type: 'text',
    value: [result.heapPath, result.heapAfterGcPath, result.diagPath].filter(Boolean).join('\n'),
  }
}
