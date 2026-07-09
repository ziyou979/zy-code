/**
 * Effort 选择器数据结构计算。
 * 根据当前模型支持的 effort 档位，计算可视化选择器的布局参数。
 */
import { tSync } from '../../i18n/index.js'
import {
  type EffortLevel,
  EFFORT_LEVEL_ORDER,
  EFFORT_LEVEL_RANK,
  getModelEffortLevels,
  modelSupportsEffort,
  resolveEffortForModel,
} from '../../utils/effort.js'
import { modelSupportsThinking } from '../../utils/thinking.js'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 轨道最小宽度 */
const MIN_TRACK_WIDTH = 40
/** 完整轨道宽度 */
const FULL_TRACK_WIDTH = 52

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface PickerLevel {
  value: EffortLevel
  /** 翻译后的显示文本 */
  label: string
  /** 选中时的颜色 key（主题色） */
  color: string
}

export interface PickerSublabel {
  text: string
}

export interface PickerLayout {
  /** 选择器中显示的档位列表 */
  levels: PickerLevel[]
  /** 选择器总宽度（字符数），所有行以此宽度对齐 */
  totalWidth: number
  /** 各档位 ▲ 指示器所在的列索引（0-based） */
  trianglePositions: number[]
  /** 各档位标签的起始列索引（0-based） */
  labelStarts: number[]
  /** 选中的轨道字符宽度 */
  trackWidth: number
  /** 是否包含 orchestrate */
  hasOrchestrate: boolean
  /** 副标签（orchestrate 时显示） */
  sublabel?: PickerSublabel
  /** 高亮起始列（orchestrate 分隔线处） */
  accentStart?: number
}

// ---------------------------------------------------------------------------
// 档位 → 颜色映射
// ---------------------------------------------------------------------------

function getPickerColor(level: EffortLevel): string {
  switch (level) {
    case 'off':
    case 'on':
      return 'inactive'
    case 'quick':
    case 'light':
      return 'warning'
    case 'balanced':
      return 'success'
    case 'thorough':
      return 'permission'
    case 'extreme':
    case 'ultra':
    case 'orchestrate':
      return 'autoAccept'
    default:
      return 'text'
  }
}

// ---------------------------------------------------------------------------
// 核心计算函数
// ---------------------------------------------------------------------------

/**
 * 从模型支持的档位中挑选最多 6 个代表性档位供选择器展示。
 * 选择策略：保留 off（如果有）和最高档，中间均匀采样。
 */
function selectPickerLevels(supportedLevels: readonly EffortLevel[]): EffortLevel[] {
  if (supportedLevels.length === 0) return []

  // 按 EFFORT_LEVEL_RANK 排序，过滤掉 orchestrate
  const sorted = [...supportedLevels]
    .filter((l): l is EffortLevel => l !== 'orchestrate')
    .sort((a, b) => (EFFORT_LEVEL_RANK.get(a) ?? 0) - (EFFORT_LEVEL_RANK.get(b) ?? 0))

  if (sorted.length <= 6) return sorted

  // 超过 6 个时，保留首尾 + 均匀采样中间
  const result: EffortLevel[] = [sorted[0]!]
  const step = (sorted.length - 1) / 5
  for (let i = 1; i < 5; i++) {
    const idx = Math.round(i * step)
    if (idx > 0 && idx < sorted.length - 1) {
      result.push(sorted[idx]!)
    }
  }
  result.push(sorted[sorted.length - 1]!)
  return result
}

/**
 * 计算每个档位标签应居中的列位置。
 * 总宽度 trackWidth，共 n 个标签，均分区间，每个标签中心落在等分点上。
 */
function computeLabelPositions(
  levels: PickerLevel[],
  trackWidth: number,
): { labelStarts: number[]; trianglePositions: number[] } {
  const n = levels.length
  if (n === 0) return { labelStarts: [], trianglePositions: [] }

  // 有效轨道宽度（去掉左右各 1 边距）
  const usable = trackWidth - 2
  // 每个档位占据的区间宽度
  const segmentWidth = usable / (n - 1)

  const labelStarts: number[] = []
  const trianglePositions: number[] = []

  for (let i = 0; i < n; i++) {
    // ▲ 正好落在等分点上
    const center = 1 + Math.round(i * segmentWidth)
    trianglePositions.push(center)

    // 标签以中心为基准左对齐（短标签视觉居中）
    const labelLen = levels[i]!.label.length
    const start = Math.max(1, Math.min(center - Math.floor(labelLen / 2), trackWidth - labelLen))
    labelStarts.push(start)
  }

  return { labelStarts, trianglePositions }
}

/**
 * 主函数：计算 effort 选择器的完整布局。
 *
 * @param model - 当前模型 ID
 * @returns PickerLayout | null（模型不支持时返回 null）
 */
export function computePickerLayout(
  model: string,
): PickerLayout | null {
  if (!modelSupportsEffort(model)) return null

  const supportedLevels = getModelEffortLevels(model)
  if (supportedLevels.length === 0) return null

  // 1. 选择展示档位
  const displayLevels = selectPickerLevels(supportedLevels)

  // orchestrate = 最高档位 + 动态工作流编排
  // 顶部已保证 modelSupportsEffort，这里只需要判断思考能力即可
  const hasOrchestrate = modelSupportsThinking(model)

  // 2. 构建 PickerLevel
  const levels: PickerLevel[] = displayLevels.map((lv) => {
    const label = (tSync(`effort.${lv}` as any) as string) || lv
    return { value: lv, label, color: getPickerColor(lv) }
  })

  // 3. 追加 orchestrate（如果支持）
  if (hasOrchestrate && !levels.some((l) => l.value === 'orchestrate')) {
    const label = (tSync('effort.orchestrate' as any) as string) || 'Orchestrate'
    levels.push({ value: 'orchestrate', label, color: getPickerColor('orchestrate') })
  }

  // 4. 确定轨道宽度
  const trackWidth = levels.length <= 4 ? MIN_TRACK_WIDTH : FULL_TRACK_WIDTH

  // 5. 计算标签位置
  const { labelStarts, trianglePositions } = computeLabelPositions(levels, trackWidth)

  // 6. 总宽度（确保所有行都能对齐）
  const totalWidth = trackWidth

  // 7. orchestrate 副标签
  const sublabel = hasOrchestrate
    ? { text: (tSync('effort.picker.orchestrateSublabel' as any) as string) || 'extreme + workflows' }
    : undefined

  // 8. 高亮起始列（orchestrate 分隔线）
  const accentStart = hasOrchestrate ? (trianglePositions[levels.length - 2] ?? trackWidth - 5) : undefined

  return {
    levels,
    totalWidth,
    trianglePositions,
    labelStarts,
    trackWidth,
    hasOrchestrate,
    sublabel,
    accentStart,
  }
}

/**
 * 获取初始选中索引。
 */
export function getInitialSelectedIndex(
  model: string,
  currentEffort: EffortLevel | undefined,
  levels: PickerLevel[],
): number {
  const resolved = resolveEffortForModel(model, currentEffort)
  if (!resolved) return 0
  const idx = levels.findIndex((l) => l.value === resolved)
  return idx >= 0 ? idx : 0
}
