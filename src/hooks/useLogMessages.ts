import type { UUID } from 'node:crypto'
import { useEffect, useRef } from 'react'
import { useAppState } from '../state/AppState.js'
import type { Message } from '../types/message.js'
import { isAgentSwarmsEnabled } from '../services/swarm/agentSwarmsEnabled.js'
import {
  cleanMessagesForLogging,
  isChainParticipant,
  recordTranscript,
} from '../services/sessionStorage.js'

/**
 * 将当前会话消息增量持久化到 transcript JSONL 文件。
 *
 * @param messages 当前对话的消息数组
 * @param ignore 为 true 时跳过本轮写入（如恢复会话首屏挂载，消息已在磁盘上），仅同步初始化游标
 */
export function useLogMessages(messages: Message[], ignore: boolean = false) {
  const teamContext = useAppState((s) => s.teamContext)

  // 正常对话期间 messages 为仅追加模式，通过记录上次处理到的长度与尾部锚点，
  // 仅向 recordTranscript 传递新增切片，避免每次流式更新都对数千条历史做 O(n) 扫描。
  const lastRecordedLengthRef = useRef(0)
  const lastParentUuidRef = useRef<UUID | undefined>(undefined)
  const lastTailUuidRef = useRef<UUID | undefined>(undefined)
  // 首条消息 UUID 变化代表发生了清空重置或首部替换，不能仅凭数组长度判断。
  const firstMessageUuidRef = useRef<UUID | undefined>(undefined)
  // 防止较慢的全量异步 .then() 回调覆盖后续增量渲染已同步更新的新锚点。
  const callSeqRef = useRef(0)

  useEffect(() => {
    if (ignore) {
      // 恢复会话的首屏消息已经存在于 JSONL，不能再次写入；但仍必须用恢复链的
      // 末端初始化增量游标。否则下一次消息更新会被误判为“首次渲染”，而
      // getSessionMessages 的进程内缓存可能仍对应切换前的临时 session，导致新消息
      // 以 parentUuid=null 写入。再次恢复时只能从这个新根回溯，历史显示和模型
      // context 都会静默缩减到最后一轮。
      const currentFirstUuid = messages[0]?.uuid as UUID | undefined
      const last = cleanMessagesForLogging(messages, messages).findLast(isChainParticipant)
      lastRecordedLengthRef.current = messages.length
      firstMessageUuidRef.current = currentFirstUuid
      lastParentUuidRef.current = last?.uuid as UUID | undefined
      lastTailUuidRef.current = messages[messages.length - 1]?.uuid as UUID | undefined
      return
    }

    const currentFirstUuid = messages[0]?.uuid as UUID | undefined
    const prevLength = lastRecordedLengthRef.current
    const currentTailUuid = messages[messages.length - 1]?.uuid as UUID | undefined

    const wasFirstRender = firstMessageUuidRef.current === undefined
    const sameHead =
      currentFirstUuid !== undefined &&
      !wasFirstRender &&
      currentFirstUuid === firstMessageUuidRef.current
    const prefixIntact =
      prevLength === 0 ||
      (messages[prevLength - 1]?.uuid as UUID | undefined) === lastTailUuidRef.current

    // 高频工具 progress（如 bash_progress）原地替换最后一条消息时，无需触发全量重扫
    if (
      sameHead &&
      !prefixIntact &&
      prevLength === messages.length &&
      messages[prevLength - 1]?.type === 'progress'
    ) {
      lastTailUuidRef.current = currentTailUuid
      return
    }

    const isIncremental = sameHead && prevLength <= messages.length && prefixIntact
    // 同首部收缩或尾部原地替换（如流式 fallback 在同批次产生 tombstone 与新消息、rewind、snip 等）：
    // 需走全量去重扫描以跳过已删除项并正确回连父链。
    const isSameHeadShrink = sameHead && (prevLength > messages.length || !prefixIntact)

    const startIndex = isIncremental ? prevLength : 0
    if (startIndex === messages.length) {
      return
    }

    // 首次渲染、压缩或尾部发生删改时传全量数组，由 recordTranscript 的去重循环处理交错消息。
    const slice = startIndex === 0 ? messages : messages.slice(startIndex)
    const parentHint = isIncremental ? lastParentUuidRef.current : undefined

    // 异步排队写入，不阻塞 UI 渲染。
    const seq = ++callSeqRef.current
    void recordTranscript(
      slice,
      isAgentSwarmsEnabled()
        ? {
            teamName: teamContext?.teamName,
            agentName: teamContext?.selfAgentName,
          }
        : {},
      parentHint,
      messages,
    ).then((lastRecordedUuid) => {
      // 全量扫描路径（如包含 messagesToKeep 交错的压缩）以 recordTranscript 实际落盘返回的
      // 末端 UUID 为准；若期间已有更新的渲染周期触发，则跳过过期回调。
      if (seq !== callSeqRef.current) {
        return
      }
      if (lastRecordedUuid && !isIncremental) {
        lastParentUuidRef.current = lastRecordedUuid
      }
    })

    // 纯增量追加、首次渲染及同首部收缩/替换时，可同步从 cleanMessagesForLogging 推导父锚点。
    if (isIncremental || wasFirstRender || isSameHeadShrink) {
      const last = cleanMessagesForLogging(slice, messages).findLast(isChainParticipant)
      if (last) {
        lastParentUuidRef.current = last.uuid as UUID
      }
    }

    lastRecordedLengthRef.current = messages.length
    firstMessageUuidRef.current = currentFirstUuid
    lastTailUuidRef.current = currentTailUuid
  }, [messages, ignore, teamContext?.teamName, teamContext?.selfAgentName])
}
