import type { ToolDefinition } from '../../types/llm.js'

// 已渲染 tool schema 的会话级缓存。tool schema 位于服务端位置 2（system prompt 之前），
// 因此任何字节级变化都会使约 11K token 的整个工具块及其后续内容缓存失效。GrowthBook 开关
// 变化（zy_tool_pear、zy_fgts）、MCP 重连或 tool.prompt() 中的动态内容都会导致这种抖动。
// 按会话记忆化可在首次渲染时锁定 schema 字节，避免会话中途刷新 GB 时破坏缓存。
//
// 放在叶子模块中，使 auth.ts 无需导入 api.ts 即可清除缓存；否则会通过
// plans→settings→file→growthbook→config→bridgeEnabled→auth 形成循环依赖。
export type CachedSchema = ToolDefinition & {
  strict?: boolean
  eager_input_streaming?: boolean
}

const TOOL_SCHEMA_CACHE = new Map<string, CachedSchema>()

export function getToolSchemaCache(): Map<string, CachedSchema> {
  return TOOL_SCHEMA_CACHE
}

export function clearToolSchemaCache(): void {
  TOOL_SCHEMA_CACHE.clear()
}
