// Headless stream-json 行为级 golden 冒烟测试。
//
// 这是 runHeadlessStreaming 拆分(Phase 2-4)的行为安全网:api-snapshot 只管导出面,
// 抓不到内部行为回归;此测试 spawn 构建版 CLI、VCR 回放 LLM、比对归一化后的 stream-json。
//
// 更新 golden(需真实 API 凭证):
//   ZY_SMOKE_SETTINGS=~/.zy/settings.json UPDATE_GOLDEN=1 bun test tests/cli/headlessSmoke.test.ts
//
// 回放(需凭证,打真实 API):
//   ZY_SMOKE_SETTINGS=~/.zy/settings.json bun test tests/cli/headlessSmoke.test.ts
//
// 无 golden 时优雅跳过。

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type HeadlessScenario,
  normalizeStreamJson,
  runHeadlessStreamJson,
} from '../_helpers/headlessRunner.js'

const UPDATE = process.env.UPDATE_GOLDEN === '1'
const GOLDEN_DIR = join(import.meta.dir, 'golden')

// 起步场景集;后续可加工具调用(Read/Bash)、控制消息往返等。
const SCENARIOS: HeadlessScenario[] = [{ name: 'plain-text', prompt: 'Reply with exactly: hello' }]

describe('headless stream-json golden', () => {
  for (const scenario of SCENARIOS) {
    test(scenario.name, async () => {
      // 需真实 API 凭证(经 ZY_SMOKE_SETTINGS 注入);CI / 无凭证环境优雅跳过。
      if (!process.env.ZY_SMOKE_SETTINGS) {
        console.warn(
          `[headless-smoke] 跳过 "${scenario.name}":未设 ZY_SMOKE_SETTINGS(指向含 api key 的 settings)。`,
        )
        return
      }
      const goldenPath = join(GOLDEN_DIR, `${scenario.name}.golden.txt`)
      if (!existsSync(goldenPath) && !UPDATE) {
        console.warn(
          `[headless-smoke] 跳过 "${scenario.name}":缺 golden,先录制:` +
            `ZY_SMOKE_SETTINGS=... UPDATE_GOLDEN=1 bun test tests/cli/headlessSmoke.test.ts`,
        )
        return
      }

      const actual = normalizeStreamJson(await runHeadlessStreamJson(scenario))

      if (UPDATE) {
        mkdirSync(dirname(goldenPath), { recursive: true })
        writeFileSync(goldenPath, actual, 'utf8')
        return
      }
      expect(actual).toBe(readFileSync(goldenPath, 'utf8'))
    }, 60_000)
  }
})
