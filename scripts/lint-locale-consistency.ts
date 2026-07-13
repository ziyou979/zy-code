/**
 * 翻译资源一致性检查脚本
 *
 * 检查内容：
 *   a. 双语 key 集合一致（en 和 zh-CN 必须对称）
 *   b. 相同 key 不重复声明
 *   c. 插值变量集合一致
 *   d. locale 子目录文件必须被聚合入口导入
 *   e. 禁止未使用的 locale 分组文件（powerupFrames.ts 设计如此，豁免）
 *
 * 用法：
 *   bun scripts/lint-locale-consistency.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const LOCALES_DIR = join(ROOT, 'src', 'i18n', 'locales')
const EN_DIR = join(LOCALES_DIR, 'en')
const ZH_DIR = join(LOCALES_DIR, 'zh-CN')

let exitCode = 0

function error(msg: string) {
  console.error(`  ❌ ${msg}`)
  exitCode = 1
}

// --------------- 加载翻译文件 ---------------

/**
 * 用正则提取 .ts 翻译文件中的所有 key-value 对。
 *
 * 匹配形如：
 *   'key.name': 'value with {var}',
 *   "key.name": "value",
 *   nested: { 'sub': 'val' },
 */
function extractKeysFromTS(content: string, fileLabel: string): Map<string, string> {
  const keys = new Map<string, string>()

  // 去掉注释
  const noComments = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

  // 按行处理（支持多行值）
  const lines = noComments.split('\n')
  let pendingKey: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (
      !line ||
      line === ',' ||
      line === '})' ||
      line.startsWith('import') ||
      line.startsWith('export type') ||
      line.startsWith('}')
    )
      continue

    // 如果有待处理的 key（上一行有 key: 但 value 在下一行）
    if (pendingKey) {
      const valMatch = line.match(/^(['"])((?:\\?.|\\?.)*?)\1\s*,?\s*$/)
      if (valMatch) {
        keys.set(pendingKey, valMatch[2])
        pendingKey = null
        continue
      }
      const tmplMatch = line.match(/^(`)((?:\\?.|\\?.)*?)\1\s*,?\s*$/)
      if (tmplMatch) {
        keys.set(pendingKey, tmplMatch[2])
        pendingKey = null
        continue
      }
      // 非字符串行，放弃
      pendingKey = null
    }

    // 匹配带引号的 key: 'xxx.yyy': ... 或 "xxx.yyy": ...
    const strKeyMatch = line.match(/^['"](\S+?)['"]\s*:\s*/)
    if (!strKeyMatch) continue

    const key = strKeyMatch[1]
    const rest = line.slice(strKeyMatch[0].length)

    // 跳过嵌套对象
    if (rest.startsWith('{')) continue

    // 字符串值: '...' 或 "..."
    const valMatch = rest.match(/^(['"])((?:\\?.|\\?.)*?)\1\s*,?\s*$/)
    if (valMatch) {
      keys.set(key, valMatch[2])
      continue
    }

    // 模板字符串: `...`
    if (rest.startsWith('`')) {
      const endIdx = rest.indexOf('`', 1)
      if (endIdx > 0) {
        keys.set(key, rest.slice(1, endIdx))
        continue
      }
    }

    // 值在下一行，暂存 key
    if (rest.trim() === '') {
      pendingKey = key
    } else {
      keys.set(key, '')
    }
  }

  return keys
}

function loadLocaleFiles(
  dir: string,
  label: string,
): Array<{ name: string; keys: Map<string, string> }> {
  const files: Array<{ name: string; keys: Map<string, string> }> = []
  if (!existsSync(dir)) return files

  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name === 'index.ts') continue
    const filePath = join(dir, entry.name)
    const content = readFileSync(filePath, 'utf-8')
    const keys = extractKeysFromTS(content, `${label}/${entry.name}`)
    files.push({ name: entry.name.replace('.ts', ''), keys })
  }
  return files
}

// --------------- 聚合检查 ---------------

function findAggregatedFiles(aggregatorPath: string): Set<string> {
  if (!existsSync(aggregatorPath)) return new Set()
  const content = readFileSync(aggregatorPath, 'utf-8')
  const aggregated = new Set<string>()
  const matches = content.matchAll(/from\s+['"]\.\/(?:en|zh-CN)\/([^'"]+)['"]/g)
  for (const match of matches) {
    aggregated.add(match[1].replace(/\.js$/, ''))
  }
  return aggregated
}

// --------------- 插值变量 ---------------

function extractInterpolations(value: string): Set<string> {
  const vars = new Set<string>()
  const matches = value.matchAll(/\{(\w+)\}/g)
  for (const match of matches) vars.add(match[1])
  return vars
}

// --------------- 主函数 ---------------

function main() {
  console.error('🔍 翻译资源一致性检查...\n')

  const enFiles = loadLocaleFiles(EN_DIR, 'en')
  const zhFiles = loadLocaleFiles(ZH_DIR, 'zh-CN')
  const enAggregated = findAggregatedFiles(join(LOCALES_DIR, 'en.ts'))
  const zhAggregated = findAggregatedFiles(join(LOCALES_DIR, 'zh-CN.ts'))

  const enNames = new Set(readdirSync(EN_DIR).filter((f) => f.endsWith('.ts') && f !== 'index.ts'))
  const zhNames = new Set(readdirSync(ZH_DIR).filter((f) => f.endsWith('.ts') && f !== 'index.ts'))

  const enTotal = enFiles.reduce((s, f) => s + f.keys.size, 0)
  const zhTotal = zhFiles.reduce((s, f) => s + f.keys.size, 0)

  console.error(`📊 文件统计：`)
  console.error(`  en/: ${enNames.size} 文件, ${enTotal} keys`)
  console.error(`  zh-CN/: ${zhNames.size} 文件, ${zhTotal} keys\n`)

  // 聚合检查
  for (const fn of enNames) {
    const name = fn.replace('.ts', '')
    if (!enAggregated.has(name) && fn !== 'powerupFrames.ts') {
      error(`en/${fn} 未被 en.ts 聚合入口导入`)
    }
  }
  for (const fn of zhNames) {
    const name = fn.replace('.ts', '')
    if (!zhAggregated.has(name) && fn !== 'powerupFrames.ts') {
      error(`zh-CN/${fn} 未被 zh-CN.ts 聚合入口导入`)
    }
  }

  // 合并 key
  const enAll = new Map<string, string>()
  const enSrc = new Map<string, string>()
  for (const f of enFiles) {
    for (const [k, v] of f.keys) {
      if (enAll.has(k)) error(`en/ 中 key "${k}" 重复`)
      enAll.set(k, v)
      enSrc.set(k, f.name)
    }
  }
  const zhAll = new Map<string, string>()
  const zhSrc = new Map<string, string>()
  for (const f of zhFiles) {
    for (const [k, v] of f.keys) {
      if (zhAll.has(k)) error(`zh-CN/ 中 key "${k}" 重复`)
      zhAll.set(k, v)
      zhSrc.set(k, f.name)
    }
  }

  // 对称性
  let enOnly = 0
  let zhOnly = 0
  for (const [k] of enAll) {
    if (!zhAll.has(k)) {
      enOnly++
      if (enOnly <= 10) error(`en-only key: "${k}"（${enSrc.get(k)}）`)
    }
  }
  for (const [k] of zhAll) {
    if (!enAll.has(k)) {
      zhOnly++
      if (zhOnly <= 10) error(`zh-CN-only key: "${k}"（${zhSrc.get(k)}）`)
    }
  }
  if (enOnly > 10) error(`...及其他 ${enOnly - 10} 个 en-only keys`)
  if (zhOnly > 10) error(`...及其他 ${zhOnly - 10} 个 zh-CN-only keys`)

  console.error(`\n📊 对称性：`)
  console.error(`  en-only: ${enOnly}`)
  console.error(`  zh-CN-only: ${zhOnly}`)

  // 插值变量一致性
  let mismatch = 0
  for (const [k, ev] of enAll) {
    const zv = zhAll.get(k)
    if (!zv) continue
    const evars = extractInterpolations(ev)
    const zvars = extractInterpolations(zv)
    const onlyE = [...evars].filter((v) => !zvars.has(v))
    const onlyZ = [...zvars].filter((v) => !evars.has(v))
    if (onlyE.length || onlyZ.length) {
      mismatch++
      if (mismatch <= 5)
        error(`"${k}" 插值不一致: en-only=${onlyE.join(',')} zh-only=${onlyZ.join(',')}`)
    }
  }
  if (mismatch > 5) error(`...及其他 ${mismatch - 5} 个插值不一致`)
  console.error(`  插值不一致: ${mismatch}`)

  console.error('')
  if (exitCode === 0) {
    console.error('✅ 翻译资源一致性检查通过')
  } else {
    console.error(`❌ 检查未通过`)
  }
  process.exit(exitCode)
}

main()
