/**
 * 支持热重载的用户快捷键配置加载器。
 *
 * 从 ~/.zy/keybindings.json 加载快捷键，并监听变化以自动重载。
 *
 * 注意：用户快捷键自定义目前仅向内部用户开放。外部用户始终使用默认绑定。
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { logEvent } from '../services/analytics/index.js'
import { registerCleanup } from '../services/cleanup/cleanupRegistry.js'
import { logForDebugging } from '../services/infra/debug.js'
import { getZyConfigHomeDir } from '../services/infra/envUtils.js'
import { errorMessage, isENOENT } from '../utils/errors.js'
import { createSignal } from '../utils/signal.js'
import { jsonParse } from '../services/infra/slowOperations.js'
import { DEFAULT_BINDINGS } from './defaultBindings.js'
import { parseBindings } from './parser.js'
import type { KeybindingBlock, ParsedBinding } from './types.js'
import { checkDuplicateKeysInJson, type KeybindingWarning, validateBindings } from './validate.js'

/**
 * 检查是否启用快捷键自定义。
 *
 * zy_keybinding_customization_release GrowthBook 开关启用时返回 true。
 *
 * 导出此函数，以便 /doctor 等其他模块统一检查同一条件。
 */
export function isKeybindingCustomizationEnabled(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE('zy_keybinding_customization_release', false)
}

/**
 * 等待文件写入稳定的时间（ms）。
 */
const FILE_STABILITY_THRESHOLD_MS = 500

/**
 * 检查文件稳定性的轮询间隔。
 */
const FILE_STABILITY_POLL_INTERVAL_MS = 200

/**
 * 快捷键加载结果，包含所有校验警告。
 */
export type KeybindingsLoadResult = {
  bindings: ParsedBinding[]
  warnings: KeybindingWarning[]
}

/** 将同步读取异常转换为启动阶段可展示的警告；文件尚不存在不视为错误。 */
export function getSyncLoadErrorWarnings(error: unknown): KeybindingWarning[] {
  if (isENOENT(error)) {
    return []
  }
  return [
    {
      type: 'parse_error',
      severity: 'error',
      message: `Failed to parse keybindings.json: ${errorMessage(error)}`,
    },
  ]
}

let watcher: FSWatcher | null = null
let initialized = false
let disposed = false
let cachedBindings: ParsedBinding[] | null = null
let cachedWarnings: KeybindingWarning[] = []
const keybindingsChanged = createSignal<[result: KeybindingsLoadResult]>()

/**
 * 记录上次上报自定义快捷键加载事件的日期（YYYY-MM-DD），确保每天最多上报一次。
 */
let lastCustomBindingsLogDate: string | null = null

/**
 * 加载自定义快捷键时上报 telemetry 事件，每天最多一次。
 * 用于估算自定义快捷键的用户占比。
 */
function logCustomBindingsLoadedOncePerDay(userBindingCount: number): void {
  const today = new Date().toISOString().slice(0, 10)
  if (lastCustomBindingsLogDate === today) {
    return
  }
  lastCustomBindingsLogDate = today
  logEvent('zy_custom_keybindings_loaded', {
    user_binding_count: userBindingCount,
  })
}

/**
 * 检查对象是否为有效 KeybindingBlock 的类型守卫。
 */
function isKeybindingBlock(obj: unknown): obj is KeybindingBlock {
  if (typeof obj !== 'object' || obj === null) {
    return false
  }
  const b = obj as Record<string, unknown>
  return typeof b.context === 'string' && typeof b.bindings === 'object' && b.bindings !== null
}

/**
 * 检查数组是否只包含有效 KeybindingBlock 的类型守卫。
 */
function isKeybindingBlockArray(arr: unknown): arr is KeybindingBlock[] {
  return Array.isArray(arr) && arr.every(isKeybindingBlock)
}

/**
 * 获取用户快捷键文件路径。
 */
export function getKeybindingsPath(): string {
  return join(getZyConfigHomeDir(), 'keybindings.json')
}

/**
 * 解析默认绑定；结果会缓存以提升性能。
 */
function getDefaultParsedBindings(): ParsedBinding[] {
  return parseBindings(DEFAULT_BINDINGS)
}

/**
 * 从用户配置文件加载并解析快捷键。
 * 返回默认绑定与用户绑定的合并结果以及校验警告。
 *
 * 对外部用户始终只返回默认绑定；用户自定义目前受内部用户功能开关控制。
 */
