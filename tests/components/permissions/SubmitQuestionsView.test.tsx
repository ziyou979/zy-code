import { describe, expect, test } from 'bun:test'
import { PassThrough, Writable } from 'node:stream'
import { SubmitQuestionsView } from '../../../src/components/permissions/AskUserQuestionPermissionRequest/SubmitQuestionsView.js'
import { tSync } from '../../../src/i18n/index.js'
import Box from '../../../src/ink/components/Box.js'
import ScrollBox from '../../../src/ink/components/ScrollBox.js'
import Text from '../../../src/ink/components/Text.js'
import type { Frame } from '../../../src/ink/frame.js'
import Ink from '../../../src/ink/ink.js'
import { charInCellAt } from '../../../src/ink/screen.js'
import { stringWidth } from '../../../src/ink/stringWidth.js'
import { AppStateProvider } from '../../../src/state/AppState.js'

describe('SubmitQuestionsView', () => {
  test('滚动后的回答确认页可用鼠标提交和取消', () => {
    const stdout = new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
    }) as unknown as NodeJS.WriteStream
    stdout.columns = 100
    stdout.rows = 35
    stdout.isTTY = true
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream
    stdin.isTTY = true
    stdin.setRawMode = () => stdin
    stdin.ref = () => stdin
    stdin.unref = () => stdin
    // 模拟标准终端：测试直接按屏幕缓冲区 2-cell 坐标注入点击，
    // 而 Ink 在 JetBrains 内置终端（TERMINAL_EMULATOR=JetBrains-JediTerm）下
    // 会对鼠标列施加宽字符补偿（correctCol），导致含 CJK 的行坐标错位命中相邻节点。
    const savedTerminalEmulator = process.env.TERMINAL_EMULATOR
    delete process.env.TERMINAL_EMULATOR
    const responses: string[] = []
    const navigations: number[] = []
    let ink: Ink | undefined
    try {
      ink = new Ink({ stdout, stderr: stdout, stdin, exitOnCtrlC: false, patchConsole: false })
      ink.setAltScreenActive(true, true)
      ink.render(
        <AppStateProvider>
          <Box height={35} flexDirection="column">
            <ScrollBox height={31} flexDirection="column" stickyScroll>
              <Text>{'历史消息\n'.repeat(40)}</Text>
              <SubmitQuestionsView
                questions={[
                  {
                    question: '审查哪个目标？',
                    header: '审查目标',
                    multiSelect: true,
                    options: [
                      { label: '当前分支', description: '' },
                      { label: '其他分支', description: '' },
                    ],
                  },
                ]}
                currentQuestionIndex={1}
                answers={{ '审查哪个目标？': '当前分支' }}
                allQuestionsAnswered
                permissionResult={{ behavior: 'ask', message: '' }}
                minContentHeight={12}
                outerMinHeight={20}
                onFinalResponse={(value) => responses.push(value)}
                onNavigate={(index) => navigations.push(index)}
              />
            </ScrollBox>
            <Box height={4}>
              <Text>底部区域</Text>
            </Box>
          </Box>
        </AppStateProvider>,
      )
      // ink.render() 不同步 flush 帧，读取 frontFrame 前必须显式触发一次 onRender
      ;(ink as unknown as { onRender: () => void }).onRender()
      for (const [key, value] of [
        ['permissionRules.submitAnswers', 'submit'],
        ['permissionRules.cancel', 'cancel'],
      ] as const) {
        const frame = (ink as unknown as { frontFrame: Frame }).frontFrame
        const label = tSync(key)
        let clicked = false
        for (let row = 0; row < frame.screen.height; row++) {
          let line = ''
          for (let col = 0; col < frame.screen.width; col++)
            line += charInCellAt(frame.screen, col, row)
          if (line.includes(`${value === 'submit' ? '1' : '2'}. ${label}`)) {
            clicked = ink.dispatchClick(5, row)
            break
          }
        }
        expect(clicked).toBe(true)
        expect(responses.at(-1)).toBe(value)
      }
      expect(responses).toEqual(['submit', 'cancel'])
      const frame = (ink as unknown as { frontFrame: Frame }).frontFrame
      let navigationRow = -1
      let navigationLine = ''
      for (let row = 0; row < frame.screen.height; row++) {
        let line = ''
        for (let col = 0; col < frame.screen.width; col++)
          line += charInCellAt(frame.screen, col, row)
        if (line.includes('审查目标')) {
          navigationRow = row
          navigationLine = line
          break
        }
      }
      expect(navigationRow).toBeGreaterThanOrEqual(0)
      const submitColumn = stringWidth(
        navigationLine.slice(0, navigationLine.indexOf(tSync('permissionRules.submit'))),
      )
      expect(ink.dispatchClick(submitColumn, navigationRow)).toBe(true)
      expect(responses).toEqual(['submit', 'cancel', 'submit'])
      expect(ink.dispatchClick(0, navigationRow)).toBe(true)
      expect(ink.dispatchClick(5, navigationRow)).toBe(true)
      expect(navigations).toEqual([0, 0])
    } finally {
      ink?.unmount()
      if (savedTerminalEmulator === undefined) {
        delete process.env.TERMINAL_EMULATOR
      } else {
        process.env.TERMINAL_EMULATOR = savedTerminalEmulator
      }
    }
  })
})
