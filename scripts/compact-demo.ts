#!/usr/bin/env bun
/**
 * 压缩策略对比演示脚本
 *
 * 使用方式：
 *   bun run scripts/compact-demo.ts [conversation.json]
 *
 * 如果未指定对话文件，使用内置示例对话。
 * 对话文件格式：JSON 数组，每项为 { role: "user"|"assistant", content: string }
 *
 * 功能：
 * 1. 展示原始对话的 token 估算
 * 2. 模拟 ZY-Code 各层压缩策略的效果（Snip / Context Collapse / Full Compact）
 * 3. 模拟 Claude Code 原版压缩策略的效果（全量 Compact / Reactive Compact）
 * 4. 对比输出 token 节省率和信息保留程度
 */

import { readFileSync } from 'node:fs'

// ============================================================================
// Token 估算（简易版：4 字符 ≈ 1 token）
// ============================================================================

function estimateTokens(text: string): number {
  // 粗略估算：英文 ~4 chars/token，中文 ~1.5 chars/token
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const otherChars = text.length - chineseChars
  return Math.ceil(chineseChars / 1.5 + otherChars / 4)
}

// ============================================================================
// 消息类型
// ============================================================================

interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
  // 模拟 tool_use / tool_result
  toolUse?: { name: string; input: string }
  toolResult?: { output: string }
}

interface CompactResult {
  strategy: string
  description: string
  originalTokens: number
  resultTokens: number
  savedPercent: number
  output: string
  preservedMessages: number
  totalMessages: number
}

// ============================================================================
// 示例对话（模拟真实开发场景）
// ============================================================================

