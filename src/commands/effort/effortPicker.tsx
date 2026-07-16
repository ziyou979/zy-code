/**
 * Effort 可视化选择器组件。
 *
 * 使用等宽空格精确对齐各行，确保 ▲ 位置与标签起始列一致。
 * 所有行都渲染为纯文本字符行，避免 flexbox 布局造成的偏移。
 *
 * 渲染效果：
 *              思考强度
 *    更快                       更智能
 *    ──────────────▲─────────────────────
 *      关闭    均衡     深度     极致    编排
 *              极致 + 工作流
 *    ←/→ 调整 · Enter 确认 · Esc 取消
 */
import * as React from 'react'
import { useMemo, useState } from 'react'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { tSync } from '../../i18n/index.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink/index.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { LocalJSXCommandOnDone } from '../types.js'
import { type EffortLevel } from '../../utils/effort.js'
import type { Theme } from '../../utils/theme.js'
import { executeEffort } from './effort.js'
import {
  computePickerLayout,
  getInitialSelectedIndex,
  type PickerLayout,
} from './effortPickerData.js'

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 居中对齐文本。
 */
function centerText(text: string, width: number): string {
  const pad = Math.max(0, width - text.length)
  const left = Math.floor(pad / 2)
  return ' '.repeat(left) + text + ' '.repeat(pad - left)
}

/**
 * 左右放置两个标签，中间用空格填充。
 */
