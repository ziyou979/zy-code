import type { HookCommand } from '../../schemas/hooks.js'

/**
 * 插件 hooks 的内部类型 - 包含执行时的插件上下文。
 * 非 Zod schema，因为它不面向用户（插件提供原生 hooks）。
 */
export type PluginHookMatcher = {
  matcher?: string
  hooks: HookCommand[]
  pluginRoot: string
  pluginName: string
  pluginId: string // 格式："pluginName@marketplaceName"
}

/**
 * Skill hooks 的内部类型 - 包含执行时的 skill 上下文。
 * 非 Zod schema，因为它不面向用户（skills 提供原生 hooks）。
 */
export type SkillHookMatcher = {
  matcher?: string
  hooks: HookCommand[]
  skillRoot: string
  skillName: string
}

/**
 * MCPB MCP 服务器的用户配置值
 */
export type UserConfigValues = Record<string, string | number | boolean | string[]>

/**
 * 存储在 settings.json 中的插件配置
 */
export type PluginConfig = {
  mcpServers?: {
    [serverName: string]: UserConfigValues
  }
}
