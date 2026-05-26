// REPL transcript 内的搜索（/ + n / N）状态与行为。
// 抽自 screens/REPL.tsx 4810-4876 + 4960-4981 的 search 相关部分：
// - jumpRef + 4 个 useState（searchOpen / searchQuery / searchCount / searchCurrent）
// - useInput 的 / + n / N 键绑定（受 screen / virtualScrollActive / dumpMode 门控）
// - useSearchHighlight + 终端宽度变化时的 reset effect
// - 与 highlight overlay 同步 + inTranscript 退出时的清理
//
// 不包含编辑器渲染流（v 键 + dump 模式）—— 那部分仍在 REPL，等 transcript editor
// container 抽出时再迁。

import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { JumpHandle } from '../../components/VirtualMessageList.js'
import { useInput } from '../../ink.js'
import { useSearchHighlight } from '../../ink/hooks/use-search-highlight.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'

export type UseReplSearchParams = {
  /** 用于 useInput 与 reset effect 的"是否在 transcript"投影 */
  inTranscript: boolean
  /** 与 inTranscript 拆开是为了让 useInput 的 isActive 与原 REPL.tsx:4853 一致：
   *  screen === 'transcript' && virtualScrollActive && !searchOpen && !dumpMode。
   *  原文件中 useInput 的 isActive 直接消费这两个变量，因此 hook 入参保持原样。 */
  screen: 'prompt' | 'transcript'
  virtualScrollActive: boolean
  dumpMode: boolean
}

export type ReplSearchApi = {
  jumpRef: React.RefObject<JumpHandle | null>
  searchOpen: boolean
  setSearchOpen: React.Dispatch<React.SetStateAction<boolean>>
  searchQuery: string
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>
  searchCount: number
  setSearchCount: React.Dispatch<React.SetStateAction<number>>
  searchCurrent: number
  setSearchCurrent: React.Dispatch<React.SetStateAction<number>>
  onSearchMatchesChange: (count: number, current: number) => void
  setHighlight: (query: string) => void
  scanElement: ReturnType<typeof useSearchHighlight>['scanElement']
  setPositions: ReturnType<typeof useSearchHighlight>['setPositions']
}

export function useReplSearch({
  inTranscript,
  screen,
  virtualScrollActive,
  dumpMode,
}: UseReplSearchParams): ReplSearchApi {
  // 门控 useInput。查询在 bar 打开/关闭之间持续，所以 n/N 在
  // Enter 关闭 bar 后继续工作（less 语义）
  const jumpRef = useRef<JumpHandle | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchCount, setSearchCount] = useState(0)
  const [searchCurrent, setSearchCurrent] = useState(0)
  const onSearchMatchesChange = useCallback((count: number, current: number) => {
    setSearchCount(count)
    setSearchCurrent(current)
  }, [])

  useInput(
    (input, key, event) => {
      if (key.ctrl || key.meta) {
        return
      }
      // No Esc handling here — less has no navigating mode. Search state
      // (highlights, n/N) is just state. Esc/q/ctrl+c → transcript:exit
      // (ungated). Highlights clear on exit via the screen-change effect.
      if (input === '/') {
        // 立即捕获 scrollTop —— 打字是预览，0 匹配会跳回这里。
        // 同步 ref 写入，在 bar 的 mount-effect 调用 setSearchQuery 之前触发
        jumpRef.current?.setAnchor()
        setSearchOpen(true)
        event.stopImmediatePropagation()
        return
      }
      // 按住键批处理：tokenizer 合并为 'nnn'。与 ScrollKeybindingHandler.tsx
      // 中 modalPagerAction 相同的 uniform-batch 模式。每次重复是一步（n 不是幂等的，不像 g）
      const c = input[0]
      if ((c === 'n' || c === 'N') && input === c.repeat(input.length) && searchCount > 0) {
        const fn = c === 'n' ? jumpRef.current?.nextMatch : jumpRef.current?.prevMatch
        if (fn) {
          for (let i = 0; i < input.length; i++) {
            fn()
          }
        }
        event.stopImmediatePropagation()
      }
    },
    // 搜索需要虚拟滚动（jumpRef 驱动 VirtualMessageList）。[
    // 杀死它，所以 !dumpMode —— 在 [ 之后没什么可跳转的
    {
      isActive: screen === 'transcript' && virtualScrollActive && !searchOpen && !dumpMode,
    },
  )
  const { setQuery: setHighlight, scanElement, setPositions } = useSearchHighlight()

  // 调整大小 → 中止搜索。Positions 以 (msg, query, WIDTH) 为键 ——
  // 宽度变化后缓存的 positions 过时（新布局，新换行）。
  // 清除 searchQuery 触发 VML 的 setSearchQuery('') 清除 positionsCache +
  // setPositions(null)。bar 关闭。用户再次按 / → 全新初始化
  const transcriptCols = useTerminalSize().columns
  const prevColsRef = React.useRef(transcriptCols)
  React.useEffect(() => {
    if (prevColsRef.current !== transcriptCols) {
      prevColsRef.current = transcriptCols
      if (searchQuery || searchOpen) {
        setSearchOpen(false)
        setSearchQuery('')
        setSearchCount(0)
        setSearchCurrent(0)
        jumpRef.current?.disarmSearch()
        setHighlight('')
      }
    }
  }, [transcriptCols, searchQuery, searchOpen, setHighlight])

  // 离开 transcript 时清掉搜索状态。原 REPL.tsx:4961-4972 的 inTranscript
  // reset effect 现在拆为两段：search 部分在此，editor / dump 部分留在 REPL
  // 等 transcript editor container 抽出时再迁。
  useEffect(() => {
    if (!inTranscript) {
      setSearchQuery('')
      setSearchCount(0)
      setSearchCurrent(0)
      setSearchOpen(false)
    }
  }, [inTranscript])

  // 与 highlight overlay 同步：进入 transcript 时透传 query，
  // 离开时强制清掉 position-based current overlay。
  useEffect(() => {
    setHighlight(inTranscript ? searchQuery : '')
    if (!inTranscript) {
      setPositions(null)
    }
  }, [inTranscript, searchQuery, setHighlight, setPositions])

  return {
    jumpRef,
    searchOpen,
    setSearchOpen,
    searchQuery,
    setSearchQuery,
    searchCount,
    setSearchCount,
    searchCurrent,
    setSearchCurrent,
    onSearchMatchesChange,
    setHighlight,
    scanElement,
    setPositions,
  }
}
