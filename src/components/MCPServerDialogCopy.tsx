import { tSync } from '../i18n/index.js'
import { Text } from '../ink/index.js'
export function MCPServerDialogCopy() {
  return <Text>{tSync('mcpServer.warning')}</Text>
}
