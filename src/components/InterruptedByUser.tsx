import * as React from 'react';
import { tSync } from '../i18n/index.js';
import { Text } from '../ink.js';
export function InterruptedByUser() {
  return <><Text dimColor={true}>{tSync('interruptedByUser.label')} </Text>{false ? <Text dimColor={true}>· [ANT-ONLY] /issue to report a model issue</Text> : <Text dimColor={true}>· {tSync('interruptedByUser.whatNext')}</Text>}</>;
}