const SAMPLE_CONVERSATION: Message[] = [
  {
    role: 'user',
    content:
      '帮我在 src/utils/format.ts 中添加一个 formatDate 函数，支持 YYYY-MM-DD 和 relative 两种格式',
  },
  {
    role: 'assistant',
    content: `好的，让我先看一下现有的 format.ts 文件。

我已经读取了文件内容，现在来添加 formatDate 函数：

\`\`\`typescript
export function formatDate(date: Date, format: 'iso' | 'relative' = 'iso'): string {
  if (format === 'relative') {
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    const seconds = Math.floor(diff / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)

    if (days > 0) return \`\${days} 天前\`
    if (hours > 0) return \`\${hours} 小时前\`
    if (minutes > 0) return \`\${minutes} 分钟前\`
    return '刚刚'
  }

  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return \`\${year}-\${month}-\${day}\`
}
\`\`\`

已经添加到 src/utils/format.ts 中了。`,
  },
  {
    role: 'user',
    content: '还需要加上时间部分，支持 YYYY-MM-DD HH:mm:ss',
  },
  {
    role: 'assistant',
    content: `明白，我来更新 formatDate 函数，增加对完整日期时间格式的支持：

\`\`\`typescript
export function formatDate(
  date: Date,
  format: 'iso' | 'datetime' | 'relative' = 'iso'
): string {
  if (format === 'relative') {
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    const seconds = Math.floor(diff / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)

    if (days > 0) return \`\${days} 天前\`
    if (hours > 0) return \`\${hours} 小时前\`
    if (minutes > 0) return \`\${minutes} 分钟前\`
    return '刚刚'
  }

  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  if (format === 'datetime') {
    const hours = String(date.getHours()).padStart(2, '0')
    const mins = String(date.getMinutes()).padStart(2, '0')
    const secs = String(date.getSeconds()).padStart(2, '0')
    return \`\${year}-\${month}-\${day} \${hours}:\${mins}:\${secs}\`
  }

  return \`\${year}-\${month}-\${day}\`
}
\`\`\`

已更新完成。`,
  },
  {
    role: 'user',
    content: '好的，现在帮我写一个测试文件 tests/utils/format.test.ts',
  },
  {
    role: 'assistant',
    content: `我来为 formatDate 函数创建测试文件：

\`\`\`typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { formatDate } from '../../src/utils/format'

describe('formatDate', () => {
  describe('iso format', () => {
    it('should format date as YYYY-MM-DD', () => {
      const date = new Date(2024, 0, 15) // 2024-01-15
      expect(formatDate(date)).toBe('2024-01-15')
      expect(formatDate(date, 'iso')).toBe('2024-01-15')
    })

    it('should pad month and day with zeros', () => {
      const date = new Date(2024, 2, 5) // 2024-03-05
      expect(formatDate(date, 'iso')).toBe('2024-03-05')
    })
  })

  describe('datetime format', () => {
    it('should format as YYYY-MM-DD HH:mm:ss', () => {
      const date = new Date(2024, 0, 15, 14, 30, 45)
      expect(formatDate(date, 'datetime')).toBe('2024-01-15 14:30:45')
    })

    it('should pad time components with zeros', () => {
      const date = new Date(2024, 0, 1, 8, 5, 3)
      expect(formatDate(date, 'datetime')).toBe('2024-01-01 08:05:03')
    })
  })

  describe('relative format', () => {
    let realDateNow: () => number

    beforeEach(() => {
      realDateNow = Date.now
    })

    afterEach(() => {
      Date.now = realDateNow
    })

    it('should return "刚刚" for less than a minute', () => {
      const now = new Date()
      const date = new Date(now.getTime() - 30 * 1000) // 30 seconds ago
      expect(formatDate(date, 'relative')).toBe('刚刚')
    })

    it('should return minutes ago', () => {
      const now = new Date()
      const date = new Date(now.getTime() - 5 * 60 * 1000) // 5 minutes ago
      expect(formatDate(date, 'relative')).toBe('5 分钟前')
    })

    it('should return hours ago', () => {
      const now = new Date()
      const date = new Date(now.getTime() - 3 * 60 * 60 * 1000) // 3 hours ago
      expect(formatDate(date, 'relative')).toBe('3 小时前')
    })

    it('should return days ago', () => {
      const now = new Date()
      const date = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000) // 2 days ago
      expect(formatDate(date, 'relative')).toBe('2 天前')
    })
  })
})
\`\`\`

测试文件已创建在 tests/utils/format.test.ts。覆盖了 iso、datetime 和 relative 三种格式，包含边界情况。`,
  },
  {
    role: 'user',
    content: '运行一下测试看看结果',
  },
  {
    role: 'assistant',
    content: `运行测试：

\`\`\`
$ bun test tests/utils/format.test.ts
bun test v1.2.0

tests/utils/format.test.ts:
✓ formatDate > iso format > should format date as YYYY-MM-DD [0.12ms]
✓ formatDate > iso format > should pad month and day with zeros [0.05ms]
✓ formatDate > datetime format > should format as YYYY-MM-DD HH:mm:ss [0.04ms]
✓ formatDate > datetime format > should pad time components with zeros [0.03ms]
✓ formatDate > relative format > should return "刚刚" for less than a minute [0.08ms]
✓ formatDate > relative format > should return minutes ago [0.03ms]
✓ formatDate > relative format > should return hours ago [0.02ms]
✓ formatDate > relative format > should return days ago [0.02ms]

 8 pass
 0 fail
 8 expect() calls
Ran 8 tests across 1 files. [28.00ms]
\`\`\`

全部 8 个测试通过！`,
  },
  {
    role: 'user',
    content:
      '很好。现在帮我在 src/components/DateDisplay.tsx 创建一个 React 组件，使用这个 formatDate 函数',
  },
  {
    role: 'assistant',
    content: `创建 DateDisplay 组件：

\`\`\`tsx
import React, { useMemo } from 'react'
import { formatDate } from '../utils/format'

interface DateDisplayProps {
  date: Date | string | number
  format?: 'iso' | 'datetime' | 'relative'
  className?: string
  /** 自动更新 relative 时间的间隔（毫秒），0 表示不自动更新 */
  autoRefresh?: number
}

export function DateDisplay({
  date,
  format = 'iso',
  className,
  autoRefresh = 0,
}: DateDisplayProps) {
  const [, setTick] = React.useState(0)

  const dateObj = useMemo(() => {
    if (date instanceof Date) return date
    return new Date(date)
  }, [date])

  React.useEffect(() => {
    if (format !== 'relative' || autoRefresh <= 0) return
    const timer = setInterval(() => setTick((t) => t + 1), autoRefresh)
    return () => clearInterval(timer)
  }, [format, autoRefresh])

  const formatted = formatDate(dateObj, format)

  return (
    <time dateTime={dateObj.toISOString()} className={className}>
      {formatted}
    </time>
  )
}
\`\`\`

组件支持：
- 接受 Date、string 或 number 类型输入
- 三种格式切换
- relative 格式可自动刷新
- 语义化 HTML time 标签`,
  },
  {
    role: 'user',
    content: '再加一个 tooltip，hover 时显示完整日期时间',
  },
  {
    role: 'assistant',
    content: `好的，给 DateDisplay 增加 tooltip 功能：

\`\`\`tsx
import React, { useMemo, useState } from 'react'
import { formatDate } from '../utils/format'

interface DateDisplayProps {
  date: Date | string | number
  format?: 'iso' | 'datetime' | 'relative'
  className?: string
  autoRefresh?: number
  /** 是否显示 hover tooltip，默认 true */
  showTooltip?: boolean
}

export function DateDisplay({
  date,
  format = 'iso',
  className,
  autoRefresh = 0,
  showTooltip = true,
}: DateDisplayProps) {
  const [, setTick] = useState(0)
  const [tooltipVisible, setTooltipVisible] = useState(false)

  const dateObj = useMemo(() => {
    if (date instanceof Date) return date
    return new Date(date)
  }, [date])

  React.useEffect(() => {
    if (format !== 'relative' || autoRefresh <= 0) return
    const timer = setInterval(() => setTick((t) => t + 1), autoRefresh)
    return () => clearInterval(timer)
  }, [format, autoRefresh])

  const formatted = formatDate(dateObj, format)
  const fullDateTime = formatDate(dateObj, 'datetime')

  return (
    <span
      className={\`date-display-wrapper \${className ?? ''}\`}
      onMouseEnter={() => setTooltipVisible(true)}
      onMouseLeave={() => setTooltipVisible(false)}
      style={{ position: 'relative', display: 'inline-block' }}
    >
      <time dateTime={dateObj.toISOString()}>
        {formatted}
      </time>
      {showTooltip && tooltipVisible && format !== 'datetime' && (
        <span
          className="date-display-tooltip"
          style={{
            position: 'absolute',
            bottom: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '4px 8px',
            borderRadius: '4px',
            background: '#333',
            color: '#fff',
            fontSize: '12px',
            whiteSpace: 'nowrap',
            marginBottom: '4px',
          }}
        >
          {fullDateTime}
        </span>
      )}
    </span>
  )
}
\`\`\`

现在 hover 时会在上方显示完整的 YYYY-MM-DD HH:mm:ss 格式（除非已经是 datetime 格式）。`,
  },
]

