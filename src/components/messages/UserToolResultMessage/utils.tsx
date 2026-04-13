import type { ToolUseBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import { useMemo } from 'react';
import { findToolByName, type Tool, type Tools } from '../../../Tool.js';
import type { buildMessageLookups } from '../../../utils/messages.js';
export function useGetToolFromMessages(toolUseID, tools, lookups) {
  let t0;
  const toolUse = lookups.toolUseByToolUseID.get(toolUseID);
  if (!toolUse) {
    t0 = null;
  } else {
    const tool = findToolByName(tools, toolUse.name);
    if (!tool) {
      t0 = null;
    } else {
      t0 = {
        tool,
        toolUse
      };
    }
  }
  return t0;
}
