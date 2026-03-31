// Stub for src/types/connectorText.ts
// Used by CONNECTOR_TEXT feature flag path

export type ConnectorTextBlock = {
  type: 'connector_text'
  text: string
}

export function isConnectorTextBlock(block: unknown): block is ConnectorTextBlock {
  return (block as ConnectorTextBlock)?.type === 'connector_text'
}
