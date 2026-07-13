/**
 * 架构边界检查脚本
 *
 * 检查内容：
 *   A. src/ 根文件 — 禁止新增（历史文件进入 debt baseline）
 *   B. utils 边界 — 无 IO、无服务/UI/Tool/状态依赖、无 i18n、无终端输出
 *   C. 层间依赖 — services -> components/screens/ink，types -> services/components/state
 *   D. 导入后缀 — 相对导入必须带 .js/.json/.node/.wasm
 *   E. feature() 宏 — 禁止非法的非直接条件用法
 *   F. as any 统计 — 统计各文件使用量，与基线比较
 *
 * 用法：
 *   bun scripts/lint-architecture.ts              # 与基线比较（默认）
 *   bun scripts/lint-architecture.ts --verbose    # 显示完整违规清单
 *   bun scripts/lint-architecture.ts --write-baseline  # 更新基线
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'

// --------------- 辅助函数 ---------------

const ROOT = resolve(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')
const BASELINE_PATH = join(ROOT, 'scripts', 'architecture-debt-baseline.json')

function walkDir(dir: string): string[] {
  const files: string[] = []
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        files.push(...walkDir(full))
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
        files.push(full)
      }
    }
  } catch {
    // skip
  }
  return files
}

function getRelativePath(absPath: string): string {
  return relative(SRC, absPath).replace(/\\/g, '/')
}

function toForwardPath(absPath: string): string {
  return absPath.replace(/\\/g, '/')
}

function countOccurrences(content: string, pattern: RegExp): number {
  const matches = content.match(pattern)
  return matches ? matches.length : 0
}

/** 已知的兼容转发目录 — 仅允许纯 re-export 文件 */
const KNOWN_COMPAT_DIRS = [
  '/utils/hooks/',
  '/utils/permissions/',
  '/utils/plugins/',
  '/utils/sessionStorage/',
]

function isKnownCompatDir(filePath: string): boolean {
  const normalized = toForwardPath(filePath)
  return KNOWN_COMPAT_DIRS.some((d) => normalized.includes(d))
}

/** 检查文件是否是已知兼容目录中的纯 re-export 文件 */
function isCompatReexport(content: string): boolean {
  const lines = content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('*'))
  // 只允许 export/import type + re-export 语句
  return lines.every(
    (l) =>
      /^export\s+(type\s+)?\{/.test(l) ||
      /^export\s+\*\s+from/.test(l) ||
      /^import\s+type/.test(l) ||
      l === '',
  )
}

// --------------- 基线和违规收集 ---------------

interface Violation {
  file: string
  line: number
  message: string
  category: string
}

const violations: Violation[] = []

function addV(file: string, line: number, msg: string, cat: string) {
  violations.push({ file, line, message: msg, category: cat })
}

// --------------- 违规 ID 生成（用于精确基线匹配） ---------------

interface BaselineEntry {
  id: string // category + file + rule detail
  category: string
  file: string
  line: number
  message: string
}

function makeBaselineId(category: string, file: string, detail: string): string {
  return `${category}|${getRelativePath(file)}|${detail}`
}

// --------------- A. src/ 根文件检查 ---------------

const ALLOWED_ROOT_FILES = new Set(['main.tsx', 'macro.d.ts'])

const HISTORIC_ROOT_FILES = new Set([
  'QueryEngine.ts',
  'Task.ts',
  'Tool.ts',
  'commands.ts',
  'context.ts',
  'cost-tracker.ts',
  'costHook.ts',
  'dialogLaunchers.tsx',
  'history.ts',
  'ink.ts',
  'interactiveHelpers.tsx',
  'projectOnboardingState.ts',
  'query.ts',
  'replLauncher.tsx',
  'setup.ts',
  'tasks.ts',
  'tools.ts',
])

function checkRootFiles() {
  const entries = readdirSync(SRC, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      if (!ALLOWED_ROOT_FILES.has(entry.name)) {
        const isHistoric = HISTORIC_ROOT_FILES.has(entry.name)
        addV(
          join(SRC, entry.name),
          1,
          isHistoric
            ? `src/ 根目录历史文件 ${entry.name}（允许存量，禁止新增）`
            : `src/ 根目录新增文件 ${entry.name}（禁止）`,
          'rootFile',
        )
      }
    }
  }
}

