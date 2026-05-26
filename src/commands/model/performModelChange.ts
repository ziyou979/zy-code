import { MODEL_ALIASES } from '../../services/model/aliases.js'
import {
  getDefaultMainLoopModelSetting,
  getMainLoopModel,
  renderDefaultModelSetting,
} from '../../services/model/model.js'
import { isModelAllowed } from '../../services/model/modelAllowlist.js'
import { validateModel } from '../../services/model/validateModel.js'

/**
 * /model 命令的纯逻辑层，被 local-jsx 与 local 两个入口共享。
 *
 * 仅负责"args → 决策 + 文案"，副作用（setAppState / 渲染 ModelPicker）由调用方处理。
 *
 * 决策语义：
 * - `apply`: 应用此模型（model=null 表示恢复默认），并把 message 反馈给用户
 * - `reject`: 不应用，把 message 作为错误原因反馈给用户
 * - `picker`: 没有可执行参数，需要弹 picker（仅 jsx 入口能处理；local 入口降级为提示）
 * - `info`:   仅显示当前状态，无副作用
 */
export type ModelDecision =
  | { kind: 'apply'; model: string | null; message: string }
  | { kind: 'reject'; message: string }
  | { kind: 'picker' }
  | { kind: 'info'; message: string }

const COMMON_HELP_ARGS = ['help', '-h', '--help']
const COMMON_INFO_ARGS = ['list', 'show', 'display', 'current', 'status']

/** 与 model.tsx 中同名 helper 对齐：判断输入是否为预定义别名 */
function isKnownAlias(model: string): boolean {
  return (MODEL_ALIASES as readonly string[]).includes(model.toLowerCase().trim())
}

/** 渲染模型显示名（含 default 标注），与 jsx 端一致 */
export function renderModelLabel(model: string | null): string {
  const rendered = renderDefaultModelSetting(model ?? getDefaultMainLoopModelSetting())
  return model === null ? `${rendered} (default)` : rendered
}

/** 显示当前模型 + effort（mainLoopModelForSession 优先）
 *  effortValue 类型为 unknown ： EffortValue 是 'low'|'medium'|... 或 number 的
 *  union，这里只需要拼出可读文本，用 String() 转换避免类型耦合。
 */
export function describeCurrentModel(
  mainLoopModel: string | null | undefined,
  mainLoopModelForSession: string | null | undefined,
  effortValue: unknown,
): string {
  const displayModel = renderModelLabel(mainLoopModel ?? null)
  const effortInfo = effortValue !== undefined ? ` (effort: ${String(effortValue)})` : ''
  if (mainLoopModelForSession) {
    return `Current model: ${renderModelLabel(mainLoopModelForSession)} (session override from plan mode)\nBase model: ${displayModel}${effortInfo}`
  }
  return `Current model: ${displayModel}${effortInfo}`
}

/**
 * 解析 args 决定下一步动作。仅做读校验（isModelAllowed / validateModel），不写状态。
 */
export async function resolveModelChange(rawArgs: string): Promise<ModelDecision> {
  const args = (rawArgs ?? '').trim()

  if (COMMON_HELP_ARGS.includes(args)) {
    return {
      kind: 'info',
      message:
        'Run /model to open the model selection menu, or /model [modelName] to set the model.',
    }
  }

  if (COMMON_INFO_ARGS.includes(args)) {
    // 调用方负责拼出含 mainLoopModelForSession / effortValue 的完整文案；
    // 这里仅给一个不依赖 appState 的最小回退（极少触发）
    return {
      kind: 'info',
      message: `Current model: ${renderModelLabel(getMainLoopModel() ?? null)}`,
    }
  }

  if (!args) {
    return { kind: 'picker' }
  }

  // 'default' 关键字表示恢复 settings 默认（model = null）
  const model = args === 'default' ? null : args

  if (model && !isModelAllowed(model)) {
    return {
      kind: 'reject',
      message: `Model '${model}' is not available. Your organization restricts model selection.`,
    }
  }

  // null 或别名跳过 validateModel —— 与 jsx 端 SetModelAndClose 行为对齐
  if (!model || isKnownAlias(model)) {
    return {
      kind: 'apply',
      model,
      message: `Set model to ${renderModelLabel(model)}`,
    }
  }

  // 自定义模型走在线校验
  try {
    const { valid, error } = await validateModel(model)
    if (valid) {
      return {
        kind: 'apply',
        model,
        message: `Set model to ${renderModelLabel(model)}`,
      }
    }
    return { kind: 'reject', message: error || `Model '${model}' not found` }
  } catch (err) {
    return {
      kind: 'reject',
      message: `Failed to validate model: ${(err as Error).message}`,
    }
  }
}
