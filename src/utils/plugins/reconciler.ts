/**
 * Marketplace 协调器 — 使 known_marketplaces.json 与 settings 中声明的意图保持一致。
 *
 * 两个层次：
 * - diffMarketplaces()：比较（读取 .git 进行工作树规范化，已记忆化）
 * - reconcileMarketplaces()：捆绑的 diff + 安装（I/O，幂等，仅追加）
 */

import isEqual from 'lodash-es/isEqual.js'
import { isAbsolute, resolve } from 'path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { pathExists } from '../file.js'
import { findCanonicalGitRoot } from '../git.js'
import { logError } from '../log.js'
import {
  addMarketplaceSource,
  type DeclaredMarketplace,
  getDeclaredMarketplaces,
  loadKnownMarketplacesConfig,
} from './marketplaceManager.js'
import {
  isLocalMarketplaceSource,
  type KnownMarketplacesFile,
  type MarketplaceSource,
} from './schemas.js'

export type MarketplaceDiff = {
  /** 在 settings 中声明，但在 known_marketplaces.json 中缺失 */
  missing: string[]
  /** 两者都存在，但 settings 源 ≠ JSON 源（settings 胜出） */
  sourceChanged: Array<{
    name: string
    declaredSource: MarketplaceSource
    materializedSource: MarketplaceSource
  }>
  /** 两者都存在，源匹配 */
  upToDate: string[]
}

/**
 * 将声明的意图（settings）与已物化的状态（JSON）进行比较。
 *
 * 在比较前解析 `declared` 中的相对目录/文件路径，
 * 这样包含 `./path` 的项目 settings 可以与 JSON 的绝对路径匹配。
 * 路径解析读取 `.git` 来规范化工作树路径（已记忆化）。
 */
export function diffMarketplaces(
  declared: Record<string, DeclaredMarketplace>,
  materialized: KnownMarketplacesFile,
  opts?: { projectRoot?: string },
): MarketplaceDiff {
  const missing: string[] = []
  const sourceChanged: MarketplaceDiff['sourceChanged'] = []
  const upToDate: string[] = []

  for (const [name, intent] of Object.entries(declared)) {
    const state = materialized[name]
    const normalizedIntent = normalizeSource(intent.source, opts?.projectRoot)

    if (!state) {
      missing.push(name)
    } else if (intent.sourceIsFallback) {
      // 回退：存在即可。不比较源 — 声明的源仅是 `missing` 分支的
      // 默认值。如果种子/先前安装/镜像在任何源下物化了
      // 此 marketplace，则保持不变。比较会报告 sourceChanged
      // → 重新克隆 → 覆盖已物化的内容。
      upToDate.push(name)
    } else if (!isEqual(normalizedIntent, state.source)) {
      sourceChanged.push({
        name,
        declaredSource: normalizedIntent,
        materializedSource: state.source,
      })
    } else {
      upToDate.push(name)
    }
  }

  return { missing, sourceChanged, upToDate }
}

export type ReconcileOptions = {
  /** 跳过声明的 marketplace。用于 zip-cache 模式中不支持的源类型。 */
  skip?: (name: string, source: MarketplaceSource) => boolean
  onProgress?: (event: ReconcileProgressEvent) => void
}

export type ReconcileProgressEvent =
  | {
      type: 'installing'
      name: string
      action: 'install' | 'update'
      index: number
      total: number
    }
  | { type: 'installed'; name: string; alreadyMaterialized: boolean }
  | { type: 'failed'; name: string; error: string }

export type ReconcileResult = {
  installed: string[]
  updated: string[]
  failed: Array<{ name: string; error: string }>
  upToDate: string[]
  skipped: string[]
}

/**
 * 使 known_marketplaces.json 与声明的意图保持一致。
 * 幂等。仅追加（从不删除）。不触及 AppState。
 */
