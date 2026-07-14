#!/usr/bin/env bun
/**
 * 一次性迁移:把历史 session JSONL 里的会话级可变元数据搬到 sidecar
 * `<sessionId>.meta.json`,并清洗 message content(旧版纯字符串 → UserContentBlock[]):
 *
 *   1. message(user/assistant)的 content 若是 string → 转成 [{type:'text',text}]
 *   2. 抽取 custom-title / ai-title / last-prompt / task-summary / tag / agent-name /
 *      agent-color / agent-setting / pr-link / mode / worktree-state(last-wins)→ sidecar
 *   3. 从 JSONL 中剥离这些元数据行(sidecar 成为权威源)
 *
 * 默认 dry-run(只打印不写)。加 --apply 才真正写入;写入前对每个 .jsonl 做时间戳备份。
 *
 * 用法:
 *   bun scripts/migrate-session-sidecars.ts                 # 预览
 *   bun scripts/migrate-session-sidecars.ts --apply         # 执行(带备份)
 *   bun scripts/migrate-session-sidecars.ts --apply --no-backup
 *   bun scripts/migrate-session-sidecars.ts --project-dir <名称子串> --verbose
 */

import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { writeFileSyncAndFlush_DEPRECATED } from '../src/utils/file.js'
import { parseJSONL } from '../src/utils/json.js'
import { getProjectsDir } from '../src/utils/session-storagePortable.js'

const SIDECAR_VERSION = 1 as const
const MAX_SIZE = 50 * 1024 * 1024 // 50MB,与 MAX_TRANSCRIPT_READ_BYTES 一致
const METADATA_TYPES = new Set([
  'custom-title',
  'ai-title',
  'last-prompt',
  'task-summary',
  'tag',
  'agent-name',
  'agent-color',
  'agent-setting',
  'pr-link',
  'mode',
  'worktree-state',
])

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const NO_BACKUP = args.includes('--no-backup')
const VERBOSE = args.includes('--verbose')
const projectFilterIdx = args.indexOf('--project-dir')
const PROJECT_FILTER = projectFilterIdx >= 0 ? args[projectFilterIdx + 1] : undefined
const BACKUP_ROOT = join(
  getProjectsDir(),
  '..',
  `session-backups-${new Date().toISOString().replace(/[:.]/g, '-')}`,
)

const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i

type Entry = Record<string, unknown> & { type?: string; message?: { content?: unknown } }

function applyMetaEntry(meta: Record<string, unknown>, e: Entry): void {
  switch (e.type) {
    case 'custom-title':
      if (e.customTitle) meta.customTitle = e.customTitle
      break
    case 'ai-title':
      if (e.aiTitle) meta.aiTitle = e.aiTitle
      break
    case 'last-prompt':
      if (e.lastPrompt) meta.lastPrompt = e.lastPrompt
      break
    case 'task-summary':
      if (e.summary) meta.taskSummary = { summary: e.summary, timestamp: e.timestamp }
      break
    case 'tag':
      meta.tag = e.tag || undefined
      break
    case 'agent-name':
      if (e.agentName) meta.agentName = e.agentName
      break
    case 'agent-color':
      if (e.agentColor) meta.agentColor = e.agentColor
      break
    case 'agent-setting':
      if (e.agentSetting) meta.agentSetting = e.agentSetting
      break
    case 'pr-link':
      if (e.prNumber !== undefined && e.prUrl && e.prRepository) {
        meta.prLink = {
          prNumber: e.prNumber,
          prUrl: e.prUrl,
          prRepository: e.prRepository,
          timestamp: e.timestamp,
        }
      }
      break
    case 'mode':
      if (e.mode) meta.mode = e.mode
      break
    case 'worktree-state':
      // 三态:object / null(已退出)都保留;undefined 跳过
      if ('worktreeSession' in e) meta.worktreeState = e.worktreeSession
      break
  }
}

function readExistingSidecar(sidecarPath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(sidecarPath, 'utf-8'))
    return parsed?.version === SIDECAR_VERSION ? parsed : null
  } catch {
    return null
  }
}

function backup(jsonlPath: string, projectName: string): void {
  const destDir = join(BACKUP_ROOT, projectName)
  mkdirSync(destDir, { recursive: true })
  const dest = join(destDir, basename(jsonlPath))
  try {
    linkSync(jsonlPath, dest) // 同盘硬链:零额外空间
  } catch {
    copyFileSync(jsonlPath, dest) // 跨盘回退
  }
}

type FileStats = {
  metaLines: number
  normalized: number
  rewroteJsonl: boolean
  wroteSidecar: boolean
}

