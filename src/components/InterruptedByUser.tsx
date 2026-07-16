import { tSync } from '../i18n/index.js'
import { Text } from '../ink/index.js'
export function InterruptedByUser() {
  return (
    <>
      <Text dimColor={true}>{tSync('interruptedByUser.label')} </Text>
      {false ? (
        <Text dimColor={true}>· [INNER-ONLY] /issue to report a model issue</Text>
      ) : (
        <Text dimColor={true}>· {tSync('interruptedByUser.whatNext')}</Text>
      )}
    </>
  )
}