// --------------- B. utils 边界检查 ---------------

const IO_IMPORT_PATTERNS = [
  // node: 协议
  /from\s+['"]node:(?:fs|child_process|net|http|https|dgram|cluster)(?:\/|['"])/,
  /require\(['"]node:(?:fs|child_process|net|http|https|dgram|cluster)(?:\/|['"])\)/,
]

// 已知的 IO 类外部依赖（它们执行网络、文件系统或进程操作）
const IO_EXTERNAL_DEPS = [
  'execa',
  'axios',
  'undici',
  'proper-lockfile',
  'chokidar',
  'tree-kill',
  'signal-exit',
  'ws',
  'node-fetch',
]

const FORBIDDEN_DEP_PATTERNS: Array<{ pattern: RegExp }> = [
  { pattern: /from\s+['"][^'"]*\/services\// },
  { pattern: /from\s+['"][^'"]*\/components\// },
  { pattern: /from\s+['"][^'"]*\/screens\// },
  { pattern: /from\s+['"][^'"]*\/tools\// },
  { pattern: /from\s+['"][^'"]*\/state\// },
]

const I18N_IMPORT_PATTERN = /from\s+['"][^'"]*\/i18n\//

const CONSOLE_PATTERNS = [
  /console\.(log|warn|error)\(/,
  /process\.stdout\.write\(/,
  /process\.stderr\.write\(/,
]

function checkUtilsBoundary() {
  const utilsDir = join(SRC, 'utils')
  if (!existsSync(utilsDir)) return

  const files = walkDir(utilsDir)
  for (const file of files) {
    const content = readFileSync(file, 'utf-8')
    const lines = content.split('\n')

    const relPath = getRelativePath(file)
    const normalized = toForwardPath(file)

    // 兼容目录：只允许纯 re-export
    if (KNOWN_COMPAT_DIRS.some((d) => normalized.includes(d))) {
      if (!isCompatReexport(content)) {
        addV(file, 1, `兼容转发目录包含非 re-export 逻辑: ${relPath}`, 'utilsCompatContent')
      }
      // 兼容目录仍需检查 IO/输出等违规
    }

    // B1: 检查 IO 导入
    for (const ioPat of IO_IMPORT_PATTERNS) {
      const idx = content.search(ioPat)
      if (idx !== -1) {
        const lineNum = content.slice(0, idx).split('\n').length
        addV(file, lineNum, `utils 中禁止 IO 导入 (node:fs/child_process 等)`, 'utilsIO')
      }
    }

    // B1b: 检查 IO 类外部依赖导入
    for (const dep of IO_EXTERNAL_DEPS) {
      const depPat = new RegExp(`from\\s+['"]${dep}(?:\\/|['"])`)
      const idx = content.search(depPat)
      if (idx !== -1) {
        const lineNum = content.slice(0, idx).split('\n').length
        addV(file, lineNum, `utils 中禁止 IO 类外部依赖: ${dep}`, 'utilsIO')
      }
    }

    // B2: 检查禁止的依赖
    for (const { pattern } of FORBIDDEN_DEP_PATTERNS) {
      let match: RegExpExecArray | null
      const re = new RegExp(pattern.source, 'g')
      while ((match = re.exec(content)) !== null) {
        const lineNum = content.slice(0, match.index).split('\n').length
        const lineContent = lines[lineNum - 1]
        if (
          lineContent &&
          (lineContent.trim().startsWith('//') || lineContent.trim().startsWith('*'))
        )
          continue
        addV(file, lineNum, `utils 禁止依赖 services/components 等`, 'utilsDep')
      }
    }

    // B3: 检查 i18n 导入
    let i18nMatch: RegExpExecArray | null
    const i18nRe = new RegExp(I18N_IMPORT_PATTERN.source, 'g')
    while ((i18nMatch = i18nRe.exec(content)) !== null) {
      const lineNum = content.slice(0, i18nMatch.index).split('\n').length
      addV(file, lineNum, 'utils 禁止导入 i18n', 'utilsI18n')
    }

    // B4: 检查终端输出
    for (const outPat of CONSOLE_PATTERNS) {
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
          continue
        if (outPat.test(lines[i])) {
          addV(file, i + 1, 'utils 禁止终端输出', 'utilsOutput')
        }
      }
    }
  }
}

// --------------- C. 层间依赖检查 ---------------

const LAYER_RULES: Array<{ from: string; to: string; label: string }> = [
  { from: 'services', to: 'components', label: 'services->components' },
  { from: 'services', to: 'screens', label: 'services->screens' },
  { from: 'services', to: 'ink', label: 'services->ink' },
  { from: 'types', to: 'services', label: 'types->services' },
  { from: 'types', to: 'components', label: 'types->components' },
  { from: 'types', to: 'state', label: 'types->state' },
  { from: 'types', to: 'tools', label: 'types->tools' },
]

/**
 * 检查文件是否属于源层。
 * 使用 /src/<layer>/ 模式匹配，兼容正反斜杠。
 */
function isInLayer(filePath: string, layer: string): boolean {
  const normalized = toForwardPath(filePath)
  // 匹配 /src/<layer>/ 或 /src/<layer> 结尾
  return normalized.includes(`/src/${layer}/`) || normalized.includes(`/src/${layer}`)
}

function checkLayerDeps() {
  const files = walkDir(SRC)
  for (const file of files) {
    const content = readFileSync(file, 'utf-8')
    const lines = content.split('\n')

    for (const rule of LAYER_RULES) {
      if (!isInLayer(file, rule.from)) continue

      // 匹配 import from 语句，目标目录在路径中
      // 使用更宽松的匹配：from '.../components/...'
      const importPat = new RegExp(`from\\s+['"]([^'"]*\\/${rule.to}\\/[^'"]*)['"]`, 'gi')
      let match: RegExpExecArray | null
      while ((match = importPat.exec(content)) !== null) {
        const lineNum = content.slice(0, match.index).split('\n').length
        const trimmed = lines[lineNum - 1].trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
        // 跳过同层引用
        const importPath = match[1]
        if (importPath.includes(`/${rule.from}/`)) continue
        addV(file, lineNum, `违反层间依赖: ${rule.label} (${importPath})`, 'layerViolation')
      }
    }
  }
}

// --------------- D. 导入后缀检查 ---------------

const VALID_SUFFIX = /\.(js|json|node|wasm)['"]$/
const RELATIVE_IMPORT = /from\s+['"]\.\.?\//
const DYNAMIC_IMPORT = /import\(\s*['"]\.\.?\//
const REQUIRE_IMPORT = /require\(['"]\.\.?\//

function checkImportSuffix() {
  const files = walkDir(SRC)
  for (const file of files) {
    if (file.endsWith('.d.ts')) continue
    const content = readFileSync(file, 'utf-8')
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue

      // 检查静态 import — 包括 import type
      if (RELATIVE_IMPORT.test(line)) {
        const match = line.match(/from\s+['"]([^'"]+)['"]/)
        if (match) {
          const importPath = match[1]
          if (!VALID_SUFFIX.test(match[0])) {
            addV(file, i + 1, `相对导入缺少 .js 后缀: ${importPath}`, 'missingJsSuffix')
          }
        }
      }

      // 检查动态 import()
      if (DYNAMIC_IMPORT.test(line)) {
        const match = line.match(/import\(\s*['"]([^'"]+)['"]\s*\)/)
        if (match) {
          const importPath = match[1]
          if (!VALID_SUFFIX.test(`'${importPath}'`)) {
            addV(file, i + 1, `动态 import 缺少 .js 后缀: ${importPath}`, 'missingJsSuffix')
          }
        }
      }

      // 检查 require()
      if (REQUIRE_IMPORT.test(line)) {
        const match = line.match(/require\(['"]([^'"]+)['"]\)/)
        if (match) {
          const importPath = match[1]
          if (!VALID_SUFFIX.test(`'${importPath}'`)) {
            addV(file, i + 1, `require 缺少 .js 后缀: ${importPath}`, 'missingJsSuffix')
          }
        }
      }
    }
  }
}

// --------------- E. feature() 宏检查 ---------------

function checkFeatureMacro() {
  const files = walkDir(SRC)
  for (const file of files) {
    const content = readFileSync(file, 'utf-8')
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue

      // 禁止: const enabled = feature('X')
      if (/=\s*feature\(['"]/.test(line) && !/\?\s*feature\(['"]/.test(line)) {
        addV(file, i + 1, 'feature() 不能赋值给变量', 'featureMacro')
      }

      // 禁止: feature('X') && run()
      if (/feature\(['"][^)]+['"]\)\s*&&/.test(line)) {
        addV(file, i + 1, 'feature() 不能用于 && 表达式', 'featureMacro')
      }

      // 禁止: if (feature('X') && condition)
      if (/if\s*\(.*feature\(['"][^)]+['"]\)\s*&&/.test(line)) {
        addV(file, i + 1, 'feature() 在 if 中不能与 && 组合', 'featureMacro')
      }
    }
  }
}

// --------------- F. as any 统计 ---------------

interface AsAnyStats {
  total: number
  fileCounts: Array<{ file: string; count: number }>
  adapterTotal: number
  nonAdapterTotal: number
}

function checkAsAny(): AsAnyStats {
  const files = walkDir(SRC)
  let total = 0
  let adapterTotal = 0
  let nonAdapterTotal = 0
  const fileCounts: Array<{ file: string; count: number }> = []

  for (const file of files) {
    const content = readFileSync(file, 'utf-8')
    const count = countOccurrences(content, /\bas\s+any\b/g)

    if (count > 0) {
      const relPath = getRelativePath(file)
      const normalized = toForwardPath(file)
      const isAdapter =
        normalized.includes('/conversions/') ||
        normalized.includes('/bridge/') ||
        normalized.includes('/adapters/')
      fileCounts.push({ file: relPath, count })
      total += count
      if (isAdapter) {
        adapterTotal += count
      } else {
        nonAdapterTotal += count
      }
    }
  }

  return { total, fileCounts, adapterTotal, nonAdapterTotal }
}

// --------------- G. 命名规则检查 (P1-02) ---------------

/** 需要豁免命名检查的目录 */
const NAMING_EXEMPT_DIRS = ['/node_modules/', '/.git/', '/dist/', '/packages/']
/** React 组件目录（允许 PascalCase） */
const REACT_COMPONENT_DIRS = ['/components/', '/screens/', '/design-system/']
/** Tool 目录（匹配 PascalCaseTool 模式，如 BashTool, WebSearchTool） */
const TOOL_DIR_PATTERN = /[A-Z]\w+Tool$/

function checkNamingConventions() {
  // 检查目录命名
  const dirs = collectDirs(SRC)
  for (const dir of dirs) {
    const normalized = toForwardPath(dir)
    if (NAMING_EXEMPT_DIRS.some((d) => normalized.includes(d))) continue

    const dirName = normalized.split('/').pop() || ''

    // 跳过单字母或点开头的目录
    if (dirName.length <= 2 || dirName.startsWith('.')) continue

    // React 组件目录允许 PascalCase
    if (REACT_COMPONENT_DIRS.some((d) => normalized.includes(d))) {
      if (!/^[A-Z]/.test(dirName) && !/^[a-z]/.test(dirName)) continue
      // PascalCase 或 kebab-case 都允许
      if (/^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)*$/.test(dirName)) continue
      if (/^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$/.test(dirName)) continue
      addV(dir, 1, `组件目录命名建议 PascalCase 或 kebab-case: ${dirName}`, 'namingDir')
      continue
    }

    // Tool 目录 - 允许 PascalCaseTool
    if (TOOL_DIR_PATTERN.test(dirName)) continue

    // 普通目录必须是 kebab-case
    if (!/^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$/.test(dirName)) {
      addV(dir, 1, `普通目录应为 kebab-case: ${dirName}`, 'namingDir')
    }
  }

  // 检查文件命名
  const files = walkDir(SRC)
  for (const file of files) {
    const normalized = toForwardPath(file)
    if (NAMING_EXEMPT_DIRS.some((d) => normalized.includes(d))) continue

    const fileName = normalized.split('/').pop() || ''
    const isTest = fileName.endsWith('.test.ts') || fileName.endsWith('.test.tsx')

    // 测试文件: *.test.ts 或 *.test.tsx
    if (isTest) continue

    // React 组件文件 (.tsx)
    if (fileName.endsWith('.tsx') && !fileName.endsWith('.test.tsx')) {
      // Hook: useXxx.tsx
      if (fileName.startsWith('use') && /^use[A-Z]/.test(fileName)) continue
      // PascalCase.tsx
      if (/^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)*\.tsx$/.test(fileName)) continue
      // 允许 kebab-case.tsx（非组件文件）
      if (/^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*\.tsx$/.test(fileName)) continue
      // 允许 index.tsx
      if (fileName === 'index.tsx') continue
      addV(file, 1, `React 组件文件建议 PascalCase: ${fileName}`, 'namingFile')
    }

    // Hook 文件: useXxx.ts
    if (fileName.endsWith('.ts') && fileName.startsWith('use') && /^use[A-Z]/.test(fileName))
      continue

    // 普通模块: camelCase.ts
    if (fileName.endsWith('.ts') && !fileName.endsWith('.d.ts')) {
      if (/^[a-z][a-zA-Z0-9]*\.ts$/.test(fileName)) continue
      if (/^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*\.ts$/.test(fileName)) continue
      if (fileName === 'index.ts') continue
      if (fileName.endsWith('.snapshot.txt')) continue
      // 大写的 .d.ts 文件
      if (fileName.endsWith('.d.ts')) continue
      addV(file, 1, `普通模块建议 camelCase: ${fileName}`, 'namingFile')
    }
  }
}

/** 递归收集所有子目录名 */
function collectDirs(dir: string): string[] {
  const result: string[] = [dir]
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        result.push(...collectDirs(join(dir, entry.name)))
      }
    }
  } catch {
    // skip
  }
  return result
}

// --------------- H. Tool 结构检查 (P3) ---------------

const TOOL_DIR = join(SRC, 'tools')
const NON_TOOL_DIRS = new Set(['shared', 'testing'])

interface ToolProfile {
  name: string
  hasMain: boolean
  hasUI: boolean
  hasPrompt: boolean
  hasConstants: boolean
  inferredProfile: string
  issues: string[]
}

function checkToolProfiles() {
  if (!existsSync(TOOL_DIR)) return

  const dirs = readdirSync(TOOL_DIR, { withFileTypes: true })
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue
    if (NON_TOOL_DIRS.has(entry.name)) continue

    const dirPath = join(TOOL_DIR, entry.name)
    const name = entry.name

    // 检查主文件（ToolName.ts 或 ToolName.tsx）
    const hasMainTS = existsSync(join(dirPath, `${name}.ts`))
    const hasMainTSX = existsSync(join(dirPath, `${name}.tsx`))
    const hasUI = existsSync(join(dirPath, 'UI.tsx'))
    const hasPrompt = existsSync(join(dirPath, 'prompt.ts'))
    const hasConstants = existsSync(join(dirPath, 'constants.ts'))

    const hasMain = hasMainTS || hasMainTSX

    // 推导 profile
    let inferredProfile: string
    const issues: string[] = []

    if (hasMain && hasUI && hasPrompt) {
      inferredProfile = 'interactive'
    } else if (hasMain && hasPrompt) {
      inferredProfile = 'headless'
    } else if (hasMain) {
      inferredProfile = 'internal'
    } else if (hasPrompt && !hasMain) {
      inferredProfile = 'incomplete'
      issues.push('有 prompt.ts 但缺少主文件')
    } else if (hasUI && !hasMain) {
      inferredProfile = 'incomplete'
      issues.push('有 UI.tsx 但缺少主文件')
    } else {
      inferredProfile = 'unknown'
      issues.push('无法识别工具结构')
    }

    // 检查文件名一致性
    if (hasMainTS && !name.endsWith('Tool') && !name.startsWith('use')) {
      issues.push(`目录名 "${name}" 不是 PascalCaseTool 模式`)
    }

    // interactive 必须三文件齐全
    if (inferredProfile === 'interactive') {
      if (!hasUI) issues.push('interactive 工具缺少 UI.tsx')
      if (!hasPrompt) issues.push('interactive 工具缺少 prompt.ts')
    }

    // headless 必须至少主文件 + prompt
    if (inferredProfile === 'headless') {
      if (!hasPrompt) issues.push('headless 工具缺少 prompt.ts')
    }

    if (issues.length > 0) {
      addV(dirPath, 1, `Tool "${name}": ${issues.join('; ')}`, 'toolProfile')
    }
  }
}

// --------------- 基线管理 ---------------

interface BaselineData {
  generatedAt: string
  /** 逐条违规 ID → true */
  violations: Record<string, true>
  total: number
  /** 分类计数（仅用于展示） */
  categoryCounts: Record<string, number>
  asAny: { total: number }
}

function loadBaseline(): BaselineData | null {
  try {
    const raw = readFileSync(BASELINE_PATH, 'utf-8')
    const data = JSON.parse(raw) as BaselineData
    // 验证必需字段
    if (!data.violations || typeof data.asAny?.total !== 'number') {
      return null
    }
    return data
  } catch {
    return null
  }
}

function writeBaseline(entries: BaselineEntry[], asAnyTotal: number) {
  const violationMap: Record<string, true> = {}
  const catCounts: Record<string, number> = {}
  for (const e of entries) {
    violationMap[e.id] = true
    catCounts[e.category] = (catCounts[e.category] || 0) + 1
  }

  const baseline: BaselineData = {
    generatedAt: new Date().toISOString().split('T')[0],
    violations: violationMap,
    total: entries.length,
    categoryCounts: catCounts,
    asAny: { total: asAnyTotal },
  }

  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n')
  console.error(`\n📝 基线已更新到 ${BASELINE_PATH}`)
}

function compareWithBaseline(entries: BaselineEntry[], asAnyStats: AsAnyStats): boolean {
  const baseline = loadBaseline()

  // fail closed: baseline 不存在或损坏时直接失败
  if (!baseline) {
    console.error('❌ 基线文件缺失或损坏，架构检查失败（fail closed）')
    console.error(`   预期位置: ${BASELINE_PATH}`)
    console.error('   运行 --write-baseline 生成基线')
    process.exit(1)
  }

  let allPass = true

  // 检查新增违规：当前条目不在 baseline 中
  const newViolations: BaselineEntry[] = []
  const currentIds = new Set<string>()

  for (const e of entries) {
    currentIds.add(e.id)
    if (!baseline.violations[e.id]) {
      newViolations.push(e)
    }
  }

  // 统计消除的违规数
  const resolvedCount = Object.keys(baseline.violations).filter((id) => !currentIds.has(id)).length

  console.error(`📊 与基线比较（基线日期: ${baseline.generatedAt}）：\n`)

  if (newViolations.length > 0) {
    console.error(`🔴 新增违规 ${newViolations.length} 条（超出基线）:\n`)
    for (const v of newViolations) {
      console.error(`  [${v.category}] ${v.file}:${v.line}`)
      console.error(`          ${v.message}`)
    }
    console.error('')
    allPass = false
  } else {
    console.error('✅ 无新增违规\n')
  }

  if (resolvedCount > 0) {
    console.error(`🟢 已消除 ${resolvedCount} 条违规\n`)
  }

  // 分类汇总
  const catCounts: Record<string, number> = {}
  for (const e of entries) {
    catCounts[e.category] = (catCounts[e.category] || 0) + 1
  }

  console.error('📊 分类汇总：')
  const sortedCats = Object.entries(catCounts).sort((a, b) => b[1] - a[1])
  for (const [cat, count] of sortedCats) {
    const base = baseline.categoryCounts[cat] || 0
    const diff = count - base
    const status = diff > 0 ? '🔴' : diff < 0 ? '🟢' : '⚪'
    console.error(
      `  ${status} ${cat}: ${count}（基线 ${base}${diff !== 0 ? `，${diff > 0 ? '+' : ''}${diff}` : ''}）`,
    )
  }
  console.error('')

  // as any 比较
  const asAnyDiff = asAnyStats.total - (baseline.asAny?.total || 0)
  if (asAnyDiff > 0) {
    console.error(
      `🔴 as any 总量: ${asAnyStats.total}（基线 ${baseline.asAny?.total || 0}，新增 ${asAnyDiff}）`,
    )
    allPass = false
  } else if (asAnyDiff < 0) {
    console.error(
      `🟢 as any 总量: ${asAnyStats.total}（基线 ${baseline.asAny?.total || 0}，减少 ${Math.abs(asAnyDiff)}）`,
    )
  } else {
    console.error(`⚪ as any 总量: ${asAnyStats.total}（与基线持平）`)
  }
  console.error('')

  if (!allPass) {
    console.error(`❌ 架构检查未通过（存在超出基线的违规）`)
    process.exit(1)
  }

  console.error('✅ 架构检查通过（未超出基线）')
  process.exit(0)
}

// --------------- 主函数 ---------------

function main() {
  const args = process.argv.slice(2)
  const verbose = args.includes('--verbose')
  const writeBaselineMode = args.includes('--write-baseline')
  // 默认模式 = baseline 比较
  const baselineMode = !writeBaselineMode

  console.error('🔍 架构边界检查...\n')

  // 执行所有检查
  checkRootFiles()
  checkUtilsBoundary()
  checkLayerDeps()
  checkImportSuffix()
  checkFeatureMacro()
  checkNamingConventions()
  checkToolProfiles()
  const asAnyStats = checkAsAny()

  // 生成违规条目（用于精确基线匹配）
  const entries: BaselineEntry[] = violations.map((v) => {
    // 根据类别生成区分细节
    let detail = v.message
    // 对层间依赖，detail 已包含目标路径
    // 对 utilsDep，detail 已说明
    if (v.category === 'rootFile') {
      const fileName = v.message.match(/[\w-]+\.(ts|tsx)/)?.[0] || ''
      detail = fileName
    }
    const id = makeBaselineId(v.category, v.file, detail)
    return {
      id,
      category: v.category,
      file: getRelativePath(v.file),
      line: v.line,
      message: v.message,
    }
  })

  // 按 ID 去重（同一文件同类别同细节只算一条）
  const uniqueEntries = new Map<string, BaselineEntry>()
  for (const e of entries) {
    const key = e.id
    if (!uniqueEntries.has(key)) {
      uniqueEntries.set(key, e)
    }
  }
  const deduped = [...uniqueEntries.values()]

  // --------------- 输出违规 ---------------

  if (deduped.length > 0 && (verbose || writeBaselineMode)) {
    console.error(`📋 违规清单（共 ${deduped.length} 条）：\n`)
    for (const v of deduped) {
      console.error(`  [${v.category}] ${v.file}:${v.line}`)
      console.error(`          ${v.message}`)
    }
    console.error('')
  } else if (deduped.length > 0) {
    console.error(`📋 发现 ${deduped.length} 条违规（使用 --verbose 查看详情）\n`)
  } else {
    console.error('✅ 未发现架构违规。\n')
  }

  // as any 统计
  console.error(`📊 as any 统计（共 ${asAnyStats.total} 处）：`)
  console.error(`  适配层: ${asAnyStats.adapterTotal}  非适配层: ${asAnyStats.nonAdapterTotal}`)
  if (verbose) {
    const sortedFiles = asAnyStats.fileCounts.sort((a, b) => b.count - a.count)
    for (const { file, count } of sortedFiles.slice(0, 15)) {
      console.error(`  ${file}: ${count}`)
    }
    if (sortedFiles.length > 15) {
      console.error(`  ... 及其他 ${sortedFiles.length - 15} 个文件`)
    }
  }
  console.error('')

  // --------------- 写基线 ---------------

  if (writeBaselineMode) {
    writeBaseline(deduped, asAnyStats.total)
    process.exit(0)
  }

  // --------------- 与基线比较（默认模式） ---------------

  compareWithBaseline(deduped, asAnyStats)
}

main()
