import React from 'react';
import { tSync } from '../../i18n/index.js';
import type { Input } from './TeamCreateTool.js';
export function renderToolUseMessage(input: Partial<Input>): React.ReactNode {
  return `${tSync('toolTeamCreate.createTeam')} ${input.team_name}`;
}
