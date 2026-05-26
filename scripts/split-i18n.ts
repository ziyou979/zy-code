import { writeFileSync } from 'node:fs'
import { en } from '../src/i18n/locales/en.js'
import { zhCN } from '../src/i18n/locales/zh-CN.js'

const groupRules: Array<[string, string[]]> = [
  ['mcp', ['mcp']],
  ['permissions', ['permission', 'permissionRules', 'bashSecurity']],
  ['onboarding', ['onboarding', 'tip']],
  ['commands', ['commands']],
  ['tasks', ['backgroundTasks', 'bg']],
  ['agents', ['agents', 'agent', 'agentProgress', 'agentView']],
  ['summary', ['summary', 'compactSummary']],
  ['settings', ['settings', 'wizard', 'doctor']],
  ['chat', ['chat', 'attachment', 'attachments', 'contextVis', 'contextSuggestions']],
  [
    'session',
    ['oauth', 'worktree', 'rateLimit', 'channel', 'channels', 'desktop', 'desktopHandoff'],
  ],
  ['shell', ['bash', 'shell', 'exitWorktree', 'computerUse']],
  ['stats', ['stats', 'costTracker', 'diagnostics']],
  [
    'ui',
    [
      'common',
      'dialog',
      'exitFlow',
      'diffDialog',
      'copy',
      'feedback',
      'feedbackSurvey',
      'exitPlanMode',
      'elicitation',
      'app',
      'apiKey',
      'export',
    ],
  ],
]

function groupOf(key: string): string {
  const prefix = key.split('.')[0] ?? ''
  for (const [group, prefixes] of groupRules) {
    if (prefixes.includes(prefix)) return group
  }
  return 'misc'
}

function escapeTsString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')
}

function emitGroup(
  varPrefix: string,
  group: string,
  entries: Array<[string, string]>,
  outputDir: string,
): void {
  const cap = group[0]!.toUpperCase() + group.slice(1)
  const lines = [
    `import type { TranslationResource } from '../resourceTypes.js'`,
    '',
    `export const ${varPrefix}${cap}: TranslationResource = {`,
  ]
  for (const [k, v] of entries) {
    lines.push(`  '${k}': '${escapeTsString(v)}',`)
  }
  lines.push('}', '')
  writeFileSync(`src/i18n/locales/${outputDir}/${group}.ts`, lines.join('\n'))
}

function emitBarrel(
  exportName: string,
  varPrefix: string,
  groups: string[],
  outputFile: string,
  description: string,
): void {
  const dirName = outputFile.split('.')[0]!
  const lines = [`import type { TranslationResource } from './resourceTypes.js'`]
  for (const g of groups) {
    const cap = g[0]!.toUpperCase() + g.slice(1)
    lines.push(`import { ${varPrefix}${cap} } from './${dirName}/${g}.js'`)
  }
  lines.push(
    '',
    '/**',
    ` * ${description}`,
    ' *',
    ' * 按 prefix 分组到 ./<locale>/<group>.ts；本文件仅做合并入口，无业务逻辑。',
    ' * 新增 key 时：',
    ' *   1. 在对应分组文件加，按 key 字典序排列',
    ' *   2. 同步在另一个 locale 的同名分组文件加',
    ' *   3. 不属于现有分组的零散 key 进 misc.ts',
    ' */',
    `export const ${exportName}: TranslationResource = {`,
  )
  for (const g of groups) {
    const cap = g[0]!.toUpperCase() + g.slice(1)
    lines.push(`  ...${varPrefix}${cap},`)
  }
  lines.push('}', '')
  writeFileSync(`src/i18n/locales/${outputFile}`, lines.join('\n'))
}

function processLocale(
  source: Record<string, string>,
  exportName: string,
  varPrefix: string,
  outputDir: string,
  outputFile: string,
  description: string,
): void {
  const grouped: Record<string, Array<[string, string]>> = {}
  for (const [k, v] of Object.entries(source)) {
    const g = groupOf(k)
    ;(grouped[g] ??= []).push([k, v])
  }
  const groupOrder: string[] = []
  for (const [name] of groupRules) {
    if (grouped[name]?.length) groupOrder.push(name)
  }
  if (grouped.misc?.length) groupOrder.push('misc')
  for (const g of groupOrder) {
    const entries = grouped[g]!.sort(([a], [b]) => a.localeCompare(b))
    emitGroup(varPrefix, g, entries, outputDir)
    console.log(`  ${outputDir}/${g}.ts: ${entries.length} keys`)
  }
  emitBarrel(exportName, varPrefix, groupOrder, outputFile, description)
}

processLocale(en, 'en', 'en', 'en', 'en.ts', 'English — base language (source of truth for keys)')
processLocale(zhCN, 'zhCN', 'zh', 'zh-CN', 'zh-CN.ts', '简体中文')

const enKeys = new Set(Object.keys(en))
const zhKeys = new Set(Object.keys(zhCN))
console.log(`verify: en=${enKeys.size}, zh=${zhKeys.size}`)
