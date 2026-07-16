// Query Source Constants

export const QUERY_SOURCES = ['cli', 'sdk', 'ide', 'web', 'api'] as const

/**
 * 内部查询来源标识符，用于内部子系统（压缩、代理、推测等）的 LLM 调用
 */
export type InternalQuerySource =
  | 'agent_creation'
  | 'agent_summary'
  | 'agent:custom'
  | 'auto_dream'
  | 'auto_mode_critique'
  | 'auto_mode'
  | 'away_summary'
  | 'bash_classifier'
  | 'bash_extract_prefix'
  | 'chrome_mcp'
  | 'code_review'
  | 'compact'
  | 'extract_memories'
  | 'feedback'
  | 'generate_session_title'
  | 'hook_agent'
  | 'hook_prompt'
  | 'insights'
  | 'magic_docs'
  | 'marble_origami'
  | 'mcp_datetime_parse'
  | 'memdir_relevance'
  | 'model_validation'
  | 'permission_explainer'
  | 'prompt_suggestion'
  | 'rename_generate_name'
  | 'repl_main_thread'
  | 'session_memory'
  | 'session_search'
  | 'side_question'
  | 'skill_improvement'
  | 'speculation'
  | 'teleport_generate_title'
  | 'tool_use_summary_generation'
  | 'verification_agent'
  | `agent:${string}`
  | `repl_main_thread:${string}`

export type QuerySource = (typeof QUERY_SOURCES)[number] | InternalQuerySource
