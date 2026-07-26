import { getHeapStatistics } from 'node:v8'

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
  lines.push('━━━ 内存使用报告 ━━━')
  lines.push('')
  lines.push('进程内存:')
  lines.push(`  RSS:         ${fmt(usage.rss)}  ${bar(usage.rss, Math.max(usage.rss, 2 * GB))}`)
  lines.push(
    `  Heap Used:   ${fmt(usage.heapUsed)}  ${bar(usage.heapUsed, Math.max(usage.heapTotal, 1))}`,
  )
  lines.push(`  Heap Total:  ${fmt(usage.heapTotal)}`)
  lines.push(`  External:    ${fmt(usage.external)}`)
  if (usage.arrayBuffers) {
    lines.push(`  ArrayBuffer: ${fmt(usage.arrayBuffers)}`)
  }
  lines.push(`  Native:      ${fmt(nativeMem)} (RSS - heapUsed, 含 native addon)`)
  lines.push(`  Heap Limit:  ${fmt(heapLimit)}`)
  lines.push('')
  lines.push('V8 堆详情:')
  lines.push(`  Detached Contexts: ${heapStats.number_of_detached_contexts}`)
  lines.push(`  Native Contexts:   ${heapStats.number_of_native_contexts}`)
  lines.push(`  Malloced Memory:   ${fmt(heapStats.malloced_memory)}`)
  lines.push(`  Peak Malloced:     ${fmt(heapStats.peak_malloced_memory)}`)
  lines.push('')
  lines.push('系统信息:')
  lines.push(`  运行时间: ${Math.floor(uptime / 60)} 分钟`)
  lines.push(`  最大 RSS: ${fmt(resourceUsage.maxRSS * 1024)}`)
  lines.push(`  内存增长率: ${mbPerHour.toFixed(1)} MB/小时`)
  lines.push('')

  // 分析与警告
  const warnings: string[] = []

  if (usage.rss > 1.5 * GB) {
    warnings.push(`⚠  RSS (${fmt(usage.rss)}) 超过 1.5GB，内存压力较大`)
  }
  if (heapUsedRatio > 0.8) {
    warnings.push(`⚠  堆使用率达到 ${(heapUsedRatio * 100).toFixed(0)}%，接近限制`)
  }
  if (mbPerHour > 200) {
    warnings.push(`⚠  内存增长率高 (${mbPerHour.toFixed(0)} MB/小时)，可能存在内存泄漏`)
  }
  if (heapStats.number_of_detached_contexts > 5) {
    warnings.push(`⚠  检测到 ${heapStats.number_of_detached_contexts} 个 detached context`)
  }

  if (warnings.length > 0) {
    lines.push('警告:')
    for (const w of warnings) {
      lines.push(`  ${w}`)
    }
    lines.push('')
  }

  // 建议
  const tips: string[] = []
  if (usage.rss > 1.5 * GB) {
    tips.push('• 运行 /heapdump 捕获堆快照以便离线分析')
    tips.push('• 运行 /compact 压缩对话上下文')
  }
  if (heapLimit > 4 * GB) {
    tips.push('• 当前 max-old-space-size 较大，可考虑降低 (当前上限 ' + fmt(heapLimit) + ')')
  }
  if (uptime > 600 && mbPerHour > 100) {
    tips.push('• 会话已运行较久且内存持续增长，考虑重启会话')
  }
  tips.push('• 检查 FileStateCache: ~25MB max')
  tips.push('• 检查 TaskOutput buffer: ~8MB max (溢出后落盘)')

  if (tips.length > 0) {
    lines.push('建议:')
    for (const t of tips) {
      lines.push(`  ${t}`)
    }
    lines.push('')
  }

  lines.push('━━━ 如需完整诊断，请运行 /heapdump ━━━')

  return { type: 'text', value: lines.join('\n') }
}
