import React from 'react';
import { tSync } from '../i18n/index.js';
import { Link, Text } from '../ink.js';
export function MCPServerDialogCopy() {
  return <Text>{tSync('mcpServer.warning')}</Text>;
}