export async function loadKeybindings(): Promise<KeybindingsLoadResult> {
  const defaultBindings = getDefaultParsedBindings()

  // 外部用户跳过用户配置加载
  if (!isKeybindingCustomizationEnabled()) {
    return { bindings: defaultBindings, warnings: [] }
  }

  const userPath = getKeybindingsPath()

  try {
    const content = await readFile(userPath, 'utf-8')
    const parsed: unknown = jsonParse(content)

    // 从对象包装格式 { "bindings": [...] } 中提取 bindings 数组
    let userBlocks: unknown
    if (typeof parsed === 'object' && parsed !== null && 'bindings' in parsed) {
      userBlocks = (parsed as { bindings: unknown }).bindings
    } else {
      // 格式无效：缺少 bindings 属性
      const errorMessage = 'keybindings.json must have a "bindings" array'
      const suggestion = 'Use format: { "bindings": [ ... ] }'
      logForDebugging(`[keybindings] Invalid keybindings.json: ${errorMessage}`)
      return {
        bindings: defaultBindings,
        warnings: [
          {
            type: 'parse_error',
            severity: 'error',
            message: errorMessage,
            suggestion,
          },
        ],
      }
    }

    // 校验结构：bindings 必须是有效快捷键绑定块组成的数组
    if (!isKeybindingBlockArray(userBlocks)) {
      const errorMessage = !Array.isArray(userBlocks)
        ? '"bindings" must be an array'
        : 'keybindings.json contains invalid block structure'
      const suggestion = !Array.isArray(userBlocks)
        ? 'Set "bindings" to an array of keybinding blocks'
        : 'Each block must have "context" (string) and "bindings" (object)'
      logForDebugging(`[keybindings] Invalid keybindings.json: ${errorMessage}`)
      return {
        bindings: defaultBindings,
        warnings: [
          {
            type: 'parse_error',
            severity: 'error',
            message: errorMessage,
            suggestion,
          },
        ],
      }
    }

    const userParsed = parseBindings(userBlocks)
    logForDebugging(`[keybindings] Loaded ${userParsed.length} user bindings from ${userPath}`)

    // 用户绑定位于默认绑定之后，因此会覆盖默认值
    const mergedBindings = [...defaultBindings, ...userParsed]

    logCustomBindingsLoadedOncePerDay(userParsed.length)

    // 校验用户配置；先检查原始 JSON 中的重复键，因为 JSON.parse 会静默丢弃靠前的值
    const duplicateKeyWarnings = checkDuplicateKeysInJson(content)
    const warnings = [...duplicateKeyWarnings, ...validateBindings(userBlocks, mergedBindings)]

    if (warnings.length > 0) {
      logForDebugging(`[keybindings] Found ${warnings.length} validation issue(s)`)
    }

    return { bindings: mergedBindings, warnings }
  } catch (error) {
    // 文件不存在时使用默认值；用户可运行 /keybindings 创建文件
    if (isENOENT(error)) {
      return { bindings: defaultBindings, warnings: [] }
    }

    // 其他错误：记录日志，并返回默认值及警告
    logForDebugging(`[keybindings] Error loading ${userPath}: ${errorMessage(error)}`)
    return {
      bindings: defaultBindings,
      warnings: [
        {
          type: 'parse_error',
          severity: 'error',
          message: `Failed to parse keybindings.json: ${errorMessage(error)}`,
        },
      ],
    }
  }
}

/**
 * 同步加载快捷键，供首次渲染使用。
 * 有缓存时直接复用。
 */
export function loadKeybindingsSync(): ParsedBinding[] {
  if (cachedBindings) {
    return cachedBindings
  }

  const result = loadKeybindingsSyncWithWarnings()
  return result.bindings
}

/**
 * 同步加载快捷键及校验警告。
 * 有缓存时直接复用。
 *
 * 对外部用户始终只返回默认绑定；用户自定义目前受内部用户功能开关控制。
 */
