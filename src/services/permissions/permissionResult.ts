// 类型已提取到 src/types/permissions.ts，以打破循环导入
import type { PermissionResult } from '../../types/permissions.js'

// 获取规则行为对应文字说明的辅助函数
export function getRuleBehaviorDescription(permissionResult: PermissionResult['behavior']): string {
  switch (permissionResult) {
    case 'allow':
      return 'allowed'
    case 'deny':
      return 'denied'
    default:
      return 'asked for confirmation for'
  }
}
