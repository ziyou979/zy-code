/**
 * Git bundle 创建与上传，用于 CCR seed-bundle 播种。
 *
 * 流程：
 *   1. git stash create → update-ref refs/seed/stash（使其可达）
 *   2. git bundle create --all（打包 refs/seed/stash 及其对象）
 *   3. 上传到 /v1/files
 *   4. 清理 refs/seed/stash（不污染用户的仓库）
 *   5. 调用方在 SessionContext 上设置 seed_bundle_file_id
 */

import { stat, unlink } from 'node:fs/promises'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { type FilesApiConfig, uploadFile } from '../../services/api/filesApi.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { findGitRoot, gitExe } from '../../utils/git.js'
import { generateTempFilePath } from '../../utils/tempfile.js'

// 可通过 zy_ccr_bundle_max_bytes 调节。
const DEFAULT_BUNDLE_MAX_BYTES = 100 * 1024 * 1024

type BundleScope = 'all' | 'head' | 'squashed'

export type BundleUploadResult =
  | {
      success: true
      fileId: string
      bundleSizeBytes: number
      scope: BundleScope
      hasWip: boolean
    }
  | { success: false; error: string; failReason?: BundleFailReason }

type BundleFailReason = 'git_error' | 'too_large' | 'empty_repo'

type BundleCreateResult =
  | { ok: true; size: number; scope: BundleScope }
  | { ok: false; error: string; failReason: BundleFailReason }

// Bundle --all → HEAD → squashed-root 降级链。HEAD 会丢弃侧分支/标签，
// 但保留当前分支的完整历史。Squashed-root 是 HEAD 树（或存在 WIP 时的
// stash 树）的单个无父提交——没有历史，只有快照。
// 接收端需要处理该层级的 refs/seed/root。
async function _bundleWithFallback(
  gitRoot: string,
  bundlePath: string,
  maxBytes: number,
  hasStash: boolean,
  signal: AbortSignal | undefined,
): Promise<BundleCreateResult> {
  // --all 会包含 refs/seed/stash；HEAD 模式需要显式指定。
  const extra = hasStash ? ['refs/seed/stash'] : []
  const mkBundle = (base: string) =>
    execFileNoThrowWithCwd(gitExe(), ['bundle', 'create', bundlePath, base, ...extra], {
      cwd: gitRoot,
      abortSignal: signal,
    })

  const allResult = await mkBundle('--all')
  if (allResult.code !== 0) {
    return {
      ok: false,
      error: `git bundle create --all failed (${allResult.code}): ${allResult.stderr.slice(0, 200)}`,
      failReason: 'git_error',
    }
  }

  const { size: allSize } = await stat(bundlePath)
  if (allSize <= maxBytes) {
    return { ok: true, size: allSize, scope: 'all' }
  }

  // bundle create 会原地覆盖文件。
  logForDebugging(
    `[gitBundle] --all bundle is ${(allSize / 1024 / 1024).toFixed(1)}MB (> ${(maxBytes / 1024 / 1024).toFixed(0)}MB), retrying HEAD-only`,
  )
  const headResult = await mkBundle('HEAD')
  if (headResult.code !== 0) {
    return {
      ok: false,
      error: `git bundle create HEAD failed (${headResult.code}): ${headResult.stderr.slice(0, 200)}`,
      failReason: 'git_error',
    }
  }

  const { size: headSize } = await stat(bundlePath)
  if (headSize <= maxBytes) {
    return { ok: true, size: headSize, scope: 'head' }
  }

  // 最后手段：压缩为单个无父提交。当存在 WIP 时使用 stash 树
  // （将未提交的变更烘焙进去——不能单独 bundle stash ref，
  // 因为其父提交会将历史拖回来）。
  logForDebugging(
    `[gitBundle] HEAD bundle is ${(headSize / 1024 / 1024).toFixed(1)}MB, retrying squashed-root`,
  )
  const treeRef = hasStash ? 'refs/seed/stash^{tree}' : 'HEAD^{tree}'
  const commitTree = await execFileNoThrowWithCwd(
    gitExe(),
    ['commit-tree', treeRef, '-m', 'seed'],
    { cwd: gitRoot, abortSignal: signal },
  )
  if (commitTree.code !== 0) {
    return {
      ok: false,
      error: `git commit-tree failed (${commitTree.code}): ${commitTree.stderr.slice(0, 200)}`,
      failReason: 'git_error',
    }
  }
  const squashedSha = commitTree.stdout.trim()
  await execFileNoThrowWithCwd(gitExe(), ['update-ref', 'refs/seed/root', squashedSha], {
    cwd: gitRoot,
  })
  const squashResult = await execFileNoThrowWithCwd(
    gitExe(),
    ['bundle', 'create', bundlePath, 'refs/seed/root'],
    { cwd: gitRoot, abortSignal: signal },
  )
  if (squashResult.code !== 0) {
    return {
      ok: false,
      error: `git bundle create refs/seed/root failed (${squashResult.code}): ${squashResult.stderr.slice(0, 200)}`,
      failReason: 'git_error',
    }
  }
  const { size: squashSize } = await stat(bundlePath)
  if (squashSize <= maxBytes) {
    return { ok: true, size: squashSize, scope: 'squashed' }
  }

  return {
    ok: false,
    error: 'Repo is too large to bundle. Please setup GitHub on https://zy.ai/code',
    failReason: 'too_large',
  }
}

