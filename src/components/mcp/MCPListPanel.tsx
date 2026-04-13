import figures from 'figures';
import React, { useState } from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import { Box, color, Link, Text, useTheme } from '../../ink.js';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import type { ConfigScope } from '../../services/mcp/types.js';
import { describeMcpConfigFilePath } from '../../services/mcp/utils.js';
import { isDebugMode } from '../../utils/debug.js';
import { plural } from '../../utils/stringUtils.js';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';
import { Byline } from '../design-system/Byline.js';
import { Dialog } from '../design-system/Dialog.js';
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js';
import { McpParsingWarnings } from './McpParsingWarnings.js';
import type { AgentMcpServerInfo, ServerInfo } from './types.js';
type Props = {
  servers: ServerInfo[];
  agentServers?: AgentMcpServerInfo[];
  onSelectServer: (server: ServerInfo) => void;
  onSelectAgentServer?: (agentServer: AgentMcpServerInfo) => void;
  onComplete: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  defaultTab?: string;
};
type SelectableItem = {
  type: 'server';
  server: ServerInfo;
} | {
  type: 'agent-server';
  agentServer: AgentMcpServerInfo;
};

// Define scope order for display (constant, outside component)
// 'dynamic' (built-in) is rendered separately at the end
const SCOPE_ORDER: ConfigScope[] = ['project', 'local', 'user', 'enterprise'];

// Get scope heading parts (label is bold, path is grey)
function getScopeHeading(scope: ConfigScope): {
  label: string;
  path?: string;
} {
  switch (scope) {
    case 'project':
      return {
        label: 'Project MCPs',
        path: describeMcpConfigFilePath(scope)
      };
    case 'user':
      return {
        label: 'User MCPs',
        path: describeMcpConfigFilePath(scope)
      };
    case 'local':
      return {
        label: 'Local MCPs',
        path: describeMcpConfigFilePath(scope)
      };
    case 'enterprise':
      return {
        label: 'Enterprise MCPs'
      };
    case 'dynamic':
      return {
        label: 'Built-in MCPs',
        path: 'always available'
      };
    default:
      return {
        label: scope
      };
  }
}

