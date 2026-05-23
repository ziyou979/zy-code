import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { migrateChangelogFromConfig } from '../../utils/releaseNotes.js'

// 添加新的同步迁移时递增此值，以便现有用户重新运行迁移集。
export const CURRENT_MIGRATION_VERSION = 13

export function runMigrations(): void {
  if (getGlobalConfig().migrationVersion !== CURRENT_MIGRATION_VERSION) {
    saveGlobalConfig((prev) =>
      prev.migrationVersion === CURRENT_MIGRATION_VERSION
        ? prev
        : {
            ...prev,
            migrationVersion: CURRENT_MIGRATION_VERSION,
          },
    )
  }
  // 异步迁移 —— 触发后不等待，因为是非阻塞的
  migrateChangelogFromConfig().catch(() => {
    // 静默忽略迁移错误 —— 下次启动时重试
  })
}