// 打包仓库并上传到 Files API；返回 file_id 用于
// seed_bundle_file_id。降级链：--all → HEAD → squashed-root。
// 通过 stash create → refs/seed/stash 跟踪 WIP（或烘焙到
// 压缩树中）；不捕获未跟踪文件。
export async function createAndUploadGitBundle(
  config: FilesApiConfig,
  opts?: { cwd?: string; signal?: AbortSignal },
): Promise<BundleUploadResult> {
  const workdir = opts?.cwd ?? getCwd()
  const gitRoot = findGitRoot(workdir)
  if (!gitRoot) {
    return { success: false, error: 'Not in a git repository' }
  }

  // 清除上次崩溃运行遗留的过时 ref，避免 --all 将其打包进 bundle。
  // 在空仓库检查之前运行，确保不会被提前返回跳过。
  for (const ref of ['refs/seed/stash', 'refs/seed/root']) {
    await execFileNoThrowWithCwd(gitExe(), ['update-ref', '-d', ref], {
      cwd: gitRoot,
    })
  }

  // `git bundle create` 拒绝创建空 bundle（退出码 128），
  // `stash create` 会报错 "You do not have the initial commit yet"。
  // 检查所有 ref（不仅是 HEAD），这样在其他位置有提交的孤立分支
  // 仍然可以打包——`--all` 会打包这些 ref，无论 HEAD 状态如何。
  const refCheck = await execFileNoThrowWithCwd(gitExe(), ['for-each-ref', '--count=1', 'refs/'], {
    cwd: gitRoot,
  })
  if (refCheck.code === 0 && refCheck.stdout.trim() === '') {
    logEvent('zy_ccr_bundle_upload', {
      outcome: 'empty_repo' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return {
      success: false,
      error: 'Repository has no commits yet',
      failReason: 'empty_repo',
    }
  }

  // stash create 会写入一个悬空提交——不会修改 refs/stash 或工作树。
  // 有意排除未跟踪文件。
  const stashResult = await execFileNoThrowWithCwd(gitExe(), ['stash', 'create'], {
    cwd: gitRoot,
    abortSignal: opts?.signal,
  })
  // 退出码 0 + 空 stdout = 无需 stash。非零退出码罕见且非致命。
  const wipStashSha = stashResult.code === 0 ? stashResult.stdout.trim() : ''
  const hasWip = wipStashSha !== ''
  if (stashResult.code !== 0) {
    logForDebugging(
      `[gitBundle] git stash create failed (${stashResult.code}), proceeding without WIP: ${stashResult.stderr.slice(0, 200)}`,
    )
  } else if (hasWip) {
    logForDebugging(`[gitBundle] Captured WIP as stash ${wipStashSha}`)
    // env-runner 通过 bundle list-heads refs/seed/stash 读取该 SHA。
    await execFileNoThrowWithCwd(gitExe(), ['update-ref', 'refs/seed/stash', wipStashSha], {
      cwd: gitRoot,
    })
  }

  const bundlePath = generateTempFilePath('ccr-seed', '.bundle')

  // git 在非零退出时会留下部分文件（例如空仓库时退出码 128）。
  try {
    const maxBytes =
      getFeatureValue_CACHED_MAY_BE_STALE<number | null>('zy_ccr_bundle_max_bytes', null) ??
      DEFAULT_BUNDLE_MAX_BYTES

    const bundle = await _bundleWithFallback(gitRoot, bundlePath, maxBytes, hasWip, opts?.signal)

    if (!bundle.ok) {
      logForDebugging(`[gitBundle] ${(bundle as any).error}`)
      logEvent('zy_ccr_bundle_upload', {
        outcome: (bundle as any)
          .failReason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        max_bytes: maxBytes,
      })
      return {
        success: false,
        error: (bundle as any).error,
        failReason: (bundle as any).failReason,
      }
    }

    // 固定的 relativePath，以便 CCR 能定位到它。
    const upload = await uploadFile(bundlePath, '_source_seed.bundle', config, {
      signal: opts?.signal,
    })

    if (!upload.success) {
      logEvent('zy_ccr_bundle_upload', {
        outcome: 'failed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      return { success: false, error: (upload as any).error }
    }

    logForDebugging(`[gitBundle] Uploaded ${upload.size} bytes as file_id ${upload.fileId}`)
    logEvent('zy_ccr_bundle_upload', {
      outcome: 'success' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      size_bytes: upload.size,
      scope: bundle.scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      has_wip: hasWip,
    })
    return {
      success: true,
      fileId: upload.fileId,
      bundleSizeBytes: upload.size,
      scope: bundle.scope,
      hasWip,
    }
  } finally {
    try {
      await unlink(bundlePath)
    } catch {
      logForDebugging(`[gitBundle] Could not delete ${bundlePath} (non-fatal)`)
    }
    // 始终删除——同时清除上次崩溃运行遗留的过时 ref。
    // 对不存在的 ref 执行 update-ref -d 会以退出码 0 正常退出。
    for (const ref of ['refs/seed/stash', 'refs/seed/root']) {
      await execFileNoThrowWithCwd(gitExe(), ['update-ref', '-d', ref], {
        cwd: gitRoot,
      })
    }
  }
}
