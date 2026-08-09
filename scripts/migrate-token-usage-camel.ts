#!/usr/bin/env bun
/**
 * 一次性迁移：会话 JSONL 中 assistant.message.usage 的 snake_case → camelCase。
 *
 * 目标字段：
 *   input_tokens → inputTokens
 *   output_tokens → outputTokens
 *   cache_creation_input_tokens → cacheCreationInputTokens
 *   cache_read_input_tokens → cacheReadInputTokens
 *
 * 同时删除上述 snake 键（以及双写残留），避免运行时再做兼容分支。
 * Anthropic provider 边界的 snake 响应转换不在此脚本范围内。
 *
 * 默认 dry-run。加 --apply 才写入；写入前按项目做时间戳备份。
 * 按行流式处理，可覆盖超大 JSONL。
 *
 * 用法：
 *   bun scripts/migrate-token-usage-camel.ts
 *   bun scripts/migrate-token-usage-camel.ts --apply
 *   bun scripts/migrate-token-usage-camel.ts --apply --no-backup
 *   bun scripts/migrate-token-usage-camel.ts --project-dir <名称子串> --verbose
 *   bun scripts/migrate-token-usage-camel.ts --path <单个.jsonl>
 */

import {
  copyFileSync,
  createReadStream,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createInterface } from 'node:readline'
import { basename, dirname, join } from 'node:path'
import { getProjectsDir } from '../src/services/session-storage/sessionStoragePortable.js'

const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i
const AGENT_JSONL = /^agent-.+\.jsonl$/i

const SNAKE_TO_CAMEL = {
  input_tokens: 'inputTokens',
  output_tokens: 'outputTokens',
  cache_creation_input_tokens: 'cacheCreationInputTokens',
  cache_read_input_tokens: 'cacheReadInputTokens',
} as const

const SNAKE_KEYS = Object.keys(SNAKE_TO_CAMEL) as Array<keyof typeof SNAKE_TO_CAMEL>

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const NO_BACKUP = args.includes('--no-backup')
const VERBOSE = args.includes('--verbose')
const projectFilterIdx = args.indexOf('--project-dir')
const PROJECT_FILTER = projectFilterIdx >= 0 ? args[projectFilterIdx + 1] : undefined
const pathIdx = args.indexOf('--path')
const SINGLE_PATH = pathIdx >= 0 ? args[pathIdx + 1] : undefined
const BACKUP_ROOT = join(
  getProjectsDir(),
  '..',
  `token-usage-backups-${new Date().toISOString().replace(/[:.]/g, '-')}`,
)

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** 将单个 usage 对象迁到 camel；返回是否改动 */
function migrateUsageObject(usage: Record<string, unknown>): boolean {
  let changed = false

  for (const snake of SNAKE_KEYS) {
    const camel = SNAKE_TO_CAMEL[snake]
    const snakeVal = num(usage[snake])
    const camelVal = num(usage[camel])

    if (snakeVal !== undefined) {
      // camel 缺失或为 0 时采用 snake；两者都有且不同时保留 camel（写侧标准），仍删 snake
      if (camelVal === undefined || camelVal === 0) {
        usage[camel] = snakeVal
        changed = true
      } else if (camelVal !== snakeVal && VERBOSE) {
        console.warn(`    ! usage 冲突保留 camel ${camel}=${camelVal}（丢弃 ${snake}=${snakeVal}）`)
      }
      delete usage[snake]
      changed = true
    } else if (snake in usage) {
      delete usage[snake]
      changed = true
    }
  }

  return changed
}

function walkAndMigrateUsage(value: unknown): number {
  let hits = 0
  if (!value || typeof value !== 'object') {
    return 0
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      hits += walkAndMigrateUsage(item)
    }
    return hits
  }

  const obj = value as Record<string, unknown>

  const message = obj.message
  if (message && typeof message === 'object' && !Array.isArray(message)) {
    const msg = message as Record<string, unknown>
    if (msg.usage && typeof msg.usage === 'object' && !Array.isArray(msg.usage)) {
      if (migrateUsageObject(msg.usage as Record<string, unknown>)) {
        hits++
      }
    }
  }

  if (obj.usage && typeof obj.usage === 'object' && !Array.isArray(obj.usage)) {
    if (
      !(
        message &&
        typeof message === 'object' &&
        (message as { usage?: unknown }).usage === obj.usage
      )
    ) {
      if (migrateUsageObject(obj.usage as Record<string, unknown>)) {
        hits++
      }
    }
  }

  return hits
}

