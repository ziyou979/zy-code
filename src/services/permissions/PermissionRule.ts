import z from 'zod/v4'
import { PermissionBehaviorSchema } from '../../types/coreSchemas.js'
import { lazySchema } from '../../utils/lazySchema.js'

/**
 * ToolPermissionBehavior 表示权限规则关联的行为：allow 允许 tool 运行，deny 禁止 tool
 * 运行，ask 强制向用户显示确认提示。
 *
 * @deprecated 请从 coreSchemas.ts 导入 PermissionBehaviorSchema。
 */
export const permissionBehaviorSchema = PermissionBehaviorSchema

/**
 * PermissionRuleValue 是权限规则的内容。
 * @param toolName 此规则适用的 tool 名称
 * @param ruleContent 可选的规则内容；每个 tool 可在 `checkPermissions()` 中自定义处理
 */
export const permissionRuleValueSchema = lazySchema(() =>
  z.object({
    toolName: z.string(),
    ruleContent: z.string().optional(),
  }),
)
