import React, { useEffect, useMemo } from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import { ZyAuthProvider } from '../../services/mcp/auth.js';
import type { McpZyAIProxyServerConfig, McpHTTPServerConfig, McpSSEServerConfig, McpStdioServerConfig } from '../../services/mcp/types.js';
import { extractAgentMcpServers, filterToolsByServer } from '../../services/mcp/utils.js';
import { useAppState } from '../../state/AppState.js';
import { getSessionIngressAuthToken } from '../../utils/sessionIngressAuth.js';
import { MCPAgentServerMenu } from './MCPAgentServerMenu.js';
import { MCPListPanel } from './MCPListPanel.js';
import { MCPRemoteServerMenu } from './MCPRemoteServerMenu.js';
import { MCPStdioServerMenu } from './MCPStdioServerMenu.js';
import { MCPToolDetailView } from './MCPToolDetailView.js';
import { MCPToolListView } from './MCPToolListView.js';
import type { AgentMcpServerInfo, MCPViewState, ServerInfo } from './types.js';
type Props = {
  onComplete: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
};
export function MCPSettings({
  onComplete
}: Props) {
  const mcp = useAppState(s => s.mcp);
  const agentDefinitions = useAppState(s_0 => s_0.agentDefinitions);
  const mcpClients = mcp.clients;
  const [viewState, setViewState] = React.useState({
    type: "list"
  });
  const [servers, setServers] = React.useState([]);
  const agentMcpServers = extractAgentMcpServers(agentDefinitions.allAgents);
  const filteredClients = mcpClients.filter(client => client.name !== "ide").sort((a, b) => a.name.localeCompare(b.name));
  React.useEffect(() => {
    let cancelled = false;
    const prepareServers = async function prepareServers() {
      const serverInfos = await Promise.all(filteredClients.map(async client_0 => {
        const scope = client_0.config.scope;
        const isSSE = client_0.config.type === "sse";
        const isHTTP = client_0.config.type === "http";
        const isZyAIProxy = client_0.config.type === "zyai-proxy";
        let isAuthenticated = undefined;
        if (isSSE || isHTTP) {
          const authProvider = new ZyAuthProvider(client_0.name, client_0.config as McpSSEServerConfig | McpHTTPServerConfig);
          const tokens = await authProvider.tokens();
          const hasSessionAuth = getSessionIngressAuthToken() !== null && client_0.type === "connected";
          const hasToolsAndConnected = client_0.type === "connected" && filterToolsByServer(mcp.tools, client_0.name).length > 0;
          isAuthenticated = Boolean(tokens) || hasSessionAuth || hasToolsAndConnected;
        }
        const baseInfo = {
          name: client_0.name,
          client: client_0,
          scope
        };
        if (isZyAIProxy) {
          return {
            ...baseInfo,
            transport: "zyai-proxy" as const,
            isAuthenticated: false,
            config: client_0.config as McpZyAIProxyServerConfig
          };
        } else {
          if (isSSE) {
            return {
              ...baseInfo,
              transport: "sse" as const,
              isAuthenticated,
              config: client_0.config as McpSSEServerConfig
            };
          } else {
            if (isHTTP) {
              return {
                ...baseInfo,
                transport: "http" as const,
                isAuthenticated,
                config: client_0.config as McpHTTPServerConfig
              };
            } else {
              return {
                ...baseInfo,
                transport: "stdio" as const,
                config: client_0.config as McpStdioServerConfig
              };
            }
          }
        }
      }));
      if (cancelled) {
        return;
      }
      setServers(serverInfos);
    };
    prepareServers();
    return () => {
      cancelled = true;
    };
  }, [filteredClients, mcp.tools]);
  useEffect(() => {
    if (servers.length === 0 && filteredClients.length > 0) {
      return;
    }
    if (servers.length === 0 && agentMcpServers.length === 0) {
      onComplete("No MCP servers configured. Please run /doctor if this is unexpected. Otherwise, run `zy mcp --help` or visit https://code.zy.com/docs/en/mcp to learn more.");
    }
  }, [servers.length, filteredClients.length, agentMcpServers.length, onComplete]);
  switch (viewState.type) {
    case "list":
      {
        let t10;
        let t9;
        t9 = server => setViewState({
          type: "server-menu",
          server
        });
        t10 = agentServer => setViewState({
          type: "agent-server-menu",
          agentServer
        });
        let t11;
        t11 = <MCPListPanel servers={servers} agentServers={agentMcpServers} onSelectServer={t9} onSelectAgentServer={t10} onComplete={onComplete} defaultTab={viewState.defaultTab} />;
        return t11;
      }
    case "server-menu":
      {
        let t9;
        t9 = filterToolsByServer(mcp.tools, viewState.server.name);
        const serverTools_0 = t9;
        const defaultTab = viewState.server.transport === "zyai-proxy" ? "zy.ai" : "ZY Code";
        if (viewState.server.transport === "stdio") {
          let t10;
          t10 = () => setViewState({
            type: "server-tools",
            server: viewState.server
          });
          let t11;
          t11 = () => setViewState({
            type: "list",
            defaultTab
          });
          let t12;
          t12 = <MCPStdioServerMenu server={viewState.server} serverToolsCount={serverTools_0.length} onViewTools={t10} onCancel={t11} onComplete={onComplete} />;
          return t12;
        } else {
          let t10;
          t10 = () => setViewState({
            type: "server-tools",
            server: viewState.server
          });
          let t11;
          t11 = () => setViewState({
            type: "list",
            defaultTab
          });
          let t12;
          t12 = <MCPRemoteServerMenu server={viewState.server} serverToolsCount={serverTools_0.length} onViewTools={t10} onCancel={t11} onComplete={onComplete} />;
          return t12;
        }
      }
    case "server-tools":
      {
        let t10;
        let t9;
        t9 = (_, index) => setViewState({
          type: "server-tool-detail",
          server: viewState.server,
          toolIndex: index
        });
        t10 = () => setViewState({
          type: "server-menu",
          server: viewState.server
        });
        let t11;
        t11 = <MCPToolListView server={viewState.server} onSelectTool={t9} onBack={t10} />;
        return t11;
      }
    case "server-tool-detail":
      {
        let t9;
        t9 = filterToolsByServer(mcp.tools, viewState.server.name);
        const serverTools = t9;
        const tool = serverTools[viewState.toolIndex];
        if (!tool) {
          setViewState({
            type: "server-tools",
            server: viewState.server
          });
          return null;
        }
        let t10;
        t10 = () => setViewState({
          type: "server-tools",
          server: viewState.server
        });
        let t11;
        t11 = <MCPToolDetailView tool={tool} server={viewState.server} onBack={t10} />;
        return t11;
      }
    case "agent-server-menu":
      {
        let t9;
        t9 = () => setViewState({
          type: "list",
          defaultTab: "Agents"
        });
        let t10;
        t10 = <MCPAgentServerMenu agentServer={viewState.agentServer} onCancel={t9} onComplete={onComplete} />;
        return t10;
      }
  }
}
