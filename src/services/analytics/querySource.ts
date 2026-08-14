import type { QuerySource } from 'src/constants/querySource.js'
import { DEFAULT_OUTPUT_STYLE_NAME, OUTPUT_STYLE_CONFIG } from '../../constants/outputStyles.js'
import { getInitialSettings } from '../settings/settings.js'

/**
 * 确定 Agent 用法的提示词类别。
 * 用于分析以跟踪不同 Agent 模式。
 *
 * @param agentType - Agent 类型/名称
 * @param isBuiltInAgent - 是否为内置 Agent 或自定义
 * @returns Agent 提示词类别字符串
 */
export function getQuerySourceForAgent(
  agentType: string | undefined,
  isBuiltInAgent: boolean,
): QuerySource {
  if (isBuiltInAgent) {
    // TODO：移除此类型断言
    return agentType ? (`agent:builtin:${agentType}` as QuerySource) : 'agent:default'
  } else {
    return 'agent:custom'
  }
}

/**
 * 基于输出样式设置确定提示词类别。
 * 用于分析以跟踪不同输出样式的使用。
 *
 * @returns 提示词类别字符串，默认为 undefined
 */
export function getQuerySourceForREPL(): QuerySource {
  const settings = getInitialSettings()
  const style = settings?.outputStyle ?? DEFAULT_OUTPUT_STYLE_NAME

  if (style === DEFAULT_OUTPUT_STYLE_NAME) {
    return 'repl_main_thread'
  }

  // OUTPUT_STYLE_CONFIG 中的所有样式都是内置样式
  const isBuiltIn = style in OUTPUT_STYLE_CONFIG
  return isBuiltIn
    ? (`repl_main_thread:outputStyle:${style}` as QuerySource)
    : ('repl_main_thread:outputStyle:custom' as QuerySource)
}
