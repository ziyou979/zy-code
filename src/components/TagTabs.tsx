import React from 'react'
import { stringWidth } from '../ink/stringWidth.js'
import { Box, Text } from '../ink.js'
import { tSync } from '../i18n/index.js'
import { truncateToWidth } from '../utils/format.js'

// 宽度计算常量——来源于实际渲染的字符串
const ALL_TAB_LABEL = 'All'
const TAB_PADDING = 2 // 标签文本前后的空格：" {tab} "
const HASH_PREFIX_LENGTH = 1 // "#" prefix for non-All tabs
const LEFT_ARROW_PREFIX = '← '
const RIGHT_HINT_WITH_COUNT_PREFIX = '→'
const RIGHT_HINT_SUFFIX = tSync('tagTabs.rightHint')
const RIGHT_HINT_NO_COUNT = tSync('tagTabs.rightHintNoCount')
const MAX_OVERFLOW_DIGITS = 2 // 假设最多 99 个隐藏标签用于宽度计算

// 计算出的宽度
const LEFT_ARROW_WIDTH = LEFT_ARROW_PREFIX.length + MAX_OVERFLOW_DIGITS + 1 // "← NN " with gap
const RIGHT_HINT_WIDTH_WITH_COUNT =
  RIGHT_HINT_WITH_COUNT_PREFIX.length + MAX_OVERFLOW_DIGITS + RIGHT_HINT_SUFFIX.length // "→NN (tab to cycle)"
const RIGHT_HINT_WIDTH_NO_COUNT = RIGHT_HINT_NO_COUNT.length
type Props = {
  tabs: string[]
  selectedIndex: number
  availableWidth: number
  showAllProjects?: boolean
}

/**
 * 计算标签的显示宽度
 */
function getTabWidth(tab: string, maxWidth?: number): number {
  if (tab === ALL_TAB_LABEL) {
    return ALL_TAB_LABEL.length + TAB_PADDING
  }
  // 非 All 标签：" #{tag} "，但必要时截断 tag
  const tagWidth = stringWidth(tab)
  const effectiveTagWidth = maxWidth
    ? Math.min(tagWidth, maxWidth - TAB_PADDING - HASH_PREFIX_LENGTH)
    : tagWidth
  return Math.max(0, effectiveTagWidth) + TAB_PADDING + HASH_PREFIX_LENGTH
}

/**
 * 截断标签以在 maxWidth 内显示，考虑填充和 # 前缀
 */
function truncateTag(tag: string, maxWidth: number): string {
  // 标签文本本身的可用空间：maxWidth - " #" - " "
  const availableForTag = maxWidth - TAB_PADDING - HASH_PREFIX_LENGTH
  if (stringWidth(tag) <= availableForTag) {
    return tag
  }
  if (availableForTag <= 1) {
    return tag.charAt(0)
  }
  return truncateToWidth(tag, availableForTag)
}
export function TagTabs({
  tabs,
  selectedIndex,
  availableWidth,
  showAllProjects = false,
}: Props): React.ReactNode {
  const resumeLabel = showAllProjects ? tSync('tagTabs.resumeAllProjects') : tSync('tagTabs.resume')
  const resumeLabelWidth = resumeLabel.length + 1 // +1 for gap

  // 计算有多少空间用于标签（使用最坏情况的提示宽度）
  const rightHintWidth = Math.max(RIGHT_HINT_WIDTH_WITH_COUNT, RIGHT_HINT_WIDTH_NO_COUNT)
  const maxTabsWidth = availableWidth - resumeLabelWidth - rightHintWidth - 2 // 2 for gaps

  // 将 selectedIndex 钳位到有效范围
  const safeSelectedIndex = Math.max(0, Math.min(selectedIndex, tabs.length - 1))

  // 计算每个标签的宽度，对非常长的标签进行截断
  const maxSingleTabWidth = Math.max(20, Math.floor(maxTabsWidth / 2)) // 至少为一个标签显示一半空间
  const tabWidths = tabs.map((tab) => getTabWidth(tab, maxSingleTabWidth))

  // 找到适合的一窗标签，以 selectedIndex 为中心
  let startIndex = 0
  let endIndex = tabs.length

  // 计算所有标签的总宽度
  const totalTabsWidth = tabWidths.reduce(
    (sum, w, i) => sum + w + (i < tabWidths.length - 1 ? 1 : 0),
    0,
  ) // +1 for gaps between tabs

  if (totalTabsWidth > maxTabsWidth) {
    // 需要显示子集——不在开头时考虑左箭头
    const effectiveMaxWidth = maxTabsWidth - LEFT_ARROW_WIDTH

    // 从选中的标签开始
    let windowWidth = tabWidths[safeSelectedIndex] ?? 0
    startIndex = safeSelectedIndex
    endIndex = safeSelectedIndex + 1

    // 扩展窗口以包含更多标签
    while (startIndex > 0 || endIndex < tabs.length) {
      const canExpandLeft = startIndex > 0
      const canExpandRight = endIndex < tabs.length
      if (canExpandLeft) {
        const leftWidth = (tabWidths[startIndex - 1] ?? 0) + 1 // +1 for gap
        if (windowWidth + leftWidth <= effectiveMaxWidth) {
          startIndex--
          windowWidth += leftWidth
          continue
        }
      }
      if (canExpandRight) {
        const rightWidth = (tabWidths[endIndex] ?? 0) + 1 // +1 for gap
        if (windowWidth + rightWidth <= effectiveMaxWidth) {
          endIndex++
          windowWidth += rightWidth
          continue
        }
      }
      break
    }
  }
  const hiddenLeft = startIndex
  const hiddenRight = tabs.length - endIndex
  const visibleTabs = tabs.slice(startIndex, endIndex)
  const visibleIndices = visibleTabs.map((_, i_0) => startIndex + i_0)
  return (
    <Box flexDirection="row" gap={1}>
      <Text color="suggestion">{resumeLabel}</Text>
      {hiddenLeft > 0 && (
        <Text dimColor>
          {LEFT_ARROW_PREFIX}
          {hiddenLeft}
        </Text>
      )}
      {visibleTabs.map((tab_0, i_1) => {
        const actualIndex = visibleIndices[i_1]!
        const isSelected = actualIndex === safeSelectedIndex
        const displayText =
          tab_0 === ALL_TAB_LABEL
            ? tab_0
            : `#${truncateTag(tab_0, maxSingleTabWidth - TAB_PADDING)}`
        return (
          <Text
            key={tab_0}
            backgroundColor={isSelected ? 'suggestion' : undefined}
            color={isSelected ? 'inverseText' : undefined}
            bold={isSelected}
          >
            {' '}
            {displayText}{' '}
          </Text>
        )
      })}
      {hiddenRight > 0 ? (
        <Text dimColor>
          {RIGHT_HINT_WITH_COUNT_PREFIX}
          {hiddenRight}
          {RIGHT_HINT_SUFFIX}
        </Text>
      ) : (
        <Text dimColor>{RIGHT_HINT_NO_COUNT}</Text>
      )}
    </Box>
  )
}
