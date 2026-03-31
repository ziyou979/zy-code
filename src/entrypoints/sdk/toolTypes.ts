// Stub for src/entrypoints/sdk/toolTypes.ts

export type ToolDefinition = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type ToolResult = {
  content: unknown[]
  isError?: boolean
}
