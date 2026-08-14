import { useMemo, useRef } from 'react'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import type { Message } from '../types/message.js'
import { isInternalBuild } from '../services/infra/envUtils.js'
import { getUserMessageText } from '../services/messages/./predicates.js'

const EXTERNAL_COMMAND_PATTERNS = [
  /\bcurl\b/,
  /\bwget\b/,
  /\bssh\b/,
  /\bkubectl\b/,
  /\bsrun\b/,
  /\bdocker\b/,
  /\bbq\b/,
  /\bgsutil\b/,
  /\bgcloud\b/,
  /\baws\b/,
  /\bgit\s+push\b/,
  /\bgit\s+pull\b/,
  /\bgit\s+fetch\b/,
  /\bgh\s+(pr|issue)\b/,
  /\bnc\b/,
  /\bncat\b/,
  /\btelnet\b/,
  /\bftp\b/,
]

const FRICTION_PATTERNS = [
  // 以 "No," 或 "No!" 开头：逗号或感叹号表示纠正语气，
  // 避免误判 "No problem"、"No thanks"、"No I think we should..."
  /^no[,!]\s/i,
  // 直接纠正 Zy 的输出
  /\bthat'?s (wrong|incorrect|not (what|right|correct))\b/i,
  /\bnot what I (asked|wanted|meant|said)\b/i,
  // 提及 Zy 遗漏的先前指令
  /\bI (said|asked|wanted|told you|already said)\b/i,
  // 质疑 Zy 的操作
  /\bwhy did you\b/i,
  /\byou should(n'?t| not)? have\b/i,
  /\byou were supposed to\b/i,
  // 明确要求重试或撤销 Zy 的工作
  /\btry again\b/i,
  /\b(undo|revert) (that|this|it|what you)\b/i,
]

export function isSessionContainerCompatible(messages: Message[]): boolean {
  for (const msg of messages) {
    if (msg.type !== 'assistant') {
      continue
    }
    const content = msg.message.content
    if (!Array.isArray(content)) {
      continue
    }
    for (const block of content) {
      if (block.type !== 'tool_call' || !('name' in block)) {
        continue
      }
      const toolName = block.name as string
      if (toolName.startsWith('mcp__')) {
        return false
      }
      if (toolName === BASH_TOOL_NAME) {
        const input = (block as { input?: Record<string, unknown> }).input
        const command = (input?.command as string) || ''
        if (EXTERNAL_COMMAND_PATTERNS.some((p) => p.test(command))) {
          return false
        }
      }
    }
  }
  return true
}

export function hasFrictionSignal(messages: Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.type !== 'user') {
      continue
    }
    const text = getUserMessageText(msg)
    if (!text) {
      continue
    }
    return FRICTION_PATTERNS.some((p) => p.test(text))
  }
  return false
}

const MIN_SUBMIT_COUNT = 3
const COOLDOWN_MS = 30 * 60 * 1000

export function useIssueFlagBanner(messages: Message[], submitCount: number): boolean {
  if (!isInternalBuild()) {
    return false
  }

  // biome-ignore lint/correctness/useHookAtTopLevel: process.env.USER_TYPE is a compile-time constant
  const lastTriggeredAtRef = useRef(0)
  // biome-ignore lint/correctness/useHookAtTopLevel: process.env.USER_TYPE is a compile-time constant
  const activeForSubmitRef = useRef(-1)

  // 缓存 O(messages) 扫描。此 hook 会在每次 REPL 渲染时运行，包括每次按键，
  // 但输入期间 messages 保持稳定。isSessionContainerCompatible 会遍历所有消息，
  // 并对每条 bash 命令运行 regex，是此处最重的工作。
  // biome-ignore lint/correctness/useHookAtTopLevel: process.env.USER_TYPE is a compile-time constant
  const shouldTrigger = useMemo(
    () => isSessionContainerCompatible(messages) && hasFrictionSignal(messages),
    [messages],
  )

  // 持续显示 banner，直到用户提交下一条消息
  if (activeForSubmitRef.current === submitCount) {
    return true
  }

  if (Date.now() - lastTriggeredAtRef.current < COOLDOWN_MS) {
    return false
  }
  if (submitCount < MIN_SUBMIT_COUNT) {
    return false
  }
  if (!shouldTrigger) {
    return false
  }

  lastTriggeredAtRef.current = Date.now()
  activeForSubmitRef.current = submitCount
  return true
}
