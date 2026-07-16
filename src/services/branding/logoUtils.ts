import { getAPIProvider } from 'src/services/model/providers.js'
import { getDirectConnectServerUrl, getSessionId } from 'src/bootstrap/runtime/runtimeContext.js'
import { tSync } from '../../i18n/index.js'
import { stringWidth } from '../../ink/stringWidth.js'
import type { LogOption } from '../../types/logs.js'
import { getCwd } from '../../utils/cwd.js'
import { isInternalBuild } from '../../utils/envUtils.js'
import { getDisplayPath } from '../../utils/file.js'
import { truncate, truncateToWidth, truncateToWidthNoEllipsis } from '../../utils/format.js'
import { getStoredChangelogFromMemory, parseChangelog } from '../../utils/releaseNotes.js'
import { gt } from '../../utils/semver.js'
import { loadMessageLogs } from '../sessionStorage.js'
import { getInitialSettings } from '../settings/settings.js'

// 布局常量
const MAX_LEFT_WIDTH = 50
const MAX_USERNAME_LENGTH = 20
const BORDER_PADDING = 4
const DIVIDER_WIDTH = 1
const CONTENT_PADDING = 2

export type LayoutMode = 'horizontal' | 'compact'

export type LayoutDimensions = {
  leftWidth: number
  rightWidth: number
  totalWidth: number
}

/**
 * 根据终端宽度确定布局模式
 */
export function getLayoutMode(columns: number): LayoutMode {
  if (columns >= 70) {
    return 'horizontal'
  }
  return 'compact'
}

/**
 * 计算 Logo 组件的布局尺寸
 */
export function calculateLayoutDimensions(
  columns: number,
  layoutMode: LayoutMode,
  optimalLeftWidth: number,
): LayoutDimensions {
  if (layoutMode === 'horizontal') {
    const leftWidth = optimalLeftWidth
    const usedSpace = BORDER_PADDING + CONTENT_PADDING + DIVIDER_WIDTH + leftWidth
    const availableForRight = columns - usedSpace

    let rightWidth = Math.max(30, availableForRight)
    const totalWidth = Math.min(
      leftWidth + rightWidth + DIVIDER_WIDTH + CONTENT_PADDING,
      columns - BORDER_PADDING,
    )

    // 如果总宽度被限制，重新计算右侧宽度
    if (totalWidth < leftWidth + rightWidth + DIVIDER_WIDTH + CONTENT_PADDING) {
      rightWidth = totalWidth - leftWidth - DIVIDER_WIDTH - CONTENT_PADDING
    }

    return { leftWidth, rightWidth, totalWidth }
  }

  // 垂直布局
  const totalWidth = Math.min(columns - BORDER_PADDING, MAX_LEFT_WIDTH + 20)
  return {
    leftWidth: totalWidth,
    rightWidth: totalWidth,
    totalWidth,
  }
}

/**
 * 根据内容计算左侧面板的最优宽度
 */
export function calculateOptimalLeftWidth(
  welcomeMessage: string,
  truncatedCwd: string,
  modelLine: string,
): number {
  const contentWidth = Math.max(
    stringWidth(welcomeMessage),
    stringWidth(truncatedCwd),
    stringWidth(modelLine),
    20, // 给 clawd 图案留出的最小宽度
  )
  return Math.min(contentWidth + 4, MAX_LEFT_WIDTH) // +4 for padding
}

/**
 * 根据用户名格式化欢迎语
 */
export function formatWelcomeMessage(username: string | null): string {
  if (!username || username.length > MAX_USERNAME_LENGTH) {
    return tSync('logo.welcomeBack')
  }
  return tSync('logo.welcomeBackUser', { username })
}

/**
 * 路径过长时从中间截断。
 * 按宽度感知：使用 stringWidth() 正确测量 CJK/emoji 宽度。
 */
export function truncatePath(path: string, maxLength: number): string {
  if (stringWidth(path) <= maxLength) {
    return path
  }

  const separator = '/'
  const ellipsis = '…'
  const ellipsisWidth = 1 // 省略号固定占 1 列
  const separatorWidth = 1

  const parts = path.split(separator)
  const first = parts[0] || ''
  const last = parts[parts.length - 1] || ''
  const firstWidth = stringWidth(first)
  const lastWidth = stringWidth(last)

  // 只有一段，尽量完整展示
  if (parts.length === 1) {
    return truncateToWidth(path, maxLength)
  }

  // 空间不足以展示最后一段，因此截断它
  // 首段为空（Unix 路径），不需要额外的省略号
  if (first === '' && ellipsisWidth + separatorWidth + lastWidth >= maxLength) {
    return `${separator}${truncateToWidth(last, Math.max(1, maxLength - separatorWidth))}`
  }

  // 存在首段，展示省略号并截断末段
  if (first !== '' && ellipsisWidth * 2 + separatorWidth + lastWidth >= maxLength) {
    return `${ellipsis}${separator}${truncateToWidth(last, Math.max(1, maxLength - ellipsisWidth - separatorWidth))}`
  }

  // 截断首段，保留末段
  if (parts.length === 2) {
    const availableForFirst = maxLength - ellipsisWidth - separatorWidth - lastWidth
    return `${truncateToWidthNoEllipsis(first, availableForFirst)}${ellipsis}${separator}${last}`
  }

  // 开始移除中间段

  let available = maxLength - firstWidth - lastWidth - ellipsisWidth - 2 * separatorWidth

  // 首尾段都太长，截断首段
  if (available <= 0) {
    const availableForFirst = Math.max(
      0,
      maxLength - lastWidth - ellipsisWidth - 2 * separatorWidth,
    )
    const truncatedFirst = truncateToWidthNoEllipsis(first, availableForFirst)
    return `${truncatedFirst}${separator}${ellipsis}${separator}${last}`
  }

  // 尽量保留更多中间段
  const middleParts = []
  for (let i = parts.length - 2; i > 0; i--) {
    const part = parts[i]
    if (part && stringWidth(part) + separatorWidth <= available) {
      middleParts.unshift(part)
      available -= stringWidth(part) + separatorWidth
    } else {
      break
    }
  }

  if (middleParts.length === 0) {
    return `${first}${separator}${ellipsis}${separator}${last}`
  }

  return `${first}${separator}${ellipsis}${separator}${middleParts.join(separator)}${separator}${last}`
}