// ============================================================================
// 策略 1: Snip Compact（确定性裁剪 — ZY-Code 独有）
// ============================================================================

function simulateSnipCompact(messages: Message[]): CompactResult {
  const originalText = messages.map((m) => m.content).join('\n')
  const originalTokens = estimateTokens(originalText)

  // Snip 策略：按 API round 分组，保留最近 4 个 round
  const groups: Message[][] = []
  let currentGroup: Message[] = []

  for (const msg of messages) {
    if (msg.role === 'assistant' && currentGroup.length > 0) {
      groups.push(currentGroup)
      currentGroup = [msg]
    } else {
      currentGroup.push(msg)
    }
  }
  if (currentGroup.length > 0) groups.push(currentGroup)

  const MIN_KEEP = 4
  if (groups.length <= MIN_KEEP) {
    return {
      strategy: 'Snip Compact (ZY-Code)',
      description: '确定性裁剪：保留最近 4 个 API round，旧消息直接丢弃（不调用 LLM）',
      originalTokens,
      resultTokens: originalTokens,
      savedPercent: 0,
      output: '[消息数不足，无需裁剪]',
      preservedMessages: messages.length,
      totalMessages: messages.length,
    }
  }

  const keptGroups = groups.slice(-MIN_KEEP)
  const keptMessages = keptGroups.flat()
  const boundary = '[Context has been compacted to stay within limits.]'
  const resultText = boundary + '\n' + keptMessages.map((m) => m.content).join('\n')
  const resultTokens = estimateTokens(resultText)

  return {
    strategy: 'Snip Compact (ZY-Code)',
    description: '确定性裁剪：保留最近 4 个 API round，旧消息直接丢弃（不调用 LLM）',
    originalTokens,
    resultTokens,
    savedPercent: Math.round(((originalTokens - resultTokens) / originalTokens) * 100),
    output: `${boundary}\n\n--- 保留的消息 (${keptMessages.length}/${messages.length}) ---\n${keptMessages.map((m) => `[${m.role}]: ${m.content.slice(0, 80)}...`).join('\n')}`,
    preservedMessages: keptMessages.length,
    totalMessages: messages.length,
  }
}

// ============================================================================
// 策略 2: Context Collapse（细粒度折叠 — ZY-Code 独有）
// ============================================================================

function simulateContextCollapse(messages: Message[]): CompactResult {
  const originalText = messages.map((m) => m.content).join('\n')
  const originalTokens = estimateTokens(originalText)

  // Context Collapse：折叠旧 span 为占位符，保留最近 4 个 assistant round
  const assistantIndices: number[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant') assistantIndices.push(i)
  }
  assistantIndices.reverse()

  const MIN_KEPT_ROUNDS = 4
  if (assistantIndices.length <= MIN_KEPT_ROUNDS) {
    return {
      strategy: 'Context Collapse (ZY-Code)',
      description: '细粒度折叠：将旧消息 span 替换为轻量摘要占位符（不调用 LLM）',
      originalTokens,
      resultTokens: originalTokens,
      savedPercent: 0,
      output: '[消息数不足，无需折叠]',
      preservedMessages: messages.length,
      totalMessages: messages.length,
    }
  }

  const cutBefore = assistantIndices[assistantIndices.length - MIN_KEPT_ROUNDS]!
  const collapsedMessages = messages.slice(0, cutBefore)
  const preservedMessages = messages.slice(cutBefore)

  // 生成轻量摘要（模拟 generateLightSummary）
  const userMsgs = collapsedMessages.filter((m) => m.role === 'user')
  const lightSummary = userMsgs
    .slice(0, 3)
    .map((m) => m.content.slice(0, 100))
    .join(' | ')

  const collapsePlaceholder = `<collapsed id="0000000000000001">${lightSummary}</collapsed>`
  const resultText =
    `[Earlier context collapsed: ${lightSummary}]\n` +
    preservedMessages.map((m) => m.content).join('\n')
  const resultTokens = estimateTokens(resultText)

  return {
    strategy: 'Context Collapse (ZY-Code)',
    description: '细粒度折叠：将旧消息 span 替换为轻量摘要占位符（不调用 LLM）',
    originalTokens,
    resultTokens,
    savedPercent: Math.round(((originalTokens - resultTokens) / originalTokens) * 100),
    output: `${collapsePlaceholder}\n\n--- 折叠了 ${collapsedMessages.length} 条消息 → 1 行占位符 ---\n--- 保留 ${preservedMessages.length} 条近期消息原样 ---\n\n保留内容预览:\n${preservedMessages.map((m) => `[${m.role}]: ${m.content.slice(0, 80)}...`).join('\n')}`,
    preservedMessages: preservedMessages.length,
    totalMessages: messages.length,
  }
}

