// transcript 内的 dump 模式（[）+ 外部编辑器（v）行为 hook。
// 抽自 screens/REPL.tsx 4790-4881 的 useInput + inTranscript reset effect。
//
// 设计抉择：dumpMode / editorStatus 的 useState 仍由 REPL 主体持有（声明在 useReplSearch
// 之前），本 hook 仅接管「行为」—— 3 个私有 ref（editorGen / editorTimer / editorRendering）
// + useInput([/v/q) + inTranscript 退出时的 editor / dump reset。
// 这样设计是因为 useReplSearch 的 useInput.isActive 需要 dumpMode 值；如果 dumpMode 由
// 本 hook 拥有并返回，会形成「search 在前-需要 dumpMode / editor 在后-返回 dumpMode」的
// 循环。状态留 REPL、行为外移是最小切面。
//
// 异步 v 渲染流：开始时捕获 generation token，写状态时检查 gen 是否过期，
// render 用 deferredMessages + tools，写 tmp 后 openFileInExternalEditor 拉起。

import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type React from 'react'
import { useEffect, useRef } from 'react'
import { useInput } from '../../ink.js'
import type { Tools } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { openFileInExternalEditor } from '../../utils/editor.js'
import { renderMessagesToPlainText } from '../../utils/exportRenderer.js'

export type UseTranscriptEditorParams = {
  /** 当前是否在 transcript 视图（screen === 'transcript' && virtualScrollActive） */
  inTranscript: boolean
  /** useInput 的 isActive 仍按原 REPL.tsx:4865 形态：!searchOpen 但不带 !dumpMode（[ 处理器自身守卫） */
  screen: 'prompt' | 'transcript'
  virtualScrollActive: boolean
  searchOpen: boolean
  /** v 异步流的渲染数据源 —— 用 deferredMessages 而非 messages 以避免抢占 React 优先级 */
  deferredMessages: readonly Message[]
  tools: Tools
  /** dumpMode 值由 REPL 主体的 useState 持有，本 hook 通过 setter 写入 */
  dumpMode: boolean
  setDumpMode: React.Dispatch<React.SetStateAction<boolean>>
  setEditorStatus: React.Dispatch<React.SetStateAction<string>>
  /** [ 处理器在进入 dump 模式时同步打开「展开 + 解除限制」 */
  setShowAllInTranscript: (next: boolean) => void
  /** q 处理器调用以退出 transcript（清 frozen state 等由 REPL 端负责） */
  handleExitTranscript: () => void
}

export function useTranscriptEditor({
  inTranscript,
  screen,
  virtualScrollActive,
  searchOpen,
  deferredMessages,
  tools,
  dumpMode,
  setDumpMode,
  setEditorStatus,
  setShowAllInTranscript,
  handleExitTranscript,
}: UseTranscriptEditorParams): void {
  // 退出转录时递增。异步 v-render 在开始时捕获此值；
  // 如果过时，每次状态写入都无操作（用户在渲染中间离开转录 —
  // 稳定的 setState 否则会将幽灵 toast 印入下一个会话）。
  // 同时清除任何待处理的 4 秒自动清除。
  const editorGenRef = useRef(0)
  const editorTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const editorRenderingRef = useRef(false)

  useInput(
    (input, key, event) => {
      if (key.ctrl || key.meta) {
        return
      }
      if (input === 'q') {
        // less: q 退出 pager。ctrl+o 切换；q 是 lineage 退出
        handleExitTranscript()
        event.stopImmediatePropagation()
        return
      }
      if (input === '[' && !dumpMode) {
        // 强制转储到回滚。同时展开 + 解除限制 —— 转储子集没有意义。
        // 终端/tmux cmd-F 现在可以搜索任何内容。守卫在此
        // （不在 isActive 中）所以 v 在 [ 之后仍然有效 —— dump-mode footer
        // 连接 editorStatus，确认 v 应该保持活跃
        setDumpMode(true)
        setShowAllInTranscript(true)
        event.stopImmediatePropagation()
      } else if (input === 'v') {
        // less 风格：v 在 $VISUAL/$EDITOR 中打开文件。渲染完整
        // 转录（与 /export 相同的路径），写入 tmp，交出。
        // openFileInExternalEditor 处理终端编辑器的 alt-screen 挂起/恢复；
        // GUI 编辑器分离生成
        event.stopImmediatePropagation()
        // 防止双击：渲染是异步的，在完成前的第二次按下会运行
        // 第二个并行渲染（双倍内存、两个临时文件、两次编辑器生成）。
        // editorGenRef 仅守卫转录退出过时的情况，不守卫同会话并发
        if (editorRenderingRef.current) {
          return
        }
        editorRenderingRef.current = true
        // 捕获 generation + 创建防过时 setter。每次写入检查 gen
        // （转录退出增加它 —— 来自异步渲染的迟写入静默失败）
        const gen = editorGenRef.current
        const setStatus = (s: string): void => {
          if (gen !== editorGenRef.current) {
            return
          }
          clearTimeout(editorTimerRef.current)
          setEditorStatus(s)
        }
        setStatus(`rendering ${deferredMessages.length} messages…`)
        void (async () => {
          try {
            // 宽度 = 终端宽度减去 vim 的行号边栏（4 位数字 +
            // 空格 + 余量）。最低 80。PassThrough 没有 .columns 所以
            // 没有这个 Ink 默认 80。去除尾部空格：右对齐的时间戳
            // 仍然在行尾留下 flexbox 空格运行
            // eslint-disable-next-line custom-rules/prefer-use-terminal-size -- one-shot at keypress time, not a reactive render dep
            const w = Math.max(80, (process.stdout.columns ?? 80) - 6)
            const raw = await renderMessagesToPlainText([...deferredMessages], tools, w)
            const text = raw.replace(/[ \t]+$/gm, '')
            const path = join(tmpdir(), `cc-transcript-${Date.now()}.txt`)
            await writeFile(path, text)
            const opened = openFileInExternalEditor(path)
            setStatus(opened ? `opening ${path}` : `wrote ${path} · no $VISUAL/$EDITOR set`)
          } catch (e) {
            setStatus(`render failed: ${e instanceof Error ? e.message : String(e)}`)
          }
          editorRenderingRef.current = false
          if (gen !== editorGenRef.current) {
            return
          }
          editorTimerRef.current = setTimeout((s) => s(''), 4000, setEditorStatus)
        })()
      }
    },
    // !searchOpen: 在搜索栏中键入 'v' 或 '[' 是搜索输入，不是
    // 命令。此处无 !dumpMode —— v 在 [ 之后应该有效（[ 处理程序
    // 在内部自行守卫）
    {
      isActive: screen === 'transcript' && virtualScrollActive && !searchOpen,
    },
  )

  // 每次转录条目使用新的 `less`：增加 generation 使在飞的 v 流静默作废，
  // 清掉编辑器 timer，复位 dump / editor state。
  // search 部分的 reset 在 useReplSearch 内独立处理。
  useEffect(() => {
    if (!inTranscript) {
      editorGenRef.current++
      clearTimeout(editorTimerRef.current)
      setDumpMode(false)
      setEditorStatus('')
    }
  }, [inTranscript, setDumpMode, setEditorStatus])
}
