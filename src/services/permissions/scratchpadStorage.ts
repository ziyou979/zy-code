import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import memoize from 'lodash-es/memoize.js'
import { getOriginalCwd, getSessionId } from '../../bootstrap/runtime/runtimeContext.js'
import { getCwd } from '../environment/cwd.js'
import { getFsImplementation } from '../../services/infra/fsOperations.js'
import { sanitizePath } from '../../utils/path.js'
import { getProjectDir } from '../sessionStorage.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { getPlatform } from '../shell/platform.js'

declare const MACRO: { VERSION: string }

export function isScratchpadEnabled(): boolean {
  return checkStatsigFeatureGate_CACHED_MAY_BE_STALE('zy_scratch_dir')
}

export function getZyTempDirName(): string {
  if (getPlatform() === 'windows') {
    return 'zy'
  }
  const uid = process.getuid?.() ?? 0
  return `zy-${uid}`
}

export const getZyTempDir = memoize(function getZyTempDir(): string {
  const baseTmpDir = process.env.ZY_CODE_TMPDIR || (getPlatform() === 'windows' ? tmpdir() : '/tmp')

  const fs = getFsImplementation()
  let resolvedBaseTmpDir = baseTmpDir
  try {
    resolvedBaseTmpDir = fs.realpathSync(baseTmpDir)
  } catch {
    // 如果解析失败，使用原始路径
  }

  return join(resolvedBaseTmpDir, getZyTempDirName()) + sep
})

export const getBundledSkillsRoot = memoize(function getBundledSkillsRoot(): string {
  const nonce = randomBytes(16).toString('hex')
  return join(getZyTempDir(), 'bundled-skills', MACRO.VERSION, nonce)
})

export function getProjectTempDir(): string {
  return join(getZyTempDir(), sanitizePath(getOriginalCwd())) + sep
}

export function getScratchpadDir(): string {
  return join(getProjectTempDir(), getSessionId(), 'scratchpad')
}

export async function ensureScratchpadDir(): Promise<string> {
  if (!isScratchpadEnabled()) {
    throw new Error('Scratchpad directory feature is not enabled')
  }

  const fs = getFsImplementation()
  const scratchpadDir = getScratchpadDir()
  await fs.mkdir(scratchpadDir, { mode: 0o700 })
  return scratchpadDir
}

export function getSessionMemoryDir(): string {
  return join(getProjectDir(getCwd()), getSessionId(), 'session-memory') + sep
}

export function getSessionMemoryPath(): string {
  return join(getSessionMemoryDir(), 'summary.md')
}
