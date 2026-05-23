// Stub for src/types/connectorText.ts
// Used by CONNECTOR_TEXT feature flag path

export type ConnectorTextBlock = {
  type: 'connector_text'
  connectorText: string
  signature?: string
}

export type ConnectorTextDelta = {
  type: 'connector_text_delta'
  connectorText: string
}

export type ConnectorSignatureDelta = {
  type: 'signature_delta'
  signature: string
}

export function isConnectorTextBlock(block: unknown): block is ConnectorTextBlock {
  return (block as ConnectorTextBlock)?.type === 'connector_text'
}