// ============================================================================
// 策略 3: Full Compact（全量 LLM 压缩 — 两者都有，prompt 相同）
// ============================================================================

function simulateFullCompact(messages: Message[], variant: 'zy-code' | 'claude'): CompactResult {
  const originalText = messages.map((m) => m.content).join('\n')
  const originalTokens = estimateTokens(originalText)

  // 模拟 LLM 生成的 9 章节结构化摘要
  const userMessages = messages.filter((m) => m.role === 'user')
  const assistantMessages = messages.filter((m) => m.role === 'assistant')

  // 模拟摘要输出（实际由 LLM 生成）
  const simulatedSummary = `Summary:
1. Primary Request and Intent:
   用户请求创建一个 formatDate 日期格式化工具函数，支持 ISO(YYYY-MM-DD)、datetime(YYYY-MM-DD HH:mm:ss) 和 relative(相对时间) 三种格式。随后请求创建对应的测试文件，并创建 DateDisplay React 组件（含 tooltip hover 功能）。

2. Key Technical Concepts:
   - TypeScript 函数设计（联合类型参数）
   - Bun 测试框架 (bun:test)
   - React 组件设计（useMemo, useEffect, useState）
   - 语义化 HTML (time 标签)
   - CSS tooltip 实现

3. Files and Code Sections:
   - src/utils/format.ts
     - 核心工具函数，包含 formatDate(date, format) 实现
     - 支持 'iso' | 'datetime' | 'relative' 三种格式
   - tests/utils/format.test.ts
     - 8 个测试用例，覆盖所有格式和边界情况
     - 全部通过
   - src/components/DateDisplay.tsx
     - React 组件，包裹 formatDate
     - 支持 autoRefresh、tooltip hover 显示完整时间

4. Errors and fixes:
   - 无错误发生

5. Problem Solving:
   - 按顺序完成：工具函数 → 测试 → React 组件 → tooltip 增强

6. All user messages:
   - "帮我在 src/utils/format.ts 中添加一个 formatDate 函数，支持 YYYY-MM-DD 和 relative 两种格式"
   - "还需要加上时间部分，支持 YYYY-MM-DD HH:mm:ss"
   - "好的，现在帮我写一个测试文件 tests/utils/format.test.ts"
   - "运行一下测试看看结果"
   - "很好。现在帮我在 src/components/DateDisplay.tsx 创建一个 React 组件"
   - "再加一个 tooltip，hover 时显示完整日期时间"

7. Pending Tasks:
   - 无

8. Current Work:
   刚完成 DateDisplay 组件的 tooltip 功能添加

9. Optional Next Step:
   无明确的下一步`

  const resultTokens = estimateTokens(simulatedSummary)

  const prefix = variant === 'zy-code' ? 'Full Compact (ZY-Code)' : 'Full Compact (Claude 原版)'

  const desc =
    variant === 'zy-code'
      ? '全量 LLM 压缩：9 章节结构化摘要（ZY-Code 会先尝试 Session Memory，再 fallback 到这里）'
      : '全量 LLM 压缩：9 章节结构化摘要（Claude 原版默认路径，无 Session Memory / Context Collapse 前置）'

  return {
    strategy: prefix,
    description: desc,
    originalTokens,
    resultTokens,
    savedPercent: Math.round(((originalTokens - resultTokens) / originalTokens) * 100),
    output: simulatedSummary,
    preservedMessages: 0,
    totalMessages: messages.length,
  }
}

// ============================================================================
// 策略 4: Reactive Compact（反应式压缩 — 两者都有，ZY-Code 保留近期消息）
// ============================================================================