// Group servers by scope
function groupServersByScope(serverList: ServerInfo[]): Map<ConfigScope, ServerInfo[]> {
  const groups = new Map<ConfigScope, ServerInfo[]>();
  for (const server of serverList) {
    const scope = server.scope;
    if (!groups.has(scope)) {
      groups.set(scope, []);
    }
    groups.get(scope)!.push(server);
  }
  // Sort servers within each group alphabetically
  for (const [, groupServers] of groups) {
    groupServers.sort((a, b) => a.name.localeCompare(b.name));
  }
  return groups;
}
export function MCPListPanel({
  servers,
  agentServers: t2 = [],
  onSelectServer,
  onSelectAgentServer,
  onComplete
}) {
  const agentServers = t2;
  const [theme] = useTheme();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const regularServers = servers.filter(s => s.client.config.type !== "zyai-proxy");
  const serversByScope = groupServersByScope(regularServers);
  const zyAiServers = servers.filter(s_0 => s_0.client.config.type === "zyai-proxy").sort((a, b) => a.name.localeCompare(b.name));
  const dynamicServers = (serversByScope.get("dynamic") ?? []).sort((a_0, b_0) => a_0.name.localeCompare(b_0.name));
  const dynamicHeading = getScopeHeading("dynamic");
  const items = [];
  for (const scope of SCOPE_ORDER) {
    const scopeServers = serversByScope.get(scope) ?? [];
    for (const server of scopeServers) {
      items.push({
        type: "server",
        server
      });
    }
  }
  for (const server_0 of zyAiServers) {
    items.push({
      type: "server",
      server: server_0
    });
  }
  for (const agentServer of agentServers) {
    items.push({
      type: "agent-server",
      agentServer
    });
  }
  for (const server_1 of dynamicServers) {
    items.push({
      type: "server",
      server: server_1
    });
  }
  const selectableItems = items;
  const handleCancel = () => {
    onComplete("MCP dialog dismissed", {
      display: "system"
    });
  };
  const handleSelect = () => {
    const item = selectableItems[selectedIndex];
    if (!item) {
      return;
    }
    if (item.type === "server") {
      onSelectServer(item.server);
    } else {
      if (item.type === "agent-server" && onSelectAgentServer) {
        onSelectAgentServer(item.agentServer);
      }
    }
  };
  useKeybindings({
    "confirm:previous": () => setSelectedIndex(prev => prev === 0 ? selectableItems.length - 1 : prev - 1),
    "confirm:next": () => setSelectedIndex(prev_0 => prev_0 === selectableItems.length - 1 ? 0 : prev_0 + 1),
    "confirm:yes": handleSelect,
    "confirm:no": handleCancel
  }, {
    context: "Confirmation"
  });
  const getServerIndex = server_2 => selectableItems.findIndex(item_0 => item_0.type === "server" && item_0.server === server_2);
  const getAgentServerIndex = agentServer_0 => selectableItems.findIndex(item_1 => item_1.type === "agent-server" && item_1.agentServer === agentServer_0);
  const debugMode = isDebugMode();
  const hasFailedClients = servers.some(s_1 => s_1.client.type === "failed");
  if (servers.length === 0 && agentServers.length === 0) {
    return null;
  }
  const renderServerItem = server_3 => {
    const index = getServerIndex(server_3);
    const isSelected = selectedIndex === index;
    let statusIcon;
    let statusText;
    if (server_3.client.type === "disabled") {
      statusIcon = color("inactive", theme)(figures.radioOff);
      statusText = "disabled";
    } else {
      if (server_3.client.type === "connected") {
        statusIcon = color("success", theme)(figures.tick);
        statusText = "connected";
      } else {
        if (server_3.client.type === "pending") {
          statusIcon = color("inactive", theme)(figures.radioOff);
          const {
            reconnectAttempt,
            maxReconnectAttempts
          } = server_3.client;
          if (reconnectAttempt && maxReconnectAttempts) {
            statusText = `reconnecting (${reconnectAttempt}/${maxReconnectAttempts})…`;
          } else {
            statusText = "connecting\u2026";
          }
        } else {
          if (server_3.client.type === "needs-auth") {
            statusIcon = color("warning", theme)(figures.triangleUpOutline);
            statusText = "needs authentication";
          } else {
            statusIcon = color("error", theme)(figures.cross);
            statusText = "failed";
          }
        }
      }
    }
    return <Box key={`${server_3.name}-${index}`}><Text color={isSelected ? "suggestion" : undefined}>{isSelected ? `${figures.pointer} ` : "  "}</Text><Text color={isSelected ? "suggestion" : undefined}>{server_3.name}</Text><Text dimColor={!isSelected}> · {statusIcon} </Text><Text dimColor={!isSelected}>{statusText}</Text></Box>;
  };
  const renderAgentServerItem = agentServer_1 => {
    const index_0 = getAgentServerIndex(agentServer_1);
    const isSelected_0 = selectedIndex === index_0;
    const statusIcon_0 = agentServer_1.needsAuth ? color("warning", theme)(figures.triangleUpOutline) : color("inactive", theme)(figures.radioOff);
    const statusText_0 = agentServer_1.needsAuth ? "may need auth" : "agent-only";
    return <Box key={`agent-${agentServer_1.name}-${index_0}`}><Text color={isSelected_0 ? "suggestion" : undefined}>{isSelected_0 ? `${figures.pointer} ` : "  "}</Text><Text color={isSelected_0 ? "suggestion" : undefined}>{agentServer_1.name}</Text><Text dimColor={!isSelected_0}> · {statusIcon_0} </Text><Text dimColor={!isSelected_0}>{statusText_0}</Text></Box>;
  };
  const totalServers = servers.length + agentServers.length;
  const t20 = plural(totalServers, "server");
  const t22 = SCOPE_ORDER.map(scope_0 => {
    const scopeServers_0 = serversByScope.get(scope_0);
    if (!scopeServers_0 || scopeServers_0.length === 0) {
      return null;
    }
    const heading = getScopeHeading(scope_0);
    return <Box key={scope_0} flexDirection="column" marginBottom={1}><Box paddingLeft={2}><Text bold={true}>{heading.label}</Text>{heading.path && <Text dimColor={true}> ({heading.path})</Text>}</Box>{scopeServers_0.map(server_4 => renderServerItem(server_4))}</Box>;
  });
  return <Box flexDirection="column">{<McpParsingWarnings />}{<Dialog title="Manage MCP servers" subtitle={`${totalServers} ${t20}`} onCancel={handleCancel} hideInputGuide={true}>{<Box flexDirection="column">{t22}{zyAiServers.length > 0 && <Box flexDirection="column" marginBottom={1}><Box paddingLeft={2}><Text bold={true}>zy.ai</Text></Box>{zyAiServers.map(server_5 => renderServerItem(server_5))}</Box>}{agentServers.length > 0 && <Box flexDirection="column" marginBottom={1}><Box paddingLeft={2}><Text bold={true}>Agent MCPs</Text></Box>{[...new Set(agentServers.flatMap(s_2 => s_2.sourceAgents))].map(agentName => <Box key={agentName} flexDirection="column" marginTop={1}><Box paddingLeft={2}><Text dimColor={true}>@{agentName}</Text></Box>{agentServers.filter(s_3 => s_3.sourceAgents.includes(agentName)).map(agentServer_2 => renderAgentServerItem(agentServer_2))}</Box>)}</Box>}{dynamicServers.length > 0 && <Box flexDirection="column" marginBottom={1}><Box paddingLeft={2}><Text bold={true}>{dynamicHeading.label}</Text>{dynamicHeading.path && <Text dimColor={true}> ({dynamicHeading.path})</Text>}</Box>{dynamicServers.map(server_6 => renderServerItem(server_6))}</Box>}{<Box flexDirection="column">{hasFailedClients && <Text dimColor={true}>{debugMode ? "\u203B Error logs shown inline with --debug" : "\u203B Run zy --debug to see error logs"}</Text>}{<Text dimColor={true}><Link url="https://code.zy.com/docs/en/mcp">https://code.zy.com/docs/en/mcp</Link>{" "}for help</Text>}</Box>}</Box>}</Dialog>}{<Box paddingX={1}><Text dimColor={true} italic={true}><Byline><KeyboardShortcutHint shortcut={"\u2191\u2193"} action="navigate" /><KeyboardShortcutHint shortcut="Enter" action="confirm" /><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" /></Byline></Text></Box>}</Box>;
}
