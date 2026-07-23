/**
 * MCP transport 类型展示名称。
 * 仅返回用户可见的展示文本，不含业务逻辑。
 */
export function getTransportDisplayName(type: string): string {
  switch (type) {
    case 'http':
      return 'HTTP'
    case 'ws':
    case 'ws-ide':
      return 'WebSocket'
    default:
      return 'SSE'
  }
}