function simulateReactiveCompact(
  messages: Message[],
  variant: 'zy-code' | 'claude',
): CompactResult {
  const originalText = messages.map((m) => m.content).join('\n')
  const originalTokens = estimateTokens(originalText)

  // Reactive 策略：分组后保留近期 N 个 group，只摘要旧的部分
  const groups: Message[][] = []
  let currentGroup: Message[] = []
  for (const msg of messages) {
    if (msg.role === 'assistant' && currentGroup.length > 0) {
      groups.push(currentGroup)
      currentGroup = [msg]
    } else {
      currentGroup.push(msg)
    }
  }
  if (currentGroup.length > 0) groups.push(currentGroup)

  // 保留最近 2 个 group（反应式压缩的典型行为）
  const preserveCount = Math.min(2, groups.length - 1)
  const preservedGroups = groups.slice(-preserveCount)
  const summarizedGroups = groups.slice(0, -preserveCount)

  const preservedMsgs = preservedGroups.flat()
  const summarizedMsgs = summarizedGroups.flat()

  // 模拟对旧消息的摘要
  const partialSummary = `Summary:
1. Primary Request and Intent:
   用户请求创建 formatDate 工具函数和对应测试。函数已完成，测试已通过。

2. Key Technical Concepts:
   - formatDate(date, format): 支持 'iso'|'datetime'|'relative'
   - bun:test 测试框架，8 个用例全部通过

3. Files and Code Sections:
   - src/utils/format.ts: formatDate 函数实现
   - tests/utils/format.test.ts: 完整测试覆盖

4-9. [略] 组件开发请求见后续保留的消息`

  const resultText = partialSummary + '\n\n' + preservedMsgs.map((m) => m.content).join('\n')
  const resultTokens = estimateTokens(resultText)

  const prefix =
    variant === 'zy-code' ? 'Reactive Compact (ZY-Code)' : 'Reactive Compact (Claude 原版)'

  const desc =
    variant === 'zy-code'
      ? '反应式压缩：仅摘要旧 group，保留近期消息原样（PTL 触发时启用）'
      : '反应式压缩：渐进分组 + 保留近期 group（Claude 的 Precomputed 可零等待）'

  return {
    strategy: prefix,
    description: desc,
    originalTokens,
    resultTokens,
    savedPercent: Math.round(((originalTokens - resultTokens) / originalTokens) * 100),
    output: `${partialSummary}\n\n--- 保留了最近 ${preservedMsgs.length} 条消息原样 ---\n${preservedMsgs.map((m) => `[${m.role}]: ${m.content.slice(0, 60)}...`).join('\n')}`,
    preservedMessages: preservedMsgs.length,
    totalMessages: messages.length,
  }
}

// ============================================================================
// 策略 5: Session Memory Compact（ZY-Code 独有）
// ============================================================================

function simulateSessionMemoryCompact(messages: Message[]): CompactResult {
  const originalText = messages.map((m) => m.content).join('\n')
  const originalTokens = estimateTokens(originalText)

  // 模拟已有的 session memory 文件内容（后台持续提取的结构化记忆）
  const sessionMemory = `# Session Memory

## Active Tasks
- formatDate utility function: COMPLETED
- Unit tests: COMPLETED (8/8 pass)
- DateDisplay React component: COMPLETED (with tooltip)

## Key Decisions
- Format types: 'iso' | 'datetime' | 'relative'
- Auto-refresh for relative format
- Tooltip shows full datetime on hover

## Files Modified
- src/utils/format.ts (formatDate function)
- tests/utils/format.test.ts (8 test cases)
- src/components/DateDisplay.tsx (React component with tooltip)`

  // Session Memory Compact 保留最近的消息
  const keepCount = Math.min(4, messages.length)
  const keptMessages = messages.slice(-keepCount)

  const resultText = sessionMemory + '\n\n' + keptMessages.map((m) => m.content).join('\n')
  const resultTokens = estimateTokens(resultText)

  return {
    strategy: 'Session Memory Compact (ZY-Code 独有)',
    description: '利用后台已提取的结构化记忆替代 LLM 摘要（零 LLM 调用、零额外 token 消耗）',
    originalTokens,
    resultTokens,
    savedPercent: Math.round(((originalTokens - resultTokens) / originalTokens) * 100),
    output: `${sessionMemory}\n\n--- 保留最近 ${keptMessages.length} 条消息 ---`,
    preservedMessages: keptMessages.length,
    totalMessages: messages.length,
  }
}

// ============================================================================
// 输出格式化
// ============================================================================

function printSeparator(char = '═', width = 80) {
  console.log(char.repeat(width))
}

function printResult(result: CompactResult) {
  console.log(`\n┌${'─'.repeat(78)}┐`)
  console.log(`│ 📦 ${result.strategy.padEnd(73)}│`)
  console.log(`├${'─'.repeat(78)}┤`)
  console.log(`│ ${result.description.slice(0, 77).padEnd(77)}│`)
  console.log(`├${'─'.repeat(78)}┤`)
  console.log(
    `│ 原始 token: ${String(result.originalTokens).padStart(7)} │ 压缩后: ${String(result.resultTokens).padStart(7)} │ 节省: ${String(result.savedPercent + '%').padStart(4)} │ 保留消息: ${result.preservedMessages}/${result.totalMessages}  │`,
  )
  console.log(`└${'─'.repeat(78)}┘`)
  console.log(`\n压缩结果预览:`)
  console.log('┄'.repeat(60))
  // 限制输出长度
  const lines = result.output.split('\n')
  const maxLines = 20
  if (lines.length > maxLines) {
    console.log(lines.slice(0, maxLines).join('\n'))
    console.log(`  ... (共 ${lines.length} 行，省略 ${lines.length - maxLines} 行)`)
  } else {
    console.log(result.output)
  }
  console.log('┄'.repeat(60))
}