function backup(jsonlPath: string, projectName: string): void {
  const destDir = join(BACKUP_ROOT, projectName)
  mkdirSync(destDir, { recursive: true })
  const dest = join(destDir, basename(jsonlPath))
  try {
    linkSync(jsonlPath, dest)
  } catch {
    copyFileSync(jsonlPath, dest)
  }
}

type FileStats = { migratedUsages: number; rewrote: boolean }

async function migrateFile(jsonlPath: string, projectName: string): Promise<FileStats> {
  const rl = createInterface({
    input: createReadStream(jsonlPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  })

  let migratedUsages = 0
  const outLines: string[] = []
  let lineNo = 0

  for await (const line of rl) {
    lineNo++
    if (!line.trim()) {
      outLines.push(line)
      continue
    }
    try {
      const entry = JSON.parse(line) as unknown
      migratedUsages += walkAndMigrateUsage(entry)
      outLines.push(JSON.stringify(entry))
    } catch (e) {
      // 坏行原样保留，不中断整文件
      if (VERBOSE) {
        console.warn(`    ! 第 ${lineNo} 行解析失败，原样保留: ${String(e)}`)
      }
      outLines.push(line)
    }
  }

  const rewrote = migratedUsages > 0
  if (VERBOSE || !APPLY || rewrote) {
    console.log(
      `  ${basename(jsonlPath)}: usage 迁移 ${migratedUsages}` + `${rewrote ? '' : ' (无变化)'}`,
    )
  }

  if (APPLY && rewrote) {
    if (!NO_BACKUP) backup(jsonlPath, projectName)
    const tmp = `${jsonlPath}.tmp-migrate-usage`
    writeFileSync(tmp, outLines.length ? `${outLines.join('\n')}\n` : '', {
      encoding: 'utf-8',
      mode: 0o600,
    })
    renameSync(tmp, jsonlPath)
  }

  return { migratedUsages, rewrote }
}

function isSessionJsonl(name: string): boolean {
  return UUID_JSONL.test(name) || AGENT_JSONL.test(name)
}

async function main(): Promise<void> {
  if (SINGLE_PATH) {
    const p = SINGLE_PATH
    if (!existsSync(p)) {
      console.error(`路径不存在: ${p}`)
      process.exit(1)
    }
    console.log(
      APPLY
        ? `模式: APPLY 单文件${NO_BACKUP ? ' (无备份!)' : ` (备份→ ${BACKUP_ROOT})`}`
        : '模式: DRY-RUN 单文件(不写;加 --apply 执行)',
    )
    const projectName = basename(dirname(p)) || 'single'
    await migrateFile(p, projectName)
    return
  }

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

  const totals = { files: 0, migratedUsages: 0, rewrote: 0, skipped: 0 }
  for (const projectName of projectDirs) {
    const projectDir = join(projectsDir, projectName)
    let files: string[]
    try {
      files = readdirSync(projectDir).filter(isSessionJsonl)
    } catch {
      continue
    }
    if (files.length === 0) continue
    console.log(`\n[${projectName}] ${files.length} 个 session/agent jsonl`)
    for (const f of files) {
      try {
        const stats = await migrateFile(join(projectDir, f), projectName)
        totals.files++
        totals.migratedUsages += stats.migratedUsages
        if (stats.rewrote) totals.rewrote++
      } catch (e) {
        totals.skipped++
        console.error(`  ! 失败 ${f}: ${String(e)}`)
        // 清理可能残留的 tmp
        const tmp = join(projectDir, `${f}.tmp-migrate-usage`)
        if (existsSync(tmp)) {
          try {
            unlinkSync(tmp)
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  console.log('\n==== 汇总 ====')
  console.log(`处理文件: ${totals.files} (失败 ${totals.skipped})`)
  console.log(`usage 对象迁移次数: ${totals.migratedUsages}`)
  console.log(`${APPLY ? '已重写' : '将重写'} JSONL: ${totals.rewrote}`)
  if (!APPLY && totals.rewrote > 0) {
    console.log('\n确认无误后执行: bun scripts/migrate-token-usage-camel.ts --apply')
  }
}

await main()
