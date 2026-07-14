export const STATUSLINE_MODULE_IDS = [
  'directory',
  'model',
  'context',
  'tokens',
  'cost',
  'memory',
] as const

export type StatuslineModuleId = (typeof STATUSLINE_MODULE_IDS)[number]

/** 持久化状态栏模块所需的稳定配置契约。 */
export type StatuslineModuleConfig = {
  id: StatuslineModuleId
  visible: boolean
  icon?: string
  color?: string
}
