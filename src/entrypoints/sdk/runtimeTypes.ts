// Stub for src/entrypoints/sdk/runtimeTypes.ts

import type { ZodRawShape, infer as ZodInfer } from 'zod'

export type EffortLevel = 'low' | 'medium' | 'high'

export type InferShape<T extends ZodRawShape> = ZodInfer<import('zod').ZodObject<T>>

export type AnyZodRawShape = ZodRawShape

export type Query = Record<string, unknown>

export type InternalQuery = Record<string, unknown>

export type Options = Record<string, unknown>

export type InternalOptions = Record<string, unknown>

export type SDKSessionOptions = {
  apiKey?: string
  model?: string
  maxTurns?: number
}

export type SessionMessage = {
  role: 'user' | 'assistant'
  content: string | unknown[]
}

export type SDKSession = {
  id: string
  messages: SessionMessage[]
}

export type SdkMcpToolDefinition<T> = {
  name: string
  description: string
  inputSchema: Record<string, T>
}

export type McpSdkServerConfigWithInstance = {
  serverName: string
  config: Record<string, unknown>
}

export type ListSessionsOptions = Record<string, unknown>
export type GetSessionInfoOptions = Record<string, unknown>
export type SessionMutationOptions = Record<string, unknown>
export type ForkSessionOptions = Record<string, unknown>
export type ForkSessionResult = { sessionId: string }
export type SDKSessionInfo = { id: string; createdAt: string }
