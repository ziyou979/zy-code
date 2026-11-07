/**
 * 权限更新使用的 Zod schema。
 *
 * 本文件有意保持精简且不含复杂依赖，使 src/types/hooks.ts 可安全导入而不产生循环依赖。
 */
import z from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import { externalPermissionModeSchema } from './permissionMode.js'
import { permissionBehaviorSchema, permissionRuleValueSchema } from './permissionRule.js'

/**
 * PermissionUpdateDestination 表示新权限规则的保存位置。
 */
export const permissionUpdateDestinationSchema = lazySchema(() =>
  z.enum([
    // 用户设置（全局）
    'userSettings',
    // 项目设置（目录内共享）
    'projectSettings',
    // 本地设置（被 gitignore）
    'localSettings',
    // 仅保存在当前会话内存中
    'session',
    // 来自命令行参数
    'cliArg',
  ]),
)

export const permissionUpdateSchema = lazySchema(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('addRules'),
      rules: z.array(permissionRuleValueSchema()),
      behavior: permissionBehaviorSchema(),
      destination: permissionUpdateDestinationSchema(),
    }),
    z.object({
      type: z.literal('replaceRules'),
      rules: z.array(permissionRuleValueSchema()),
      behavior: permissionBehaviorSchema(),
      destination: permissionUpdateDestinationSchema(),
    }),
    z.object({
      type: z.literal('removeRules'),
      rules: z.array(permissionRuleValueSchema()),
      behavior: permissionBehaviorSchema(),
      destination: permissionUpdateDestinationSchema(),
    }),
    z.object({
      type: z.literal('setMode'),
      mode: externalPermissionModeSchema(),
      destination: permissionUpdateDestinationSchema(),
    }),
    z.object({
      type: z.literal('addDirectories'),
      directories: z.array(z.string()),
      destination: permissionUpdateDestinationSchema(),
    }),
    z.object({
      type: z.literal('removeDirectories'),
      directories: z.array(z.string()),
      destination: permissionUpdateDestinationSchema(),
    }),
  ]),
)
