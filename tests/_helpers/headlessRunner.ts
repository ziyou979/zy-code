// Headless 冒烟测试 harness:spawn dev 模式 CLI 跑 stream-json,归一化易变字段比对 golden。
//
// 确定性来源:不走 VCR(dist DCE 消除了 VCR、dev 模式的 VCR fixture 格式与运行时不兼容),
// 每次打真实 API,靠归一化抹平 LLM 响应内容(text/thinking/token 计数等),只比对结构骨架
// (消息类型序列、字段集、工具列表、slash commands 等)——这些是拆分不应改变的。
//
// 录制/更新 golden(需真实 API 凭证):
//   ZY_SMOKE_SETTINGS=~/.zy/settings.json UPDATE_GOLDEN=1 bun test tests/cli/headlessSmoke.test.ts
//
// 回放(需凭证,打真实 API):
//   ZY_SMOKE_SETTINGS=~/.zy/settings.json bun test tests/cli/headlessSmoke.test.ts

import { join, resolve } from 'node:path'

/** 项目根目录;spawn 时显式设 cwd 以保证 node_modules 解析正确。 */
export const PROJECT_ROOT = resolve(import.meta.dir, '../..')

/** dev-preload 路径——dist 的 build-time DCE 消除了 VCR/NODE_ENV 路径,故改用 dev 模式。 */
const DEV_PRELOAD = join(PROJECT_ROOT, 'src/entrypoints/dev-preload.ts')
const DEV_ENTRY = join(PROJECT_ROOT, 'src/entrypoints/cli.tsx')

/** VCR fixtures 落点,随仓库提交。 */
export const FIXTURES_ROOT = join(PROJECT_ROOT, 'tests/cli')

export type HeadlessScenario = {
  /** golden 文件名 + test 名,需唯一、kebab-case。 */
  name: string
  /** 喂给 -p 的 prompt。 */
  prompt: string
  /** 追加 CLI 参数(如触发工具调用的场景)。 */
  extraArgs?: string[]
}

/** spawn dev 模式 CLI 跑一条 headless stream-json,返回原始 stdout。 */
export async function runHeadlessStreamJson(scenario: HeadlessScenario): Promise<string> {
  const settings = process.env.ZY_SMOKE_SETTINGS
  const proc = Bun.spawn(
    [
      'bun',
      '--preload',
      DEV_PRELOAD,
      DEV_ENTRY,
      '-p',
      scenario.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--bare',
      ...(settings ? ['--settings', settings] : []),
      ...(scenario.extraArgs ?? []),
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: 'production',
      },
      cwd: PROJECT_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  if (proc.exitCode !== 0) {
    throw new Error(
      `headless 进程非 0 退出(code=${proc.exitCode})\n--- stderr ---\n${stderr}\n--- stdout ---\n${stdout}`,
    )
  }
  return stdout
}

// ── 归一化:抹掉每次运行都会变、与行为无关的字段,使 golden 可稳定比对 ──

/** 按 key 直接抹平的易变字段(递归,任意嵌套深度)。 */
const VOLATILE_KEYS = new Set([
  'session_id',
  'uuid',
  'requestId',
  'request_id',
  'duration_ms',
  'duration_api_ms',
  'total_cost_usd',
  'cost_usd',
  'costUSD',
  'timestamp',
  // LLM 响应:每次调用内容/用量都不同
  'id',
  'thinking',
  'signature',
  'text',
  'result',
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'webSearchRequests',
  'ephemeral_1h_input_tokens',
  'ephemeral_5m_input_tokens',
  // 聚合用量
  'modelUsage',
  'iterations',
])

function normalizeString(s: string): string {
  const cwd = process.cwd()
  const home = process.env.HOME ?? ''
  let out = s.split(cwd).join('[CWD]')
  if (home) {
    out = out.split(home).join('[HOME]')
  }
  // ISO 时间戳
  out = out.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '[TIMESTAMP]')
  return out
}

function normalizeValue(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v.map(normalizeValue)
  }
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) {
      out[k] = VOLATILE_KEYS.has(k) ? `[${k}]` : normalizeValue(val)
    }
    return out
  }
  if (typeof v === 'string') {
    return normalizeString(v)
  }
  return v
}

/** 把 NDJSON stream-json 输出归一化为稳定文本(逐行 parse → 抹易变字段 → pretty)。 */
export function normalizeStreamJson(raw: string): string {
  const lines = raw.split('\n').filter((l) => l.trim().length > 0)
  const normalized = lines.map((line) => {
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      // 非 JSON 行(理论上不该有)原样保留,便于发现意外输出
      return line
    }
    return JSON.stringify(normalizeValue(obj), null, 2)
  })
  return `${normalized.join('\n---\n')}\n`
}
