/**
 * 压缩真实阶段进度。
 *
 * 业务层在各阶段 emit `{ type:'compact_progress', stage, pct }`；
 * UI 只负责渲染 ▰▱ 条 + 百分比，不再用墙钟渐近假进度。
 *
 * 阶段与百分比锚点（单调不减）：
 *   pre_hooks     5%   PreCompact hooks
 *   start        10%   准备摘要请求
 *   api          15→68%  摘要 API（fork/stream）；流式时随输出推进
 *   attachments  78%   恢复文件/附件
 *   session_start 88%  SessionStart hooks
 *   post_hooks   94%   PostCompact hooks（≥90% 后 compact_end 直接卸条）
 */

import { tSync } from '../../i18n/index.js'

/** 阶段锚点百分比 */
export const COMPACT_STAGE_PCT = {
  pre_hooks: 5,
  start: 10,
  /** 摘要 API 起始 */
  api_start: 15,
  /** 摘要 API 软上限（完成前不超过此值；完成后跳 attachments） */
  api_soft_cap: 68,
  attachments: 78,
  session_start: 88,
  post_hooks: 94,
  done: 100,
} as const

export type CompactProgressStage =
  | 'pre_hooks'
  | 'start'
  | 'api'
  | 'attachments'
  | 'session_start'
  | 'hooks' // post_compact 等
  | 'summarize' // 兼容旧 stage 名 → 映射到 api
  | 'trim'
  | 'post_hooks'

/** 进度条宽度 */
export const COMPACT_PROGRESS_BAR_WIDTH = 20

/**
 * 流式摘要时，按已输出字符估算 api 阶段内进度。
 * 假定典型摘要约 ~4000 字符填满 api 区间；不足也到 soft_cap。
 */
export const COMPACT_API_STREAM_CHARS_FOR_FULL = 4_000

/**
 * 阶段切换保底帧间隔。
 *
 * 附件/hooks 为空时，68→78→88→94→compact_end 的锚点事件在几毫秒内
 * 连续到达，React 批处理会合并进同一渲染帧——UI 只绘制最终状态，
 * 中间阶段不可见（进度条停在 api_soft_cap 后直接消失）。
 * 业务层在阶段锚点间等待一帧（宏任务边界），让每阶段独立提交渲染。
 */
export const COMPACT_STAGE_FRAME_HOLD_MS = 40

/**
 * 根据流式输出字符数计算 api 阶段 pct（api_start … api_soft_cap）。
 */
export function compactApiStreamPercent(charsStreamed: number): number {
  const { api_start, api_soft_cap } = COMPACT_STAGE_PCT
  const span = api_soft_cap - api_start
  const t = Math.min(1, Math.max(0, charsStreamed / COMPACT_API_STREAM_CHARS_FOR_FULL))
  // 缓入：sqrt 让前半段更明显
  const eased = Math.sqrt(t)
  return Math.min(api_soft_cap, Math.round(api_start + span * eased))
}

/**
 * 单调合并：新 pct 不得低于 previous。
 */
export function advanceStagePercent(previous: number, next: number): number {
  return Math.max(previous, Math.min(100, Math.round(next)))
}

/**
 * 渲染单行 ▰▱ 进度条 + 百分比。
 * 必须单行 — spinnerMessage 中的 \\n 会在 Ink 刷新时错位。
 */
export function formatCompactPercentHint(
  pct: number,
  barWidth = COMPACT_PROGRESS_BAR_WIDTH,
): string {
  const clamped = Math.min(100, Math.max(0, Math.round(pct)))
  const filled = Math.round((clamped / 100) * barWidth)
  const bar = '▰'.repeat(filled) + '▱'.repeat(barWidth - filled)
  return `${bar} ${clamped}%`
}

/**
 * 阶段 → 可选 i18n 后缀（单行）。
 */
export function compactStageLabel(stage?: string): string | null {
  switch (stage) {
    case 'pre_hooks':
      return tSync('spinner.compactStage.preHooks')
    case 'api':
    case 'summarize':
      return tSync('spinner.compactStage.api')
    case 'attachments':
      return tSync('spinner.compactStage.attachments')
    case 'session_start':
      return tSync('spinner.compactStage.sessionStart')
    case 'hooks':
    case 'post_hooks':
      return tSync('spinner.compactStage.postHooks')
    case 'start':
    case 'trim':
    case 'done':
    default:
      return null
  }
}

/**
 * 生成压缩进度 spinner 完整单行文案。
 */
export function buildCompactProgressMessage(event: {
  stage?: string
  pct?: number
  hintText?: string
}): string {
  if (event.hintText) {
    return `${tSync('spinner.compacting')} ${event.hintText}`
  }
  const pct = event.pct ?? 0
  const bar = formatCompactPercentHint(pct)
  const label = compactStageLabel(event.stage)
  if (label) {
    return `${tSync('spinner.compacting')} ${bar} · ${label}`
  }
  return `${tSync('spinner.compacting')} ${bar}`
}

/**
 * 向 context 推送阶段进度（若存在回调）。
 */
export function emitCompactStage(
  onCompactProgress:
    | ((event: {
        type: 'compact_progress'
        stage: 'summarize' | 'trim' | 'api' | 'attachments' | 'session_start' | 'hooks'
        pct: number
      }) => void)
    | undefined,
  stage: 'summarize' | 'trim' | 'api' | 'attachments' | 'session_start' | 'hooks',
  pct: number,
): void {
  onCompactProgress?.({
    type: 'compact_progress',
    stage,
    pct: Math.min(100, Math.max(0, Math.round(pct))),
  })
}

// ── 兼容旧导出名（测试 / 调用方）────────────────────────────────

/** @deprecated 阶段进度不再用墙钟渐近；保留常量避免外部引用炸裂 */
export const COMPACT_PROGRESS_TIME_CONSTANT_SEC = 90
/** @deprecated 见 COMPACT_STAGE_PCT.api_soft_cap */
export const COMPACT_PROGRESS_CAP_PERCENT = COMPACT_STAGE_PCT.api_soft_cap

/** @deprecated 使用 compactApiStreamPercent / 阶段锚点 */
export function compactAsymptoticPercent(elapsedMs: number): number {
  const t = Math.max(0, elapsedMs) / 1000
  const r = 1 - Math.exp(-t / COMPACT_PROGRESS_TIME_CONSTANT_SEC)
  return Math.min(95, Math.round(r * 100))
}

/** @deprecated */
export function advanceCompactPercent(previous: number, elapsedMs: number): number {
  return Math.max(previous, compactAsymptoticPercent(elapsedMs))
}
