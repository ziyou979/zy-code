import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ENV_KEYS = ['ZY_CONFIG_DIR', 'ZY_TEAMS_DIR', 'ZY_SESSION_ID', 'HOME'] as const

export type TestDataDirectory = {
  root: string
  setup: () => Promise<void>
  cleanup: () => Promise<void>
}

/**
 * 为会写 ZY 用户数据的测试创建独立目录，并在结束时完整恢复环境变量。
 * `includeHome` 仅用于仍读取 HOME 的历史任务存储入口。
 */
export async function createTestDataDirectory(
  prefix: string,
  options: { includeHome?: boolean; includeTeams?: boolean } = {},
): Promise<TestDataDirectory> {
  const root = await mkdtemp(join(tmpdir(), `${prefix}-`))
  const originalEnvironment = new Map(ENV_KEYS.map((key) => [key, process.env[key]]))

  return {
    root,
    async setup() {
      process.env.ZY_CONFIG_DIR = root
      process.env.ZY_SESSION_ID = `test-session-${randomUUID()}`
      if (options.includeHome) {
        process.env.HOME = root
      }
      if (options.includeTeams) {
        process.env.ZY_TEAMS_DIR = join(root, 'teams')
        await mkdir(process.env.ZY_TEAMS_DIR, { recursive: true })
      }
    },
    async cleanup() {
      for (const key of ENV_KEYS) {
        const originalValue = originalEnvironment.get(key)
        if (originalValue === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = originalValue
        }
      }
      await rm(root, { recursive: true, force: true })
    },
  }
}
