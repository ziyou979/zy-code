import { findToolByName } from '../../../Tool.js';
export function useGetToolFromMessages(toolUseID, tools, lookups) {

  const toolUse = lookups.toolUseByToolUseID.get(toolUseID);
  if (!toolUse) {

  } else {
    const tool = findToolByName(tools, toolUse.name);
    if (!tool) {

    } else {
      t0 = {
        tool,
        toolUse
      };
    }
  }
  return null;
}