export function loadKeybindingsSyncWithWarnings(): KeybindingsLoadResult {
  if (cachedBindings) {
    return { bindings: cachedBindings, warnings: cachedWarnings }
  }

  const defaultBindings = getDefaultParsedBindings()

  // 外部用户跳过用户配置加载
  if (!isKeybindingCustomizationEnabled()) {
    cachedBindings = defaultBindings
    cachedWarnings = []
    return { bindings: cachedBindings, warnings: cachedWarnings }
  }

  const userPath = getKeybindingsPath()

  try {
    // 同步 IO：由 React useState 初始化器等同步上下文调用
    const content = readFileSync(userPath, 'utf-8')
    const parsed: unknown = jsonParse(content)

    // 从对象包装格式 { "bindings": [...] } 中提取 bindings 数组
    let userBlocks: unknown
    if (typeof parsed === 'object' && parsed !== null && 'bindings' in parsed) {
      userBlocks = (parsed as { bindings: unknown }).bindings
    } else {
      // 格式无效：缺少 bindings 属性
      cachedBindings = defaultBindings
      cachedWarnings = [
        {
          type: 'parse_error',
          severity: 'error',
          message: 'keybindings.json must have a "bindings" array',
          suggestion: 'Use format: { "bindings": [ ... ] }',
        },
      ]
      return { bindings: cachedBindings, warnings: cachedWarnings }
    }

    // 校验结构：bindings 必须是有效快捷键绑定块组成的数组
    if (!isKeybindingBlockArray(userBlocks)) {
      const errorMessage = !Array.isArray(userBlocks)
        ? '"bindings" must be an array'
        : 'keybindings.json contains invalid block structure'
      const suggestion = !Array.isArray(userBlocks)
        ? 'Set "bindings" to an array of keybinding blocks'
        : 'Each block must have "context" (string) and "bindings" (object)'
      cachedBindings = defaultBindings
      cachedWarnings = [
        {
          type: 'parse_error',
          severity: 'error',
          message: errorMessage,
          suggestion,
        },
      ]
      return { bindings: cachedBindings, warnings: cachedWarnings }
    }

    const userParsed = parseBindings(userBlocks)
    logForDebugging(`[keybindings] Loaded ${userParsed.length} user bindings from ${userPath}`)
    cachedBindings = [...defaultBindings, ...userParsed]

    logCustomBindingsLoadedOncePerDay(userParsed.length)

    // 执行校验；先检查原始 JSON 中的重复键
    const duplicateKeyWarnings = checkDuplicateKeysInJson(content)
    cachedWarnings = [...duplicateKeyWarnings, ...validateBindings(userBlocks, cachedBindings)]
    if (cachedWarnings.length > 0) {
      logForDebugging(`[keybindings] Found ${cachedWarnings.length} validation issue(s)`)
    }

    return { bindings: cachedBindings, warnings: cachedWarnings }
  } catch (error) {
    cachedBindings = defaultBindings
    cachedWarnings = getSyncLoadErrorWarnings(error)
    return { bindings: cachedBindings, warnings: cachedWarnings }
  }
}

/**
 * 初始化 keybindings.json 文件监听。
 * 应用启动时调用一次。
 *
 * 外部用户未启用自定义，因此此操作不会产生效果。
 */
export async function initializeKeybindingWatcher(): Promise<void> {
  if (initialized || disposed) {
    return
  }

  // 外部用户跳过文件监听
  if (!isKeybindingCustomizationEnabled()) {
    logForDebugging('[keybindings] Skipping file watcher - user customization disabled')
    return
  }

  const userPath = getKeybindingsPath()
  initialized = true

  logForDebugging(`[keybindings] Watching for changes to ${userPath}`)

  watcher = chokidar.watch(userPath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: FILE_STABILITY_THRESHOLD_MS,
      pollInterval: FILE_STABILITY_POLL_INTERVAL_MS,
    },
    ignorePermissionErrors: true,
    usePolling: false,
    atomic: true,
  })

  watcher.on('add', handleChange)
  watcher.on('change', handleChange)
  watcher.on('unlink', handleDelete)

  // 注册清理回调
  registerCleanup(async () => disposeKeybindingWatcher())
}

/**
 * 清理文件 watcher。
 */
export function disposeKeybindingWatcher(): void {
  disposed = true
  if (watcher) {
    void watcher.close()
    watcher = null
  }
  keybindingsChanged.clear()
}

/**
 * 订阅快捷键变化。
 * 文件变化时，listener 会收到新解析的绑定。
 */
export const subscribeToKeybindingChanges = keybindingsChanged.subscribe

async function handleChange(path: string): Promise<void> {
  logForDebugging(`[keybindings] Detected change to ${path}`)

  try {
    const result = await loadKeybindings()
    cachedBindings = result.bindings
    cachedWarnings = result.warnings

    // 将完整结果通知所有 listener
    keybindingsChanged.emit(result)
  } catch (error) {
    logForDebugging(`[keybindings] Error reloading: ${errorMessage(error)}`)
  }
}

function handleDelete(path: string): void {
  logForDebugging(`[keybindings] Detected deletion of ${path}`)

  // 文件删除时恢复默认值
  const defaultBindings = getDefaultParsedBindings()
  cachedBindings = defaultBindings
  cachedWarnings = []

  keybindingsChanged.emit({ bindings: defaultBindings, warnings: [] })
}

/**
 * 获取缓存的快捷键警告。
 * 没有警告或尚未加载绑定时返回空数组。
 */
export function getCachedKeybindingWarnings(): KeybindingWarning[] {
  return cachedWarnings
}

/**
 * 重置内部状态，供测试使用。
 */
export function resetKeybindingLoaderForTesting(): void {
  initialized = false
  disposed = false
  cachedBindings = null
  cachedWarnings = []
  lastCustomBindingsLogDate = null
  if (watcher) {
    void watcher.close()
    watcher = null
  }
  keybindingsChanged.clear()
}