// ============================================================================
// Prompt Cache 影响模拟
// ============================================================================

/**
 * 模拟不同压缩策略对 Prompt Cache 命中率的影响
 *
 * Prompt Cache 原理：
 * - Anthropic API 缓存请求的前缀部分
 * - 如果本次请求的前缀与上次相同，cache hit → 该部分 token 成本降低 90%
 * - 如果消息被修改/移除/插入 → 前缀变化 → cache miss → 全价
 *
 * 关键发现（from binary）：
 * - Claude 用 FW(fork) + skipCacheWrite:true 做压缩 → 读缓存不写缓存
 * - 压缩后新序列从 [system + summary] 开始 → 与原前缀完全不同 → cache miss
 * - 但 Precomputed 是后台预算 → 不影响正常对话的 cache hit
 */
function simulateCacheImpact(messages: Message[]) {
  const totalTokens = estimateTokens(messages.map((m) => m.content).join('\n'))
  // Anthropic pricing: input $3/MTok, cache_read $0.30/MTok, cache_creation $3.75/MTok
  const INPUT_PRICE = 3.0 // $/MTok
  const CACHE_READ_PRICE = 0.3 // $/MTok (90% discount)
  const CACHE_CREATION_PRICE = 3.75 // $/MTok
  const OUTPUT_PRICE = 15.0 // $/MTok

  // 假设 200K 模型，effectiveWindow 180K
  const EFFECTIVE_WINDOW = 180_000
  const PRECOMPUTE_THRESHOLD = Math.floor(EFFECTIVE_WINDOW * 0.8) // 144K
  const COMPACT_THRESHOLD = EFFECTIVE_WINDOW - 13_000 // 167K

  // 模拟一个 25 轮对话的缓存累积
  const TURNS = 25
  const AVG_TURN_TOKENS = 8000 // 每轮平均 8K token
  const SYSTEM_PROMPT_TOKENS = 5000

  console.log(`\n  模拟参数: 200K model, ${TURNS} 轮对话, 平均 ${AVG_TURN_TOKENS} tok/轮`)
  console.log(`  阈值: Precompute=${PRECOMPUTE_THRESHOLD}, Compact=${COMPACT_THRESHOLD}`)
  console.log(`  定价: input=$${INPUT_PRICE}/MTok, cache_read=$${CACHE_READ_PRICE}/MTok\n`)

  interface TurnCost {
    turn: number
    tokens: number
    cacheHitTokens: number
    cacheMissTokens: number
    cost: number
    event: string
  }

  function simulateSession(strategy: string): TurnCost[] {
    const costs: TurnCost[] = []
    let cumulativeTokens = SYSTEM_PROMPT_TOKENS
    let cachedPrefixTokens = 0
    let compacted = false
    let precomputeReady = false
    let precomputeStartedAt = -1

    for (let turn = 1; turn <= TURNS; turn++) {
      cumulativeTokens += AVG_TURN_TOKENS
      let event = ''
      let cacheHit = 0
      let cacheMiss = 0

      if (strategy === 'claude_precomputed') {
        // Claude: 在 80% 时后台启动预计算
        if (!compacted && precomputeStartedAt < 0 && cumulativeTokens >= PRECOMPUTE_THRESHOLD) {
          precomputeStartedAt = turn
          event = '🟡 precompute-start (bg)'
        }
        // 假设预计算需要 2 轮完成
        if (precomputeStartedAt > 0 && turn >= precomputeStartedAt + 2) {
          precomputeReady = true
        }
        // 到达 compact 阈值时
        if (!compacted && cumulativeTokens >= COMPACT_THRESHOLD) {
          if (precomputeReady) {
            event = '✅ precompute-swap (零等待)'
          } else {
            event = '⚠️ compact (cache-sharing)'
          }
          // 压缩后 token 降到约 30%
          cumulativeTokens = Math.floor(cumulativeTokens * 0.3)
          compacted = true
          // 压缩后缓存完全失效（新前缀）— 下一轮全价
          cachedPrefixTokens = 0
        }
        // cache 计算
        cacheHit = Math.min(cachedPrefixTokens, cumulativeTokens)
        cacheMiss = Math.max(0, cumulativeTokens - cachedPrefixTokens)
        cachedPrefixTokens = cumulativeTokens
      } else if (strategy === 'zy_context_collapse') {
        // ZY-Code Context Collapse: 85% 时折叠
        // 核心优势：只折叠尾部消息，保持前缀不变
        const COLLAPSE_THRESHOLD = Math.floor(EFFECTIVE_WINDOW * 0.85)
        if (!compacted && cumulativeTokens >= COLLAPSE_THRESHOLD) {
          event = '🟢 collapse (前缀不变)'
          // 折叠节省 40%，但只折叠尾部
          const reduced = Math.floor(cumulativeTokens * 0.6)
          // 缓存前缀 = 旧的缓存前缀（因为 head 不变）
          // 但不能超过新的总量
          cachedPrefixTokens = Math.min(cachedPrefixTokens, reduced)
          cumulativeTokens = reduced
          compacted = true
        }
        cacheHit = Math.min(cachedPrefixTokens, cumulativeTokens)
        cacheMiss = Math.max(0, cumulativeTokens - cachedPrefixTokens)
        cachedPrefixTokens = cumulativeTokens
      } else if (strategy === 'zy_full_compact') {
        // ZY-Code Full Compact: 93% 时全量压缩
        if (!compacted && cumulativeTokens >= EFFECTIVE_WINDOW * 0.93) {
          event = '🟠 full-compact'
          cumulativeTokens = Math.floor(cumulativeTokens * 0.25)
          compacted = true
          // 全量压缩后缓存完全失效
          cachedPrefixTokens = 0
        }
        cacheHit = Math.min(cachedPrefixTokens, cumulativeTokens)
        cacheMiss = Math.max(0, cumulativeTokens - cachedPrefixTokens)
        cachedPrefixTokens = cumulativeTokens
      } else {
        // baseline: 无压缩
        cacheHit = Math.min(cachedPrefixTokens, cumulativeTokens)
        cacheMiss = Math.max(0, cumulativeTokens - cachedPrefixTokens)
        cachedPrefixTokens = cumulativeTokens
      }

      if (!event && turn === 1) event = 'session-start'

      const cost = (cacheHit * CACHE_READ_PRICE + cacheMiss * INPUT_PRICE) / 1_000_000

      costs.push({
        turn,
        tokens: cumulativeTokens,
        cacheHitTokens: cacheHit,
        cacheMissTokens: cacheMiss,
        cost,
        event,
      })
    }
    return costs
  }

  const strategies = [
    { key: 'baseline', label: '无压缩 (Baseline)' },
    { key: 'claude_precomputed', label: 'Claude Precomputed' },
    { key: 'zy_context_collapse', label: 'ZY Context Collapse' },
    { key: 'zy_full_compact', label: 'ZY Full Compact' },
  ]

  console.log(
    `  ${'Turn'.padEnd(5)} ${'Tokens'.padStart(8)} ${'Cache Hit'.padStart(10)} ${'Miss'.padStart(8)} ${'Cost'.padStart(8)} ${'Event'.padStart(30)}`,
  )
  console.log(`  ${'─'.repeat(75)}`)

  for (const { key, label } of strategies) {
    const costs = simulateSession(key)
    const totalCost = costs.reduce((sum, c) => sum + c.cost, 0)
    const avgCacheHitRate =
      costs.reduce(
        (sum, c) => sum + c.cacheHitTokens / Math.max(1, c.cacheHitTokens + c.cacheMissTokens),
        0,
      ) / costs.length

    console.log(`\n  🎯 ${label}`)
    console.log(
      `     总费用: $${totalCost.toFixed(4)} | 平均缓存命中率: ${(avgCacheHitRate * 100).toFixed(1)}%`,
    )

    // 只打印有事件的 turn 和关键转折点
    for (const c of costs) {
      if (c.event || c.turn === 1 || c.turn === TURNS || c.turn % 5 === 0) {
        const hitRate = c.cacheHitTokens / Math.max(1, c.cacheHitTokens + c.cacheMissTokens)
        console.log(
          `     T${String(c.turn).padStart(2)} ${String(c.tokens).padStart(7)} tok  ` +
            `hit:${String(c.cacheHitTokens).padStart(6)}  miss:${String(c.cacheMissTokens).padStart(6)}  ` +
            `$${c.cost.toFixed(4)}  ${(hitRate * 100).toFixed(0).padStart(3)}%  ${c.event}`,
        )
      }
    }
  }

  // 汇总对比
  console.log(`\n  ────────────────────────────────`)
  console.log(`  💰 费用对比汇总 (${TURNS} 轮对话):`)
  for (const { key, label } of strategies) {
    const costs = simulateSession(key)
    const totalCost = costs.reduce((sum, c) => sum + c.cost, 0)
    const avgCacheHitRate =
      costs.reduce(
        (sum, c) => sum + c.cacheHitTokens / Math.max(1, c.cacheHitTokens + c.cacheMissTokens),
        0,
      ) / costs.length
    const baseline = simulateSession('baseline').reduce((sum, c) => sum + c.cost, 0)
    const savings = (((baseline - totalCost) / baseline) * 100).toFixed(1)
    console.log(
      `     ${label.padEnd(25)} $${totalCost.toFixed(4).padStart(8)}  ` +
        `缓存率:${(avgCacheHitRate * 100).toFixed(1).padStart(5)}%  ` +
        `比baseline省:${savings.padStart(5)}%`,
    )
  }

  console.log(`\n  💡 关键发现：`)
  console.log(`     • Context Collapse 保持前缀不变，缓存命中率最高`)
  console.log(`     • Precomputed 后台运行不影响正常对话缓存，但 swap 后缓存重建`)
  console.log(`     • Full Compact 压缩率最高但缓存完全失效，下一轮全价`)
  console.log(`     • Claude 的 cache-sharing 让压缩调用本身也能复用缓存（skipCacheWrite:true）`)
}

