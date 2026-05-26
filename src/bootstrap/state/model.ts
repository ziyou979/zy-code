// 模型选择相关：mainLoopModel 覆盖 + initialMainLoopModel + sdkBetas + modelStrings。

import type { ModelSetting } from 'src/services/model/model.js'
import type { ModelStrings } from 'src/services/model/modelStrings.js'
import { STATE } from './_core.js'

/**
 * 获取通过 --model CLI 标志设置的模型覆盖，或用户在
 * 更新其配置的模型后设置。
 */
export function getMainLoopModelOverride(): ModelSetting | undefined {
  return STATE.mainLoopModelOverride
}

export function getInitialMainLoopModel(): ModelSetting {
  return STATE.initialMainLoopModel
}

export function setMainLoopModelOverride(model: ModelSetting | undefined): void {
  STATE.mainLoopModelOverride = model
}

export function setInitialMainLoopModel(model: ModelSetting): void {
  STATE.initialMainLoopModel = model
}

export function getSdkBetas(): string[] | undefined {
  return STATE.sdkBetas
}

export function setSdkBetas(betas: string[] | undefined): void {
  STATE.sdkBetas = betas
}

// 你不应该直接使用。参见 src/services/model/modelStrings.ts::getModelStrings()
export function getModelStrings(): ModelStrings | null {
  return STATE.modelStrings
}

// 你不应该直接使用。参见 src/utils/model/modelStrings.ts
export function setModelStrings(modelStrings: ModelStrings): void {
  STATE.modelStrings = modelStrings
}

// 测试工具函数，重置 model strings 以便重新初始化。
// 与 setModelStrings 分开，因为我们只想在测试中接受 'null'。
export function resetModelStringsForTestingOnly() {
  STATE.modelStrings = null
}
