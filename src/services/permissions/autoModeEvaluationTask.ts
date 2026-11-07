import { randomUUID } from 'node:crypto'
import { tSync } from '../../i18n/index.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../tools/tool.js'
import { createUserMessage } from '../messages/constructors.js'
import {
  AUTO_MODE_EVALUATION_CASES,
  AUTO_MODE_EVALUATION_REPEATS,
  evaluateAutoModeClassifier,
  scoreAutoModeEvaluation,
} from './autoModeEvaluation.js'
import {
  getAutoModeQualificationFingerprint,
  saveAutoModeQualification,
} from './autoModeQualification.js'
import { getClassifierModel } from './classifierTranscript.js'
import { classifyYoloAction } from './yoloClassifier.js'

export type AutoModeEvaluationTaskContext = Pick<
  ToolUseContext,
  'getAppState' | 'setAppState' | 'options' | 'addNotification'
>

/** 独立后台任务，不借用当前对话的中止信号，也不改变权限模式或历史。 */
export function startAutoModeEvaluationTask(
  context: AutoModeEvaluationTaskContext,
  model: string,
  fingerprint: string,
): { error: Error | null } {
  try {
    if (context.getAppState().autoModeEvaluation?.status === 'running') {
      throw new Error('An evaluation is already running')
    }
    if (
      getClassifierModel() !== model ||
      getAutoModeQualificationFingerprint(model) !== fingerprint
    ) {
      throw new Error('Classifier configuration changed')
    }
    const shell = context.options.tools.find((tool) => tool.name === 'Bash')
    if (!shell?.toAutoClassifierInput) {
      throw new Error('No shell classifier projection')
    }
    const controller = new AbortController()
    const id = randomUUID()
    const permissions = context.getAppState().toolPermissionContext
    context.setAppState((previous) => ({
      ...previous,
      autoModeEvaluation: {
        id,
        model,
        fingerprint,
        controller,
        status: 'running',
        completed: 0,
        total: AUTO_MODE_EVALUATION_CASES.length * AUTO_MODE_EVALUATION_REPEATS,
      },
    }))
    const update = (patch: Partial<NonNullable<AppState['autoModeEvaluation']>>) =>
      context.setAppState((previous) =>
        previous.autoModeEvaluation?.id === id
          ? { ...previous, autoModeEvaluation: { ...previous.autoModeEvaluation, ...patch } }
          : previous,
      )
    void (async () => {
      let status: 'passed' | 'failed' | 'cancelled' | 'error' = 'error'
      try {
        const observations = await evaluateAutoModeClassifier({
          model,
          signal: controller.signal,
          onProgress: (completed) => update({ completed }),
          classify: async (sample, signal) => {
            if (
              getClassifierModel() !== model ||
              getAutoModeQualificationFingerprint(model) !== fingerprint
            ) {
              controller.abort()
              throw new Error('Classifier configuration changed')
            }
            return classifyYoloAction(
              [createUserMessage({ content: [{ type: 'text', text: sample.prompt }] })],
              {
                role: 'assistant',
                content: [
                  { type: 'tool_call', name: shell.name, input: { command: sample.command } },
                ],
              },
              [shell],
              permissions,
              signal,
              { evaluation: true },
            )
          },
        })
        controller.signal.throwIfAborted()
        if (
          getClassifierModel() !== model ||
          saveAutoModeQualification(model, fingerprint, observations).error
        ) {
          throw new Error('Could not save qualification')
        }
        status = scoreAutoModeEvaluation(observations).passed ? 'passed' : 'failed'
      } catch {
        status = controller.signal.aborted ? 'cancelled' : 'error'
      }
      update({ status })
      // 不切换模式、不追加模型消息；用户可继续原任务，稍后自行选择进入 Auto mode。
      context.addNotification?.({
        key: `auto-mode-evaluation-${id}`,
        text: tSync(`autoModeEvaluation.background.${status}`, { model }),
        priority: 'immediate',
        timeoutMs: 10_000,
      })
    })()
    return { error: null }
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }
}

/** 用户显式取消只中止评测，不影响当前任务。 */
export function cancelAutoModeEvaluationTask(context: Pick<ToolUseContext, 'getAppState'>): void {
  context.getAppState().autoModeEvaluation?.controller.abort()
}
