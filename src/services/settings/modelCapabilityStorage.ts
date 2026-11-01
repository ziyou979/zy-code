import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { z } from 'zod/v4'
import { getErrnoCode } from '../../utils/errors.js'
import { getZyConfigHomeDir } from '../infra/envUtils.js'

export const MODEL_CAPABILITY_STATE_FILES = {
  discovery: 'discovered-model-capabilities.json',
  qualification: 'auto-mode-qualifications.json',
} as const
type StateKind = keyof typeof MODEL_CAPABILITY_STATE_FILES

/** 状态与手写能力分片共用目录；保留名称区分 schema，不能作为手写 models 解析。 */
export function getModelCapabilityStatePath(kind: StateKind): string {
  return join(getZyConfigHomeDir(), 'model-capabilities', MODEL_CAPABILITY_STATE_FILES[kind])
}

export function writeModelCapabilityState(kind: StateKind, value: unknown): void {
  const path = getModelCapabilityStatePath(kind)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, path)
  } finally {
    try {
      unlinkSync(temporary)
    } catch {
      /* 重命名成功后临时文件已不存在；不覆盖原始写入异常。 */
    }
  }
}

/** 旧路径仅作为一次性迁移来源；先校验并原子落盘成功，再移除旧文件。 */
export function readModelCapabilityState<T>(kind: StateKind, schema: z.ZodType<T>): T | undefined {
  const path = getModelCapabilityStatePath(kind)
  try {
    return schema.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    // 新文件损坏时必须明确失败，不能回退旧数据复活已撤销的授权。
    if (getErrnoCode(error) !== 'ENOENT') {
      throw error
    }
  }
  const legacy = join(getZyConfigHomeDir(), MODEL_CAPABILITY_STATE_FILES[kind])
  let contents: string
  try {
    contents = readFileSync(legacy, 'utf8')
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') {
      return undefined
    }
    throw error
  }
  const value = schema.parse(JSON.parse(contents))
  writeModelCapabilityState(kind, value)
  unlinkSync(legacy)
  return value
}
