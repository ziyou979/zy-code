import { getHeapStatistics } from 'node:v8'
import { tSync } from '../../i18n/index.js'

const MB = 1024 * 1024
const GB = 1024 * MB

function fmt(bytes: number, decimals = 1): string {
  if (bytes >= GB) return (bytes / GB).toFixed(decimals) + ' GB'
  if (bytes >= MB) return (bytes / MB).toFixed(decimals) + ' MB'
  return (bytes / 1024).toFixed(decimals) + ' KB'
}

function bar(value: number, max: number, width = 16): string {
  const filled = Math.min(Math.round((value / max) * width), width)
  const empty = width - filled
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return '█'.repeat(filled) + '░'.repeat(empty) + ` (${pct}%)`
}

export async function call(args: string): Promise<{ type: 'text'; value: string }> {
  const usage = process.memoryUsage()
  const heapStats = getHeapStatistics()
  const uptime = process.uptime()
  const resourceUsage = process.resourceUsage()

  // 计算内存增长率
  const bytesPerSecond = uptime > 0 ? usage.rss / uptime : 0
  const mbPerHour = (bytesPerSecond * 3600) / MB

  // 计算 native 内存（RSS - heapUsed）
  const nativeMem = usage.rss - usage.heapUsed

  // heap limit = 堆大小限制（来自 v8 heap_size_limit）或 max-old-space-size
  const heapLimit = heapStats.heap_size_limit
  const heapUsedRatio = usage.heapUsed / Math.max(heapLimit, 1)

  // 生成内存报告
  const lines: string[] = []
  lines.push(tSync('commands.mem.reportHeader'))
  lines.push('')
  lines.push(tSync('commands.mem.processMemory'))
  lines.push(`  RSS:         ${fmt(usage.rss)}  ${bar(usage.rss, Math.max(usage.rss, 2 * GB))}`)
  lines.push(
    `  Heap Used:   ${fmt(usage.heapUsed)}  ${bar(usage.heapUsed, Math.max(usage.heapTotal, 1))}`,
  )
  lines.push(`  Heap Total:  ${fmt(usage.heapTotal)}`)
  lines.push(`  External:    ${fmt(usage.external)}`)
  if (usage.arrayBuffers) {
    lines.push(`  ArrayBuffer: ${fmt(usage.arrayBuffers)}`)
  }
  lines.push(`  Native:      ${fmt(nativeMem)} ${tSync('commands.mem.nativeDesc')}`)
  lines.push(`  Heap Limit:  ${fmt(heapLimit)}`)
  lines.push('')
  lines.push(tSync('commands.mem.v8HeapDetails'))
  lines.push(`  Detached Contexts: ${heapStats.number_of_detached_contexts}`)
  lines.push(`  Native Contexts:   ${heapStats.number_of_native_contexts}`)
  lines.push(`  Malloced Memory:   ${fmt(heapStats.malloced_memory)}`)
  lines.push(`  Peak Malloced:     ${fmt(heapStats.peak_malloced_memory)}`)
  lines.push('')
  lines.push(tSync('commands.mem.systemInfo'))
  lines.push(tSync('commands.mem.uptime', { minutes: Math.floor(uptime / 60) }))
  lines.push(tSync('commands.mem.maxRss', { size: fmt(resourceUsage.maxRSS * 1024) }))
  lines.push(tSync('commands.mem.growthRate', { rate: mbPerHour.toFixed(1) }))
  lines.push('')

  // 分析与警告
  const warnings: string[] = []

  if (usage.rss > 1.5 * GB) {
    warnings.push(tSync('commands.mem.rssWarning', { size: fmt(usage.rss) }))
  }
  if (heapUsedRatio > 0.8) {
    warnings.push(tSync('commands.mem.heapWarning', { percent: (heapUsedRatio * 100).toFixed(0) }))
  }
  if (mbPerHour > 200) {
    warnings.push(tSync('commands.mem.growthWarning', { rate: mbPerHour.toFixed(0) }))
  }
  if (heapStats.number_of_detached_contexts > 5) {
    warnings.push(
      tSync('commands.mem.detachedWarning', { count: heapStats.number_of_detached_contexts }),
    )
  }

  if (warnings.length > 0) {
    lines.push(tSync('commands.mem.warnings'))
    for (const w of warnings) {
      lines.push(`  ${w}`)
    }
    lines.push('')
  }

  // 建议
  const tips: string[] = []
  if (usage.rss > 1.5 * GB) {
    tips.push(tSync('commands.mem.tipHeapdump'))
    tips.push(tSync('commands.mem.tipCompact'))
  }
  if (heapLimit > 4 * GB) {
    tips.push(tSync('commands.mem.tipHeapLimit', { limit: fmt(heapLimit) }))
  }
  if (uptime > 600 && mbPerHour > 100) {
    tips.push(tSync('commands.mem.tipRestart'))
  }
  tips.push(tSync('commands.mem.tipFileState'))
  tips.push(tSync('commands.mem.tipTaskOutput'))

  if (tips.length > 0) {
    lines.push(tSync('commands.mem.suggestions'))
    for (const t of tips) {
      lines.push(`  ${t}`)
    }
    lines.push('')
  }

  lines.push(tSync('commands.mem.reportFooter'))

  return { type: 'text', value: lines.join('\n') }
}