export async function reconcileMarketplaces(opts?: ReconcileOptions): Promise<ReconcileResult> {
  const declared = getDeclaredMarketplaces()
  if (Object.keys(declared).length === 0) {
    return { installed: [], updated: [], failed: [], upToDate: [], skipped: [] }
  }

  let materialized: KnownMarketplacesFile
  try {
    materialized = await loadKnownMarketplacesConfig()
  } catch (e) {
    logError(e)
    materialized = {}
  }

  const diff = diffMarketplaces(declared, materialized, {
    projectRoot: getOriginalCwd(),
  })

  type WorkItem = {
    name: string
    source: MarketplaceSource
    action: 'install' | 'update'
  }
  const work: WorkItem[] = [
    ...diff.missing.map(
      (name): WorkItem => ({
        name,
        source: normalizeSource(declared[name]!.source),
        action: 'install',
      }),
    ),
    ...diff.sourceChanged.map(
      ({ name, declaredSource }): WorkItem => ({
        name,
        source: declaredSource,
        action: 'update',
      }),
    ),
  ]

  const skipped: string[] = []
  const toProcess: WorkItem[] = []
  for (const item of work) {
    if (opts?.skip?.(item.name, item.source)) {
      skipped.push(item.name)
      continue
    }
    // 对于 sourceChanged 的本地路径条目，如果声明的路径不存在则跳过。
    // 防护多检出场景，其中 normalizeSource 无法规范化并产生
    // 死路径 — 已物化的条目可能仍然有效；addMarketplaceSource
    // 无论如何都会失败，所以跳过可以避免嘈杂的 "failed" 事件
    // 并保留工作条目。缺失的条目不会被跳过
    // （没有什么要保留；用户应该看到错误）。
    if (
      item.action === 'update' &&
      isLocalMarketplaceSource(item.source) &&
      !(await pathExists(item.source.path))
    ) {
      logForDebugging(
        `[reconcile] '${item.name}' declared path does not exist; keeping materialized entry`,
      )
      skipped.push(item.name)
      continue
    }
    toProcess.push(item)
  }

  if (toProcess.length === 0) {
    return {
      installed: [],
      updated: [],
      failed: [],
      upToDate: diff.upToDate,
      skipped,
    }
  }

  logForDebugging(
    `[reconcile] ${toProcess.length} marketplace(s): ${toProcess.map((w) => `${w.name}(${w.action})`).join(', ')}`,
  )

  const installed: string[] = []
  const updated: string[] = []
  const failed: ReconcileResult['failed'] = []

  for (let i = 0; i < toProcess.length; i++) {
    const { name, source, action } = toProcess[i]!
    opts?.onProgress?.({
      type: 'installing',
      name,
      action,
      index: i + 1,
      total: toProcess.length,
    })

    try {
      // addMarketplaceSource 是源幂等的 — 相同的源返回
      // alreadyMaterialized:true 而不克隆。对于 'update'（源
      // 已更改），新源不会匹配现有的 → 继续克隆
      // 并覆写旧的 JSON 条目。
      const result = await addMarketplaceSource(source)

      if (action === 'install') installed.push(name)
      else updated.push(name)
      opts?.onProgress?.({
        type: 'installed',
        name,
        alreadyMaterialized: result.alreadyMaterialized,
      })
    } catch (e) {
      const error = errorMessage(e)
      failed.push({ name, error })
      opts?.onProgress?.({ type: 'failed', name, error })
      logError(e)
    }
  }

  return { installed, updated, failed, upToDate: diff.upToDate, skipped }
}

/**
 * 解析相对目录/文件路径以进行稳定的比较。
 * 在项目范围声明的 settings 可能使用项目相对路径；
 * JSON 存储绝对路径。
 *
 * 对于 git 工作树，相对于主检出（规范根）解析而非
 * 工作树 cwd。项目 settings 被检入 git，所以 `./foo`
 * 意味着“相对于此仓库”— 但 known_marketplaces.json 是
 * 用户全局的，每个 marketplace 名称一个条目。相对于
 * 工作树 cwd 解析意味着每个工作树会话会用其自己的
 * 绝对路径覆写共享条目，删除工作树会留下死的
 * installLocation。规范根在所有工作树中是稳定的。
 */
function normalizeSource(source: MarketplaceSource, projectRoot?: string): MarketplaceSource {
  if ((source.source === 'directory' || source.source === 'file') && !isAbsolute(source.path)) {
    const base = projectRoot ?? getOriginalCwd()
    const canonicalRoot = findCanonicalGitRoot(base)
    return {
      ...source,
      path: resolve(canonicalRoot ?? base, source.path),
    }
  }
  return source
}