function migrateFile(jsonlPath: string, projectName: string): FileStats | null {
  const size = statSync(jsonlPath).size
  if (size > MAX_SIZE) {
    console.warn(`  ! 跳过(>${(MAX_SIZE / 1024 / 1024) | 0}MB): ${basename(jsonlPath)} (${size}B)`)
    return null
  }
  const sessionId = basename(jsonlPath).replace(/\.jsonl$/, '')
  const sidecarPath = jsonlPath.replace(/\.jsonl$/, '.meta.json')

  let entries: Entry[]
  try {
    entries = parseJSONL<Entry>(readFileSync(jsonlPath))
  } catch (e) {
    console.error(`  ! 解析失败,跳过: ${basename(jsonlPath)}: ${String(e)}`)
    return null
  }

  const meta: Record<string, unknown> = { version: SIDECAR_VERSION, sessionId }
  let metaLines = 0
  let normalized = 0
  const outLines: string[] = []

  for (const e of entries) {
    if (e?.type && METADATA_TYPES.has(e.type)) {
      metaLines++
      applyMetaEntry(meta, e)
      continue // 剥离
    }
    if (
      (e?.type === 'user' || e?.type === 'assistant') &&
      e.message &&
      typeof e.message.content === 'string'
    ) {
      e.message.content = [{ type: 'text', text: e.message.content }]
      normalized++
    }
    outLines.push(JSON.stringify(e))
  }

  const existing = readExistingSidecar(sidecarPath)
  // 幂等:JSONL 无元数据行且 sidecar 已存在 → 已迁移过,跳过 sidecar 重写。
  // 否则以现有 sidecar 为底、JSONL 抽取值覆盖(JSONL 是正在迁移的源)。
  const mergedMeta = metaLines > 0 ? { ...(existing ?? {}), ...meta } : (existing ?? meta)
  const wroteSidecar = metaLines > 0 || !existing
  const rewroteJsonl = metaLines > 0 || normalized > 0

  if (VERBOSE || !APPLY) {
    console.log(
      `  ${basename(jsonlPath)}: 元数据行 ${metaLines} → sidecar, content 归一 ${normalized}` +
        `${rewroteJsonl ? '' : ' (无变化)'}`,
    )
  }

  if (APPLY && (rewroteJsonl || wroteSidecar)) {
    if (!NO_BACKUP && rewroteJsonl) backup(jsonlPath, projectName)
    if (wroteSidecar) {
      mkdirSync(dirname(sidecarPath), { recursive: true })
      writeFileSyncAndFlush_DEPRECATED(sidecarPath, JSON.stringify(mergedMeta), {
        encoding: 'utf-8',
        mode: 0o600,
      })
    }
    if (rewroteJsonl) {
      writeFileSyncAndFlush_DEPRECATED(
        jsonlPath,
        outLines.length ? `${outLines.join('\n')}\n` : '',
        {
          encoding: 'utf-8',
          mode: 0o600,
        },
      )
    }
  }

  return { metaLines, normalized, rewroteJsonl, wroteSidecar }
}

function main(): void {
  const projectsDir = getProjectsDir()
  console.log(`projects 目录: ${projectsDir}`)
  console.log(
    APPLY
      ? `模式: APPLY${NO_BACKUP ? ' (无备份!)' : ` (备份→ ${BACKUP_ROOT})`}`
      : '模式: DRY-RUN(不写;加 --apply 执行)',
  )
  if (!existsSync(projectsDir)) {
    console.log('projects 目录不存在,无事可做。')
    return
  }

  let projectDirs: string[]
  try {
    projectDirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch (e) {
    console.error(`无法读取 projects 目录: ${String(e)}`)
    return
  }
  if (PROJECT_FILTER) projectDirs = projectDirs.filter((n) => n.includes(PROJECT_FILTER))

  const totals = { files: 0, metaLines: 0, normalized: 0, rewrote: 0, sidecars: 0, skipped: 0 }
  for (const projectName of projectDirs) {
    const projectDir = join(projectsDir, projectName)
    let files: string[]
    try {
      files = readdirSync(projectDir).filter((n) => UUID_JSONL.test(n))
    } catch {
      continue
    }
    if (files.length === 0) continue
    console.log(`\n[${projectName}] ${files.length} 个 session`)
    for (const f of files) {
      const stats = migrateFile(join(projectDir, f), projectName)
      if (!stats) {
        totals.skipped++
        continue
      }
      totals.files++
      totals.metaLines += stats.metaLines
      totals.normalized += stats.normalized
      if (stats.rewroteJsonl) totals.rewrote++
      if (stats.wroteSidecar) totals.sidecars++
    }
  }

  console.log('\n==== 汇总 ====')
  console.log(`处理文件: ${totals.files} (跳过 ${totals.skipped})`)
  console.log(`剥离元数据行: ${totals.metaLines};content 归一: ${totals.normalized}`)
  console.log(
    `${APPLY ? '已重写' : '将重写'} JSONL: ${totals.rewrote};${APPLY ? '已写' : '将写'} sidecar: ${totals.sidecars}`,
  )
  if (!APPLY) console.log('\n这是 DRY-RUN。确认无误后加 --apply 执行。')
}

main()
