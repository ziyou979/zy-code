import type { UUID } from 'node:crypto'
import { getSessionId } from 'src/bootstrap/runtime/runtimeContext.js'
import { getWireBaseUrlOverride, getWireTokenOverride } from '../../bridge/bridgeConfig.js'
import { tSync } from '../../i18n/index.js'
import type { ToolUseContext } from '../../tools/tool.js'
import type { LocalJSXCommandContext } from '../types.js'
import { getMessagesAfterCompactBoundary } from '../../services/messages/./predicates.js'
import { getTranscriptPath, saveAgentName, saveCustomTitle } from '../../services/sessionStorage.js'
import { isTeammate } from '../../utils/teammate.js'
import { generateSessionName } from './generateSessionName.js'

/**
 * /rename 的核心实现，被 local-jsx 与 local 两个变体共享。
 *
 * 返回值语义：
 * - `message`: 给用户看的成功/失败提示文本
 * - `newName`: 实际写入的会话名（teammate 拒绝或生成失败时为 null）
 * - `isGenerated`: 是 LLM 生成的还是用户显式输入的
 *   仅当用户显式命名（非生成）时，调用方才应注入 SystemReminder 告诉模型
 *   "用户主动用 X 给会话命名"，让模型能据此调整表述；LLM 生成的标题不需要这层提示。
 */
export async function performRename(
  args: string,
  context: ToolUseContext & LocalJSXCommandContext,
): Promise<{ message: string; newName: string | null; isGenerated: boolean }> {
  // 协作蜂群里成员的名字由 leader 设置，禁止自改
  if (isTeammate()) {
    return {
      message:
        'Cannot rename: This session is a swarm teammate. Teammate names are set by the team leader.',
      newName: null,
      isGenerated: false,
    }
  }

  let newName: string
  let isGenerated: boolean
  if (!args || args.trim() === '') {
    const generated = await generateSessionName(
      getMessagesAfterCompactBoundary(context.messages),
      context.abortController.signal,
    )
    if (!generated) {
      return {
        message: 'Could not generate a name: no conversation context yet. Usage: /rename <name>',
        newName: null,
        isGenerated: false,
      }
    }
    newName = generated
    isGenerated = true
  } else {
    newName = args.trim()
    isGenerated = false
  }

  const sessionId = getSessionId() as UUID
  const fullPath = getTranscriptPath()

  // 始终写 custom title（用户显式命名优先于任何 ai-title）
  await saveCustomTitle(sessionId, newName, fullPath)

  // 同步到 zy.ai/code 远端 bridge 会话（best-effort，不阻塞）
  const appState = context.getAppState()
  const bridgeSessionId = appState.replWireSessionId
  if (bridgeSessionId) {
    const tokenOverride = getWireTokenOverride()
    void import('../../bridge/createSession.js').then(({ updateWireSessionTitle }) =>
      updateWireSessionTitle(bridgeSessionId, newName, {
        baseUrl: getWireBaseUrlOverride(),
        getAccessToken: tokenOverride ? () => tokenOverride : undefined,
      }).catch(() => {}),
    )
  }

  // 同步落 agent name（prompt-bar 显示用）
  await saveAgentName(sessionId, newName, fullPath)
  context.setAppState((prev) => ({
    ...prev,
    standaloneAgentContext: {
      ...prev.standaloneAgentContext,
      name: newName,
    },
  }))

  return {
    message: tSync('commands.rename.success', { newName }),
    newName,
    isGenerated,
  }
}

/**
 * 构造给 model 的 SystemReminder：用户显式 rename 会话时，
 * 把命名意图转交给模型，方便后续回复贴合用户视角。
 *
 * LLM 生成的名字不应注入，
 * 否则等于让模型读到自己刚生成的内容，无新增信息且浪费 token。
 */
export function buildRenameSystemReminder(newName: string): string {
  return `<system-reminder>The user has renamed this session to "${newName}". Use this framing to understand how the user thinks about the current conversation. Do not acknowledge this rename in your response unless the user asks about it.</system-reminder>`
}
