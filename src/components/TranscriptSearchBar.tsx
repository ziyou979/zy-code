import React, { type RefObject, useEffect } from 'react'
import type { JumpHandle } from './VirtualMessageList.js'
import { useSearchInput } from '../hooks/useSearchInput.js'
import { Box, Text } from '../ink.js'

/** less 风格 / bar。1 行，与 TranscriptModeFooter 相同的 border-top 样式
 *  所以在 bottom 插槽中交换它们不会改变 ScrollBox 高度。
 *  useSearchInput 处理 readline 编辑；我们报告查询变化并
 *  渲染计数器。增量 — 每次按键重新搜索 + 高亮。 */
export function TranscriptSearchBar({
  jumpRef,
  count,
  current,
  onClose,
  onCancel,
  setHighlight,
  initialQuery,
}: {
  jumpRef: RefObject<JumpHandle | null>
  count: number
  current: number
  /** Enter — 确认。查询保留以供 n/N 使用。 */
  onClose: (lastQuery: string) => void
  /** Esc/ctrl+c/ctrl+g — 撤销到搜索前状态。 */
  onCancel: () => void
  setHighlight: (query: string) => void
  // 使用之前的查询作为种子（less 风格：/ 显示上次模式）。effect 挂载时
  // 用相同查询重新扫描 — 幂等（相同匹配、最近指针、相同高亮）。用户可以编辑或清除。
  initialQuery: string
}): React.ReactNode {
  const { query, cursorOffset } = useSearchInput({
    isActive: true,
    initialQuery,
    onExit: () => onClose(query),
    onCancel,
  })
  // 索引预热在查询 effect 之前运行，以便测量真实成本 —
  // 否则 setSearchQuery 先填充缓存，warm 报告 ~0ms 而用户
  // 实际感受到了延迟。
  // 转录模式会话中第一次 / 需要支付 extractSearchText 成本。
  // 后续 / 立即返回 0（VML 中的 indexWarmed ref）。
  // 转录在 ctrl+o 时冻结，因此缓存保持有效。
  // 初始 'building' 使 warmDone 在挂载时为 false — [query] effect
  // 等待 warm effect 首次 resolve 而不是与之竞争。如果初始为 null，
  // warmDone 会在挂载时为 true → [query] 触发 → setSearchQuery 填充
  // 缓存 → warm 报告 ~0ms 而用户实际感受到了延迟。
  const [indexStatus, setIndexStatus] = React.useState<
    | 'building'
    | {
        ms: number
      }
    | null
  >('building')
  React.useEffect(() => {
    let alive = true
    const warm = jumpRef.current?.warmSearchIndex
    if (!warm) {
      setIndexStatus(null) // VML not mounted yet — rare, skip indicator
      return
    }
    setIndexStatus('building')
    warm().then((ms) => {
      if (!alive) return
      // <20ms = 无法察觉。没必要显示 "indexed in 3ms"。
      if (ms < 20) {
        setIndexStatus(null)
      } else {
        setIndexStatus({
          ms,
        })
        setTimeout(() => alive && setIndexStatus(null), 2000)
      }
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // mount-only: bar opens once per /
  // 以 warm 完成为门控来控制 query effect。setHighlight 保持即时
  // （屏幕空间叠加层，无需索引）。setSearchQuery（扫描）会等待。
  const warmDone = indexStatus !== 'building'
  useEffect(() => {
    if (!warmDone) return
    jumpRef.current?.setSearchQuery(query)
    setHighlight(query)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, warmDone])
  const off = cursorOffset
  const cursorChar = off < query.length ? query[off] : ' '
  return (
    <Box
      borderTopDimColor
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderStyle="single"
      marginTop={1}
      paddingLeft={2}
      width="100%"
      // applySearchHighlight 扫描整个屏幕缓冲区。此处渲染的查询
      // 文本确实在屏幕上 — /foo 会匹配 bar 中的 'foo'。如果没有内容
      // 匹配，这是唯一可见的匹配 → 被标记为 CURRENT → 加下划线。
      // noSelect 使 searchHighlight.ts:76 跳过这些单元格（与边栏相同
      // 排除）。你也无法文本选择 bar；它是临时控件，没问题。
      noSelect
    >
      <Text>/</Text>
      <Text>{query.slice(0, off)}</Text>
      <Text inverse>{cursorChar}</Text>
      {off < query.length && <Text>{query.slice(off + 1)}</Text>}
      <Box flexGrow={1} />
      {indexStatus === 'building' ? (
        <Text dimColor>indexing… </Text>
      ) : indexStatus ? (
        <Text dimColor>indexed in {indexStatus.ms}ms </Text>
      ) : count === 0 && query ? (
        <Text color="error">no matches </Text>
      ) : count > 0 ? (
        // 引擎计数（extractSearchText 上的 indexOf）。可能与渲染计数
        // 因幽灵/幻影消息而有偏差 — 徽章是粗略的位置提示。scanElement
        // 给出每条消息的精确位置，但计算所有匹配的成本约为 ~1-3ms × 匹配消息数。
        <Text dimColor>
          {current}/{count}
          {'  '}
        </Text>
      ) : null}
    </Box>
  )
}