function polarRow(leftLabel: string, rightLabel: string, width: number): string {
  const pad = Math.max(0, width - leftLabel.length - rightLabel.length)
  return leftLabel + ' '.repeat(pad) + rightLabel
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

export function EffortPicker({ onDone }: { onDone: LocalJSXCommandOnDone }) {
  const model = useMainLoopModel()
  const effortValue = useAppState((s) => s.effortValue) as EffortLevel | undefined
  const setAppState = useSetAppState()
  const [selectedIndex, setSelectedIndex] = useState<number>(-1)
  const [confirmingHigh, setConfirmingHigh] = useState(false)

  // 终端宽度用于居中
  let columns = 80
  try {
    columns = useTerminalSize().columns
  } catch {
    /* Ink context not available */
  }

  // 计算选择器布局
  const layout = useMemo(() => {
    if (!model) return null
    return computePickerLayout(model)
  }, [model])

  // 计算初始选中索引
  const initialIndex = useMemo(() => {
    if (!layout || !model) return -1
    return getInitialSelectedIndex(model, effortValue, layout.levels)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout])

  // 同步选中索引
  if (selectedIndex === -1 && initialIndex >= 0) {
    setSelectedIndex(initialIndex)
  }

  // 应用 effort
  const applyEffort = (level: EffortLevel) => {
    const result = executeEffort(level, model ?? '')
    if (result.effortUpdate) {
      setAppState((prev) => ({ ...prev, effortValue: result.effortUpdate!.value }))
    }
    onDone(result.message)
  }

  // 键盘事件
  const handleKeyDown = (e: KeyboardEvent) => {
    if (!layout) return

    if (confirmingHigh) {
      if (e.key === 'return') {
        const level = layout.levels[selectedIndex]!
        applyEffort(level.value)
      }
      if (e.key === 'escape' || e.key === 'left' || e.key === 'right') {
        e.preventDefault()
        setConfirmingHigh(false)
      }
      return
    }

    switch (e.key) {
      case 'left':
        e.preventDefault()
        setSelectedIndex((prev) => Math.max(0, prev - 1))
        break
      case 'right':
        e.preventDefault()
        setSelectedIndex((prev) => Math.min(layout.levels.length - 1, prev + 1))
        break
      case 'return': {
        e.preventDefault()
        const level = layout.levels[selectedIndex]
        if (!level) break
        if (level.value === 'orchestrate' || level.value === 'ultra' || level.value === 'extreme') {
          setConfirmingHigh(true)
          break
        }
        applyEffort(level.value)
        break
      }
      case 'escape':
        e.preventDefault()
        onDone(tSync('effort.picker.cancelled') || 'Cancelled')
        break
    }
  }

  // 模型不支持 effort
  if (!layout) {
    return (
      <Text dimColor={true}>
        {tSync('effort.picker.notSupported', { model: model ?? 'unknown' }) ||
          `Effort is not supported for the current model (${model ?? 'unknown'}).`}
      </Text>
    )
  }

  // 二次确认对话框
  if (confirmingHigh && layout.levels[selectedIndex]) {
    const level = layout.levels[selectedIndex]!
    return (
      <Box flexDirection="column">
        <Text>
          {tSync('effort.picker.confirmPrompt', { level: level.label }) ||
            `Set effort to ${level.label}?`}
        </Text>
        <Text>
          <Text bold={true}>Enter</Text>
          {tSync('effort.picker.toConfirm') || ' to confirm'}
          {' \xB7 '}
          <Text bold={true}>Esc</Text>
          {tSync('effort.picker.toCancel') || ' to cancel'}
        </Text>
      </Box>
    )
  }

  // ── 构建各行字符内容 ──

  const W = layout.totalWidth
  const leftPad = Math.max(0, Math.floor((columns - W) / 2))
  const pad = (text: string) => ' '.repeat(leftPad) + text
  const selectedLevel = layout.levels[selectedIndex]
  const accentColor = (selectedLevel?.color ?? 'autoAccept') as keyof Theme

  // 1. 标题行
  const titleLine = centerText(tSync('effort.picker.title') || 'Effort', W)

  // 2. 极标签行
  const fasterText = tSync('effort.picker.faster') || 'Faster'
  const smarterText = tSync('effort.picker.smarter') || 'Smarter'
  const polarLine = polarRow(fasterText, smarterText, W)

  // 3. 轨道行：──▲──
  const triangleCol = layout.trianglePositions[selectedIndex] ?? 0
  const trackLeft = '\u2500'.repeat(triangleCol)
  const trackRight = '\u2500'.repeat(Math.max(0, W - triangleCol - 1))

  // 4. 标签行：逐个放在 labelStarts 指定列
  // 构建标签段列表（每段有文本、颜色、是否选中）
  type LabelSegment = { text: string; color: string; selected: boolean; isContent: boolean }
  const labelSegs: LabelSegment[] = []
  let curCol = 0
  for (let i = 0; i < layout.levels.length; i++) {
    const start = layout.labelStarts[i]!
    const lbl = layout.levels[i]!
    if (start > curCol) {
      labelSegs.push({
        text: ' '.repeat(start - curCol),
        color: 'inactive',
        selected: false,
        isContent: false,
      })
    }
    labelSegs.push({
      text: lbl.label,
      color: lbl.color,
      selected: i === selectedIndex,
      isContent: true,
    })
    curCol = start + lbl.label.length
  }
  if (curCol < W) {
    labelSegs.push({
      text: ' '.repeat(W - curCol),
      color: 'inactive',
      selected: false,
      isContent: false,
    })
  }

  // 5. 副标签
  const sublabelText = layout.sublabel?.text
  const sublabelLine = sublabelText ? centerText(sublabelText, W) : undefined

  // 6. 键盘提示（按键名保持原文，仅动作描述 i18n）

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus={true} onKeyDown={handleKeyDown}>
      {/* 标题 */}
      <Text bold={true}>{pad(titleLine)}</Text>

      {/* 空行 */}
      <Text>{pad(' '.repeat(W))}</Text>

      {/* Faster / Smarter */}
      <Text dimColor={true}>{pad(polarLine)}</Text>

      {/* 轨道条 */}
      <Box>
        <Text>{pad('')}</Text>
        <Text>{trackLeft}</Text>
        <Text bold={true} backgroundColor={accentColor} color="#fff">
          {'\u25B2'}
        </Text>
        <Text>{trackRight}</Text>
      </Box>

      {/* 档位标签 */}
      <Box>
        <Text>{pad('')}</Text>
        {labelSegs.map((seg, i) => {
          if (seg.isContent) {
            return (
              <Text key={i} bold={seg.selected} color={seg.color as keyof Theme}>
                {seg.text}
              </Text>
            )
          }
          return (
            <Text key={i} dimColor={true}>
              {seg.text}
            </Text>
          )
        })}
      </Box>

      {/* 副标签 */}
      {sublabelLine && <Text dimColor={true}>{pad(sublabelLine)}</Text>}

      {/* 空行 */}
      <Text>{pad(' '.repeat(W))}</Text>

      {/* 键盘提示 */}
      <Box>
        <Text dimColor={true}>{pad('')}</Text>
        <Text dimColor={true}>
          {'\u2190'}/<Text bold={true}>{'\u2192'}</Text>
          {tSync('effort.picker.toAdjust') || ' to adjust'}
          {' \xB7 '}
          <Text bold={true}>Enter</Text>
          {tSync('effort.picker.toConfirm') || ' to confirm'}
          {' \xB7 '}
          <Text bold={true}>Esc</Text>
          {tSync('effort.picker.toCancel') || ' to cancel'}
        </Text>
      </Box>
    </Box>
  )
}
