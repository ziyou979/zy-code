import { describe, expect, test } from 'bun:test'
import { Writable } from 'node:stream'
import type { Frame } from '../../../src/ink/frame.js'
import Ink from '../../../src/ink/ink.js'
import { charInCellAt } from '../../../src/ink/screen.js'
import { AppStateProvider } from '../../../src/state/AppState.js'
import { Select } from '../../../src/components/CustomSelect/select.js'

function makeStdout(columns: number, rows: number): NodeJS.WriteStream {
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  }) as unknown as NodeJS.WriteStream
  stream.columns = columns
  stream.rows = rows
  stream.isTTY = true
  return stream
}

function frameToLines(frame: Frame): string[] {
  const lines: string[] = []
  for (let y = 0; y < frame.screen.height; y++) {
    let line = ''
    for (let x = 0; x < frame.screen.width; x++) {
      line += charInCellAt(frame.screen, x, y)
    }
    lines.push(line.trimEnd())
  }
  return lines
}

describe('Select 布局', () => {
  test('带标签的输入选项换行后应与选项正文左对齐', () => {
    const stdout = makeStdout(48, 12)
    const ink = new Ink({
      stdout,
      stderr: stdout,
      stdin: process.stdin,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    const frames: Frame[] = []
    ink.frameSink = (frame) => {
      frames.push(frame)
      return true
    }

    ink.render(
      <AppStateProvider>
        <Select
          isDisabled
          options={[
            { label: '是', value: 'yes' },
            {
              type: 'input',
              label: '是，并且不再询问',
              value: 'always',
              initialValue:
                'Get-ChildItem C:\\very\\long\\path | Select-String Name Version Location',
              onChange: () => {},
              showLabelWithValue: true,
              labelValueSeparator: ': ',
            },
            { label: '否', value: 'no' },
          ]}
        />
      </AppStateProvider>,
    )

    const lines = frameToLines(frames.at(-1)!)
    const optionStart = lines.findIndex((line) => line.includes('2.'))
    const nextOption = lines.findIndex((line) => line.includes('3.'))
    const optionLines = lines.slice(optionStart, nextOption)
    const contentColumn = optionLines[0]!.indexOf('是，并且不再询问')
    if (contentColumn < 0) {
      throw new Error(`未在选项首行找到标签：${JSON.stringify(optionLines)}`)
    }

    expect(optionLines.length).toBeGreaterThan(1)
    for (const continuation of optionLines.slice(1)) {
      expect(continuation.search(/\S/)).toBe(contentColumn)
    }

    ink.unmount()
  })

  test('双列模式下描述起始对齐列在滚动与翻页中保持全局稳定', () => {
    const stdout = makeStdout(100, 20)
    const ink = new Ink({
      stdout,
      stderr: stdout,
      stdin: process.stdin,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    const frames: Frame[] = []
    ink.frameSink = (frame) => {
      frames.push(frame)
      return true
    }

    const options = [
      { label: 'Anthropic', value: 'anthropic', description: 'Anthropic Claude API' },
      { label: 'DeepSeek', value: 'deepseek', description: 'DeepSeek AI 开放平台' },
      { label: 'OpenAI', value: 'openai', description: 'OpenAI API' },
      {
        label: 'vertex-gemini (Google Vertex AI) [已配置]',
        value: 'vertex-gemini',
        description: 'Google Vertex AI 模型',
      },
      { label: 'Kimi', value: 'kimi', description: '月之暗面 Kimi 平台' },
    ]

    // 渲染前 3 项可见（此时视口内不含长项 vertex-gemini）
    ink.render(
      <AppStateProvider>
        <Select
          key="p1"
          isDisabled
          visibleOptionCount={3}
          options={options}
          defaultFocusValue="anthropic"
        />
      </AppStateProvider>,
    )

    const frame1 = frameToLines(frames.at(-1)!)
    const anthropicLine1 = frame1.find((l) => l.includes('Anthropic'))!
    const descCol1 = anthropicLine1.indexOf('Anthropic Claude API')

    // 重新渲染聚焦到底部项（视口滑到包含 vertex-gemini 的区域）
    ink.render(
      <AppStateProvider>
        <Select
          key="p2"
          isDisabled
          visibleOptionCount={3}
          options={options}
          defaultFocusValue="kimi"
        />
      </AppStateProvider>,
    )

    const frame2 = frameToLines(frames.at(-1)!)
    const kimiLine = frame2.find((l) => l.includes('Kimi'))!
    const descCol2 = kimiLine.indexOf('月之暗面 Kimi 平台')

    // 验证：视口变化前后，左右两列的描述对齐起始列完全一致，不发生抖动跳变
    expect(descCol1).toBeGreaterThan(0)
    expect(descCol1).toBe(descCol2)
    ink.unmount()
  })
})
