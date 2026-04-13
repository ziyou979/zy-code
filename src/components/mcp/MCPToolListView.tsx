import React from 'react';
import { Text } from '../../ink.js';
import { extractMcpToolDisplayName, getMcpDisplayName } from '../../services/mcp/mcpStringUtils.js';
import { filterToolsByServer } from '../../services/mcp/utils.js';
import { useAppState } from '../../state/AppState.js';
import type { Tool } from '../../Tool.js';
import { plural } from '../../utils/stringUtils.js';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';
import { Select } from '../CustomSelect/index.js';
import { Byline } from '../design-system/Byline.js';
import { Dialog } from '../design-system/Dialog.js';
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js';
import type { ServerInfo } from './types.js';
type Props = {
  server: ServerInfo;
  onSelectTool: (tool: Tool, index: number) => void;
  onBack: () => void;
};
export function MCPToolListView({
  server,
  onSelectTool,
  onBack
}: Props) {
  const mcpTools = useAppState(s => s.mcp.tools);
  let serverTools;
  if (server.client.type !== "connected") {
    serverTools = [];
  } else {
    serverTools = filterToolsByServer(mcpTools, server.name);
  }
  const toolOptions = serverTools.map((tool, index) => {
    const toolName = getMcpDisplayName(tool.name, server.name);
    const fullDisplayName = tool.userFacingName ? tool.userFacingName({}) : toolName;
    const displayName = extractMcpToolDisplayName(fullDisplayName);
    const isReadOnly = tool.isReadOnly?.({}) ?? false;
    const isDestructive = tool.isDestructive?.({}) ?? false;
    const isOpenWorld = tool.isOpenWorld?.({}) ?? false;
    const annotations = [];
    if (isReadOnly) {
      annotations.push("read-only");
    }
    if (isDestructive) {
      annotations.push("destructive");
    }
    if (isOpenWorld) {
      annotations.push("open-world");
    }
    return {
      label: displayName,
      value: index.toString(),
      description: annotations.length > 0 ? annotations.join(", ") : undefined,
      descriptionColor: isDestructive ? "error" : isReadOnly ? "success" : undefined
    };
  });
  const t5 = plural(serverTools.length, "tool");
  return <Dialog title={`Tools for ${server.name}`} subtitle={`${serverTools.length} ${t5}`} onCancel={onBack} inputGuide={exitState => exitState.pending ? <Text>Press {exitState.keyName} again to exit</Text> : <Byline><KeyboardShortcutHint shortcut={"\u2191\u2193"} action="navigate" /><KeyboardShortcutHint shortcut="Enter" action="select" /><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="back" /></Byline>}>{serverTools.length === 0 ? <Text dimColor={true}>No tools available</Text> : <Select options={toolOptions} onChange={value => {
      const index_0 = parseInt(value);
      const tool_0 = serverTools[index_0];
      if (tool_0) {
        onSelectTool(tool_0, index_0);
      }
    }} onCancel={onBack} />}</Dialog>;
}
