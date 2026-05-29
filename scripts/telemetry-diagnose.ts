#!/usr/bin/env bun
/**
 * 隔离测试 ZY event logging 写盘链路是否工作。
 *
 * 运行方式：
 *   bun run scripts/telemetry-diagnose.ts
 *
 * 退出后查看 ~/.zy/telemetry/zy_events.log 是否产生新行。
 */

import { existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LOG_FILE = join(homedir(), '.zy', 'telemetry', 'zy_events.log')

console.log(`\n📍 目标文件：${LOG_FILE}`)
const beforeExists = existsSync(LOG_FILE)
const beforeSize = beforeExists ? statSync(LOG_FILE).size : 0
console.log(`  · 测试前：${beforeExists ? `存在 (${beforeSize}B)` : '不存在'}\n`)

const { initializeZyEventLogging, shutdownZyEventLogging, isZyEventLoggingEnabled } = await import(
  '../src/services/analytics/zyEventLogger.js'
)
const { initializeAnalyticsSink } = await import('../src/services/analytics/sink.js')
const { logEvent } = await import('../src/services/analytics/index.js')

console.log(`🔍 isZyEventLoggingEnabled() = ${isZyEventLoggingEnabled()}`)
console.log(`🔍 NODE_ENV = ${process.env.NODE_ENV ?? '(unset)'}`)
console.log(`🔍 DISABLE_TELEMETRY = ${process.env.DISABLE_TELEMETRY ?? '(unset)'}`)
console.log(
  `🔍 ZY_CODE_DISABLE_NONESSENTIAL_TRAFFIC = ${process.env.ZY_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? '(unset)'}`,
)

if (!isZyEventLoggingEnabled()) {
  console.log(`\n❌ event logging 被禁用，链路根本不会运行。`)
  process.exit(1)
}

console.log(`\n⚙  1. initializeZyEventLogging() …`)
initializeZyEventLogging()

console.log(`⚙  2. initializeAnalyticsSink() …`)
initializeAnalyticsSink()

console.log(`⚙  3. logEvent('zy_telemetry_diagnose_test', {...}) × 3`)
for (let i = 0; i < 3; i++) {
  logEvent('zy_telemetry_diagnose_test', { iteration: i, ts: Date.now() })
}

console.log(`⚙  4. 等待 batch 处理器（默认 10s flush 间隔，主动调 shutdown 触发立即 flush）…`)
await shutdownZyEventLogging()

console.log(`⚙  5. 复检：`)
const afterExists = existsSync(LOG_FILE)
const afterSize = afterExists ? statSync(LOG_FILE).size : 0
console.log(`  · 测试后：${afterExists ? `存在 (${afterSize}B)` : '不存在'}`)

if (afterExists && afterSize > beforeSize) {
  console.log(`\n✅ 写盘成功！新增 ${afterSize - beforeSize}B`)
  console.log(`   验证：tail -3 ${LOG_FILE}\n`)
  process.exit(0)
}

console.log(`\n❌ 文件没增长。链路某一环失败：`)
console.log(`   - 可能 zyEventLogger 内部 emit 异常被吞`)
console.log(`   - 可能 BatchLogRecordProcessor 没及时 flush`)
console.log(`   - 可能 LocalFileExporter.export() 的 appendFileSync 静默失败`)
process.exit(2)