// ============================================================================
// 主函数
// ============================================================================

function main() {
  const args = process.argv.slice(2)
  let messages: Message[]

  if (args[0]) {
    try {
      const raw = readFileSync(args[0], 'utf-8')
      messages = JSON.parse(raw) as Message[]
      console.log(`📂 加载对话文件: ${args[0]} (${messages.length} 条消息)`)
    } catch (e) {
      console.error(`❌ 无法加载文件: ${args[0]}`)
      console.error(`   格式要求: JSON 数组，每项为 { role: "user"|"assistant", content: "..." }`)
      process.exit(1)
    }
  } else {
    messages = SAMPLE_CONVERSATION
    console.log(`📝 使用内置示例对话 (${messages.length} 条消息)`)
  }

  const totalText = messages.map((m) => m.content).join('\n')
  const totalTokens = estimateTokens(totalText)

  printSeparator()
  console.log(`\n  🔬 压缩策略对比演示`)
  console.log(`  ────────────────────────────────────────`)
  console.log(`  对话消息数: ${messages.length}`)
  console.log(`  估算 token 数: ~${totalTokens}`)
  console.log(`  对话轮次: ${messages.filter((m) => m.role === 'user').length} 轮用户输入\n`)
  printSeparator()

  // ─── ZY-Code 策略 ───
  console.log(`\n${'━'.repeat(80)}`)
  console.log(`  🟢 ZY-Code 压缩策略（5 层级联）`)
  console.log(`${'━'.repeat(80)}`)
  console.log(`  优先级: Session Memory → Context Collapse → Auto-compact → Reactive → Snip`)

  printResult(simulateSessionMemoryCompact(messages))
  printResult(simulateContextCollapse(messages))
  printResult(simulateSnipCompact(messages))
  printResult(simulateReactiveCompact(messages, 'zy-code'))
  printResult(simulateFullCompact(messages, 'zy-code'))

  // ─── Claude 原版策略 ───
  console.log(`\n${'━'.repeat(80)}`)
  console.log(`  🔵 Claude Code 原版压缩策略（3 层）`)
  console.log(`${'━'.repeat(80)}`)
  console.log(`  优先级: Precomputed → Reactive → Full Compact`)

  printResult(simulateReactiveCompact(messages, 'claude'))
  printResult(simulateFullCompact(messages, 'claude'))

  // ─── Prompt Cache 影响分析 ───
  console.log(`\n${'━'.repeat(80)}`)
  console.log(`  🔄 Prompt Cache 命中率影响模拟`)
  console.log(`${'━'.repeat(80)}`)
  simulateCacheImpact(messages)

  // ─── 对比总结 ───
  console.log(`\n${'━'.repeat(80)}`)
  console.log(`  📊 关键差异总结`)
  console.log(`${'━'.repeat(80)}`)

  const table = [
    ['维度', 'ZY-Code', 'Claude 原版'],
    ['─'.repeat(25), '─'.repeat(25), '─'.repeat(25)],
    ['无 LLM 压缩层数', '3 (SM + Collapse + Snip)', '0'],
    ['LLM 压缩层数', '2 (Full + Reactive)', '3 (Precomputed + Reactive + Full)'],
    ['零等待压缩', 'Session Memory（后台已有）', 'Precomputed（后台预计算）'],
    ['细粒度保留', 'Context Collapse（多 span）', '无（一次性全量）'],
    ['确定性兜底', 'Snip（80% 阈值裁剪）', '无（blocked 直接阻断）'],
    ['最小 LLM 开销', '大多数场景零 LLM', '每次压缩至少 1 次 LLM 调用'],
  ]

  for (const row of table) {
    console.log(`  ${row[0]!.padEnd(26)}${row[1]!.padEnd(28)}${row[2]}`)
  }

  console.log(`\n${'━'.repeat(80)}`)
  console.log(`  💡 建议 ZY-Code 可吸收的原版能力：`)
  console.log(`${'━'.repeat(80)}`)
  console.log(`  1. Precomputed Compact — 在用户阅读响应时后台预算压缩结果（零等待）`)
  console.log(`  2. 快速回填断路器 — 防止大文件导致 compact→refill→compact 死循环`)
  console.log(`  3. 跨 Agent 借用 — sub-agent 之间共享预计算结果`)
  console.log(`  4. Cache-Sharing 压缩 — 压缩调用复用对话缓存，成本降 80%+`)
  console.log('')
}

main()
