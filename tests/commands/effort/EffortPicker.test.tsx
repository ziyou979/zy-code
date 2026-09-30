import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(import.meta.dir, '../../..')
const model = 'stealth/space-bunny-alpha'

const capability = {
  models: [
    {
      pattern: model,
      capabilities: {
        input: ['text'],
        thinking: {
          effort: {
            levels: ['quick', 'light', 'balanced', 'thorough', 'extreme'],
            map: {
              on: 'max',
              quick: 'low',
              light: 'medium',
              balanced: 'high',
              thorough: 'xhigh',
              extreme: 'max',
            },
          },
        },
      },
      tokens: { contextWindow: 1000000, maxOutputTokens: 524288 },
    },
  ],
}

// 子进程将所有设置读取和写入限制在临时目录，避免影响用户配置或同进程的其他测试。
const childScript = `
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import Ink from './src/ink/ink.js'
import { AppStateProvider } from './src/state/AppState.js'
import { getDefaultAppState } from './src/state/AppStateStore.js'
import { EffortPicker } from './src/commands/effort/EffortPicker.js'
import { computePickerLayout } from './src/commands/effort/effortPickerData.js'

const model = 'stealth/space-bunny-alpha'
const levels = computePickerLayout(model)?.levels.map((level) => level.value)
if (JSON.stringify(levels) !== JSON.stringify(['quick', 'light', 'balanced', 'thorough', 'extreme', 'orchestrate'])) {
  throw new Error('临时模型能力未加载：' + JSON.stringify(levels))
}

function makeKey(name) {
  return {
    kind: 'key',
    name,
    fn: false,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: name === 'return' ? '\\r' : name === 'escape' ? '\\x1b' : '\\x1b[D',
    raw: undefined,
    isPasted: false,
  }
}

async function run(keys) {
  const stdout = new Writable({ write(_chunk, _encoding, callback) { callback() } })
  stdout.columns = 100
  stdout.rows = 25
  stdout.isTTY = true
  const messages = []
  const messageCounts = []
  const state = { ...getDefaultAppState(), mainLoopModel: model, effortValue: 'extreme' }
  const ink = new Ink({ stdout, stderr: stdout, stdin: process.stdin, exitOnCtrlC: false, patchConsole: false })
  try {
    ink.render(React.createElement(AppStateProvider, { initialState: state },
      React.createElement(EffortPicker, { onDone: (message) => messages.push(message) })))
    for (const name of keys) {
      ink.dispatchKeyboardEvent(makeKey(name))
      await Bun.sleep(20)
      messageCounts.push(messages.length)
    }
    return { messages, messageCounts }
  } finally {
    ink.unmount()
  }
}

const confirm = await run(['return', 'return'])
const confirmSetting = JSON.parse(readFileSync(join(process.env.ZY_CONFIG_DIR, 'settings.json'), 'utf8')).effortLevel
const cancelAndNavigate = await run(['return', 'escape', 'left', 'return'])
console.log('EFFORT_RESULT:' + JSON.stringify({ confirm, confirmSetting, cancelAndNavigate }))
`

describe('EffortPicker', () => {
  test('高档确认框支持 Enter 确认、Esc 返回后继续导航', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'zy-effort-picker-'))
    try {
      mkdirSync(join(configDir, 'model-capabilities'))
      writeFileSync(
        join(configDir, 'model-capabilities', 'stealth.jsonc'),
        JSON.stringify(capability),
      )
      writeFileSync(join(configDir, 'settings.json'), '{}')

      const result = spawnSync(process.execPath, ['-e', childScript], {
        cwd: repoRoot,
        env: { ...process.env, ZY_CONFIG_DIR: configDir },
        encoding: 'utf8',
        timeout: 30000,
      })
      expect(result.error).toBeUndefined()
      if (result.status !== 0) {
        throw new Error(
          `子进程退出码 ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
        )
      }
      const resultLine = result.stdout.match(/EFFORT_RESULT:(\{[^\r\n]*\})/)?.[1]
      if (!resultLine) {
        throw new Error(`未找到子进程结果\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
      }
      const output = JSON.parse(resultLine) as {
        confirm: { messages: string[]; messageCounts: number[] }
        confirmSetting: string
        cancelAndNavigate: { messages: string[]; messageCounts: number[] }
      }
      expect(output.confirm.messageCounts).toEqual([0, 1])
      expect(output.confirm.messages).toHaveLength(1)
      expect(output.confirmSetting).toBe('extreme')
      expect(output.cancelAndNavigate.messageCounts).toEqual([0, 0, 0, 1])
      expect(output.cancelAndNavigate.messages).toHaveLength(1)
      const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as {
        effortLevel?: string
      }
      expect(settings.effortLevel).toBe('thorough')
    } finally {
      // 防止意外变量值导致递归删除超出本次创建的系统临时目录。
      const insideTemp = relative(tmpdir(), configDir)
      if (insideTemp.startsWith('zy-effort-picker-') && !insideTemp.includes('..')) {
        rmSync(configDir, { recursive: true, force: true })
      }
    }
  }, 45000)
})
