/**
 * session ID 和 agent ID 的品牌类型。
 * 用于在编译期避免意外混用 session ID 与 agent ID。
 */

import type { UUID } from 'node:crypto'

/**
 * 将原始字符串转换为品牌 UUID 类型。
 * 用于对接要求 Node 品牌 UUID 的 API——message.uuid 字段虽始终包含 UUID，
 * 类型却是普通 `string`。
 */
export function toUUID(s: string): UUID {
  return s as UUID
}

/**
 * session ID 用于唯一标识 ZY Code session。
 * 由 getSessionId() 返回。
 */
export type SessionId = string & { readonly __brand: 'SessionId' }

/**
 * agent ID 用于唯一标识 session 内的子 agent。
 * 由 createAgentId() 返回。
 * 存在时表示当前 context 属于子 agent，而非主 session。
 */
export type AgentId = string & { readonly __brand: 'AgentId' }

/**
 * 将原始字符串转换为 SessionId。
 * 应谨慎使用，条件允许时优先调用 getSessionId()。
 */
export function asSessionId(id: string): SessionId {
  return id as SessionId
}

/**
 * 将原始字符串转换为 AgentId。
 * 应谨慎使用，条件允许时优先调用 createAgentId()。
 */
export function asAgentId(id: string): AgentId {
  return id as AgentId
}

const AGENT_ID_PATTERN = /^a(?:.+-)?[0-9a-f]{16}$/

/**
 * 校验字符串并将其标记为 AgentId。
 * 匹配 createAgentId() 生成的格式：`a` + 可选 `<label>-` + 16 位十六进制字符。
 * 字符串不匹配时返回 null（如 teammate 名称或 team 定址）。
 */
export function toAgentId(s: string): AgentId | null {
  return AGENT_ID_PATTERN.test(s) ? (s as AgentId) : null
}
