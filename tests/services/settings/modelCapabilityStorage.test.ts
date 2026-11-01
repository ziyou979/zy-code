import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import {
  getModelCapabilityStatePath,
  readModelCapabilityState,
} from '../../../src/services/settings/modelCapabilityStorage.js'

describe('modelCapabilityStorage', () => {
  let directory: string
  let previous: string | undefined
  const schema = z.object({ version: z.literal(1), entries: z.array(z.string()) })
  beforeEach(() => {
    previous = process.env.ZY_CONFIG_DIR
    directory = mkdtempSync(join(tmpdir(), 'zy-capability-migration-'))
    process.env.ZY_CONFIG_DIR = directory
  })
  afterEach(() => {
    if (previous === undefined) {
      delete process.env.ZY_CONFIG_DIR
    } else {
      process.env.ZY_CONFIG_DIR = previous
    }
    rmSync(directory, { recursive: true, force: true })
  })
  test('旧状态校验成功后迁入已有目录，再移除根目录文件，保留手写分片', () => {
    mkdirSync(join(directory, 'model-capabilities'))
    const manual = join(directory, 'model-capabilities', 'gemini.jsonc')
    writeFileSync(manual, '// 保留注释\n{"models": []}')
    for (const kind of ['discovery', 'qualification'] as const) {
      const filename =
        kind === 'discovery'
          ? 'discovered-model-capabilities.json'
          : 'auto-mode-qualifications.json'
      const legacy = join(directory, filename)
      const data = { version: 1 as const, entries: [kind] }
      writeFileSync(legacy, JSON.stringify(data))
      expect(readModelCapabilityState(kind, schema)).toEqual(data)
      expect(existsSync(legacy)).toBe(false)
      expect(JSON.parse(readFileSync(getModelCapabilityStatePath(kind), 'utf8'))).toEqual(data)
    }
    expect(readFileSync(manual, 'utf8')).toBe('// 保留注释\n{"models": []}')
  })
  test('迁移写入失败时保留完整旧数据', () => {
    const legacy = join(directory, 'discovered-model-capabilities.json')
    const contents = JSON.stringify({ version: 1, entries: ['preserved'] })
    writeFileSync(legacy, contents)
    writeFileSync(join(directory, 'model-capabilities'), 'cannot create a directory here')
    expect(() => readModelCapabilityState('discovery', schema)).toThrow()
    expect(readFileSync(legacy, 'utf8')).toBe(contents)
  })
  test('新文件损坏时不回退旧授权，也不覆盖任一文件', () => {
    mkdirSync(join(directory, 'model-capabilities'))
    const legacy = join(directory, 'auto-mode-qualifications.json')
    writeFileSync(legacy, JSON.stringify({ version: 1, entries: ['old grant'] }))
    writeFileSync(getModelCapabilityStatePath('qualification'), '{ broken')
    expect(() => readModelCapabilityState('qualification', schema)).toThrow()
    expect(readFileSync(getModelCapabilityStatePath('qualification'), 'utf8')).toBe('{ broken')
    expect(existsSync(legacy)).toBe(true)
  })
})
