export const STATUSLINE_MODULE_IDS = [
  'directory',
  'model',
  'context',
  'tokens',
  'cache',
  'speed',
  'turns',
  'cost',
  'memory',
] as const

export type StatuslineModuleId = (typeof STATUSLINE_MODULE_IDS)[number]

/** directory 模块的路径显示方式：项目名（basename）或全路径。 */
export const STATUSLINE_PATH_MODES = ['name', 'full'] as const
export type StatuslinePathMode = (typeof STATUSLINE_PATH_MODES)[number]

/** 持久化状态栏模块所需的稳定配置契约。 */
export type StatuslineModuleConfig = {
  id: StatuslineModuleId
  visible: boolean
  icon?: string
  color?: string
  /** directory 模块：路径显示方式，默认 'name' */
  pathMode?: StatuslinePathMode
  /** speed 模块：TTFT 前缀符号（1 格 unicode），默认 ''（不显示） */
  ttftSymbol?: string
}