// 预加载会话记录的简单缓存
let cachedActivity: LogOption[] = []
let cachePromise: Promise<LogOption[]> | null = null

/**
 * 预加载最近会话记录，供 Logo v2 展示
 */
export async function getRecentActivity(): Promise<LogOption[]> {
  // 如果已经在加载，直接返回已有的 Promise
  if (cachePromise) {
    return cachePromise
  }

  const currentSessionId = getSessionId()
  cachePromise = loadMessageLogs(10)
    .then((logs) => {
      cachedActivity = logs
        .filter((log) => {
          if (log.isSidechain) {
            return false
          }
          if (log.sessionId === currentSessionId) {
            return false
          }
          if (log.summary?.includes('I apologize')) {
            return false
          }

          // Filter out sessions where both summary and firstPrompt are "No prompt" or missing
          const hasSummary = log.summary && log.summary !== 'No prompt'
          const hasFirstPrompt = log.firstPrompt && log.firstPrompt !== 'No prompt'
          return hasSummary || hasFirstPrompt
        })
        .slice(0, 3)
      return cachedActivity
    })
    .catch(() => {
      cachedActivity = []
      return cachedActivity
    })

  return cachePromise
}

/**
 * 同步获取缓存的会话记录
 */
export function getRecentActivitySync(): LogOption[] {
  return cachedActivity
}

/**
 * 获取当前 provider 的展示名称
 */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  ark: '火山方舟',
  azure: '微软Azure',
  bedrock: '亚马逊Bedrock',
  dashscope: '阿里云百炼',
  deepseek: '深度求索',
  fireworks: 'Fireworks',
  generic: '自定义',
  groq: 'Groq',
  kimi: '月之暗面',
  lmstudio: 'LM Studio',
  llamacpp: 'llama.cpp',
  mimo: '小米',
  minimax: '稀宇科技',
  nim: '英伟达NIM',
  ollama: 'Ollama',
  openai: 'OpenAI',
  'opencode-go': 'OpenCode Go',
  openrouter: 'OpenRouter',
  pangu: '华为盘古',
  perplexity: 'Perplexity',
  qianfan: '百度千帆',
  siliconflow: '硅基流动',
  tencent: '腾讯混元',
  together: 'Together',
  vertex: '谷歌Vertex',
  zhipu: '智谱',
}

function getProviderDisplayName(): string {
  const provider = getAPIProvider()
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider
}

/**
 * 获取 Logo 与 CondensedLogo 共用的展示数据
 */
export function getLogoDisplayData(): {
  version: string
  cwd: string
  providerName: string
  agentName: string | undefined
} {
  const version = process.env.DEMO_VERSION ?? MACRO.VERSION
  const serverUrl = getDirectConnectServerUrl()
  const displayPath = process.env.DEMO_VERSION ? '/code/zy' : getDisplayPath(getCwd())
  const cwd = serverUrl ? `${displayPath} in ${serverUrl.replace(/^https?:\/\//, '')}` : displayPath
  const providerName = getProviderDisplayName()
  const agentName = getInitialSettings().agent

  return {
    version,
    cwd,
    providerName,
    agentName,
  }
}

/**
 * 根据可用宽度决定模型与 provider 的展示方式
 */
export function formatModelAndProvider(
  modelName: string,
  providerName: string,
  availableWidth: number,
): {
  shouldSplit: boolean
  truncatedModel: string
  truncatedProvider: string
} {
  const separator = ' · '
  const combinedWidth = stringWidth(modelName) + separator.length + stringWidth(providerName)
  const shouldSplit = combinedWidth > availableWidth

  if (shouldSplit) {
    return {
      shouldSplit: true,
      truncatedModel: truncate(modelName, availableWidth),
      truncatedProvider: truncate(providerName, availableWidth),
    }
  }

  return {
    shouldSplit: false,
    truncatedModel: truncate(
      modelName,
      Math.max(availableWidth - stringWidth(providerName) - separator.length, 10),
    ),
    truncatedProvider: providerName,
  }
}

/**
 * 获取 Logo v2 展示的最近发布说明。
 * 内部构建使用构建时打包的提交记录。
 * 外部用户使用公开更新日志。
 */
export function getRecentReleaseNotesSync(maxItems: number): string[] {
  // 内部构建使用打包的更新日志
  if (isInternalBuild()) {
    const changelog = MACRO.VERSION_CHANGELOG
    if (changelog) {
      const commits = changelog.trim().split('\n').filter(Boolean)
      return commits.slice(0, maxItems)
    }
    return []
  }

  const changelog = getStoredChangelogFromMemory()
  if (!changelog) {
    return []
  }

  let parsed
  try {
    parsed = parseChangelog(changelog)
  } catch {
    return []
  }

  // 从最近的版本获取更新说明
  const allNotes: string[] = []
  const versions = Object.keys(parsed)
    .sort((a, b) => (gt(a, b) ? -1 : 1))
    .slice(0, 3) // 只看最近的 3 个版本

  for (const version of versions) {
    const notes = parsed[version]
    if (notes) {
      allNotes.push(...notes)
    }
  }

  // 返回原始说明，不做过滤或过早截断
  return allNotes.slice(0, maxItems)
}
