import type { LocalCommandCall } from '../../types/command.js'
import { resolveEffortForModelSetting } from '../../utils/effort.js'
import { shouldEnableThinkingByDefault } from '../../utils/thinking.js'
import { describeCurrentModel, resolveModelChange } from './performModelChange.js'

/**
 * /model 的非交互（local）入口：用于 `zy -p "/model <name>"`、stream-json 长连接 SDK
 * 中途切模型、CI 脚本等场景。
 *
 * 与 local-jsx 变体的差异：
 * - 不能弹 ModelPicker；空参数降级为"显示当前模型 + 用法提示"
 * - 不渲染 React，直接 setAppState 后通过 stdout 返回结果文本
 */
export const call: LocalCommandCall = async (args, context) => {
  const decision = await resolveModelChange(args)

  switch (decision.kind) {
    case 'info':
      return { type: 'text', value: decision.message }

    case 'reject':
      return { type: 'text', value: decision.message }

    case 'picker': {
      // 非交互模式无法弹 picker，直接打印当前状态 + 用法提示
      const state = context.getAppState()
      const current = describeCurrentModel(
        state.mainLoopModel,
        state.mainLoopModelForSession,
        state.effortValue,
      )
      return {
        type: 'text',
        value: `${current}\nUsage: /model <name|default>`,
      }
    }

    case 'apply': {
      // 应用模型变更（与 jsx 端 SetModelAndClose useEffect 内的 setModel 完全一致）
      context.setAppState((prev) => ({
        ...prev,
        mainLoopModel: decision.model,
        mainLoopModelForSession: null,
        // 切模型时保留用户意图，但必须落到新模型支持的档位内。
        effortValue: resolveEffortForModelSetting(decision.model, prev.effortValue),
        // 按新模型能力重置 thinking 开关，避免过期 false 值被保留
        thinkingEnabled: shouldEnableThinkingByDefault(decision.model ?? undefined),
      }))
      return { type: 'text', value: decision.message }
    }
  }
}
