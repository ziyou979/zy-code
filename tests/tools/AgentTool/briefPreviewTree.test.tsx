import { describe, expect, test } from 'bun:test'
import React from 'react'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../../src/constants/toolLimits.js'
import {
  createAssistantMessage,
  createUserMessage,
} from '../../../src/services/messages/constructors.js'
import type { ToolResultBlock } from '../../../src/types/llm.js'
import {
  BriefStandalonePreview,
  formatToolSummaryForPreview,
} from '../../../src/tools/AgentTool/UI.js'
import { getSearchReadSummaryText } from '../../../src/services/compact/collapseReadSearch.js'
import { BashTool } from '../../../src/tools/BashTool/BashTool.js'
import type { Tools } from '../../../src/tools/tool.js'
import type { ProgressMessage } from '../../../src/types/message.js'
import type { Progress } from '../../../src/tools/AgentTool/AgentTool.js'

// 构造用于测试的工具集合
const mockTools = [
  BashTool,
  {
    name: 'Edit',
    briefStandalone: true,
    userFacingName: () => 'Edit',
    getToolUseSummary: (input: { file_path?: string }) => input.file_path ?? '',
  },
  {
    name: 'Read',
    briefStandalone: false,
    userFacingName: () => 'Read',
    getToolUseSummary: (input: { file_path?: string }) => input.file_path ?? '',
    isSearchOrReadCommand: () => ({ isRead: true }),
  },
] as unknown as Tools

// 构造模拟的 progressMessages
function makeProgressMessages(
  calls: Array<{
    id: string
    name: string
    input: Record<string, unknown>
    resultOutput?: string
    isError?: boolean
  }>,
): ProgressMessage<Progress>[] {
  const messages: ProgressMessage<Progress>[] = []

  for (const c of calls) {
    const progressFields = {
      timestamp: '2026-09-17T00:00:00.000Z',
      toolUseID: c.id,
      parentToolUseID: 'parent-agent-call',
    }
    const agentFields = { prompt: '', agentId: 'test-agent' }
    messages.push({
      ...progressFields,
      uuid: `uuid-call-${c.id}`,
      type: 'progress',
      data: {
        ...agentFields,
        type: 'agent_progress',
        message: createAssistantMessage({
          content: [{ type: 'tool_call', id: c.id, name: c.name, input: c.input }],
        }),
      },
    })

    if (c.resultOutput !== undefined || c.isError !== undefined) {
      const result: ToolResultBlock = {
        type: 'tool_result',
        toolCallId: c.id,
        content: c.resultOutput ?? '',
        isError: c.isError,
      }
      messages.push({
        ...progressFields,
        uuid: `uuid-result-${c.id}`,
        type: 'progress',
        data: {
          ...agentFields,
          type: 'agent_progress',
          message: createUserMessage({ content: [result] }),
        },
      })
    }
  }

  return messages
}

describe('formatToolSummaryForPreview', () => {
  test('处理空值与空白字符', () => {
    expect(formatToolSummaryForPreview(null)).toBeNull()
    expect(formatToolSummaryForPreview(undefined)).toBeNull()
    expect(formatToolSummaryForPreview('')).toBeNull()
    expect(formatToolSummaryForPreview('   ')).toBeNull()
  })

  test('通用摘要保留类似 shell 命令的原始文本', () => {
    expect(formatToolSummaryForPreview('cd /path/to/dir && bun test')).toBe(
      'cd /path/to/dir && bun test',
    )
  })

  test('默认使用共享工具摘要长度限制', () => {
    expect(formatToolSummaryForPreview('x'.repeat(TOOL_SUMMARY_MAX_LENGTH + 1))).toBe(
      'x'.repeat(TOOL_SUMMARY_MAX_LENGTH) + '…',
    )
  })

  test('压平多行与换行符', () => {
    const multiline = 'git commit -m "\n  feat: something\n  breaking\n"'
    const formatted = formatToolSummaryForPreview(multiline)
    expect(formatted).not.toContain('\n')
    expect(formatted).not.toContain('\r')
    expect(formatted).toBe('git commit -m " feat: something breaking "')
  })

  test('按指定最大长度优雅截断并添加省略号', () => {
    const longText = 'echo 12345678901234567890123456789012345678901234567890'
    const truncated = formatToolSummaryForPreview(longText, 20)
    expect(truncated).toBe('echo 123456789012345…')
    expect(truncated?.length).toBe(21) // 20 字符前缀 + 1 字符省略号
  })
})

describe('BashTool.getToolUseSummary', () => {
  test('优先使用 description', () => {
    const summary = BashTool.getToolUseSummary({
      command: 'bun test tests/tools/AgentTool/briefPreviewTree.test.tsx',
      description: '运行子 Agent UI 测试',
    })
    expect(summary).toBe('运行子 Agent UI 测试')
  })

  test('清洗带引号和长路径的命令后再截断', () => {
    for (const command of [
      'cd "C:\\Program Files\\App" && npm start',
      "cd 'my project' && npm start",
      `cd /${'deep/'.repeat(30)} && npm start`,
    ]) {
      expect(BashTool.getToolUseSummary({ command })).toBe('npm start')
    }
    expect(BashTool.getToolUseSummary({ command: 'echo first\necho second' })).toBe(
      'echo first echo second',
    )
  })

  test('无 description 时自动清洗 command（剥离 cd 样板并截断）', () => {
    const summary = BashTool.getToolUseSummary({
      command: 'cd /some/deep/repo/dir && git status',
    })
    expect(summary).toBe('git status')
  })
})

describe('BriefStandalonePreview 组件与防泄漏回归', () => {
  test('尚无结果的调用不显示完成徽标', () => {
    const progress = makeProgressMessages([
      { id: 'pending', name: 'Bash', input: { command: 'git status' } },
    ])
    const serialized = JSON.stringify(
      BriefStandalonePreview({ progressMessages: progress, tools: mockTools }),
    )
    expect(serialized).toContain('Bash(git status)')
    expect(serialized).not.toContain('✓')
    expect(serialized).not.toContain('✗')
  })

  test('无 briefStandalone 工具调用时返回 null', () => {
    // 只有 Read 工具（briefStandalone = false）
    const progress = makeProgressMessages([
      {
        id: 'call-read-1',
        name: 'Read',
        input: { file_path: 'foo.ts' },
        resultOutput: 'file contents',
      },
    ])
    const element = BriefStandalonePreview({ progressMessages: progress, tools: mockTools })
    expect(element).toBeNull()
  })

  test('折叠树展示动作节点与状态徽标，且绝对不泄漏 stdout 或残留右大括号 }', () => {
    // 构造曾经导致问题复现的典型场景：
    // stdout 输出为 JSON 字符串或者包含多行与大括号 '}'
    const dangerousStdout = `{\n  "status": "success",\n  "code": 0\n}`

    const progress = makeProgressMessages([
      {
        id: 'call-bash-1',
        name: 'Bash',
        input: {
          command: 'cd /work && bun test',
          description: '运行单元测试',
        },
        resultOutput: dangerousStdout,
        isError: false,
      },
      {
        id: 'call-edit-1',
        name: 'Edit',
        input: {
          file_path: 'src/main.ts',
        },
        resultOutput: 'Build failed with error:\n}\n',
        isError: true,
      },
    ])

    // 保留原始 progress 快照，用于验证零上下文污染（只读性）
    const progressSnapshot = JSON.stringify(progress)

    const element = BriefStandalonePreview({ progressMessages: progress, tools: mockTools })
    expect(element).not.toBeNull()

    // 转换为 React 元素结构进行树结构与子节点分析
    // Box (children: MessageResponse[], plus optional CtrlOToExpand)
    const container = element as React.ReactElement<{ children: React.ReactNode[] }>
    const children = React.Children.toArray(container.props.children)

    // 前两个元素为对应的 MessageResponse 节点
    expect(children.length).toBeGreaterThanOrEqual(2)

    // 序列化所有渲染文本，进行铁证断言：绝不包含 stdout 内容，绝不包含泄漏的 '}'
    const serialized = JSON.stringify(element)

    // 绝对不包含危险的 stdout 内容
    expect(serialized).not.toContain('"status": "success"')
    expect(serialized).not.toContain('Build failed with error')

    // 验证状态徽标：成功徽标 ✓ 与失败徽标 ✗
    expect(serialized).toContain('✓')
    expect(serialized).toContain('✗')

    // 验证摘要存在
    expect(serialized).toContain('运行单元测试')
    expect(serialized).toContain('Edit(src/main.ts)')

    // 铁证断言：整个渲染树不能篡改输入的消息数据（零副作用、无上下文污染）
    expect(JSON.stringify(progress)).toBe(progressSnapshot)
  })

  test('混合 search/read 汇总节点与 briefStandalone 操作节点正常渲染', () => {
    const prevUserType = process.env.USER_TYPE
    process.env.USER_TYPE = 'zy-super'
    try {
      const progress = makeProgressMessages([
        {
          id: 'call-read-1',
          name: 'Read',
          input: { file_path: 'foo.ts' },
          resultOutput: 'file contents 1',
        },
        {
          id: 'call-read-2',
          name: 'Read',
          input: { file_path: 'bar.ts' },
          resultOutput: 'file contents 2',
        },
        {
          id: 'call-bash-1',
          name: 'Bash',
          input: { command: 'git diff' },
          resultOutput: 'diff --git a/file b/file',
          isError: false,
        },
      ])

      const element = BriefStandalonePreview({ progressMessages: progress, tools: mockTools })
      expect(element).not.toBeNull()
      const serialized = JSON.stringify(element)

      // 包含搜索/读取统计
      const expectedSummary = getSearchReadSummaryText(0, 2, false, 0)
      expect(serialized).toContain(expectedSummary)
      // 包含 Bash 节点与成功徽标
      expect(serialized).toContain('Bash(git diff)')
      expect(serialized).toContain('✓')
      // 单行保护属性生效
      const rows = React.Children.toArray(element?.props.children).filter(
        (
          child,
        ): child is React.ReactElement<{
          height?: number
          children: React.ReactElement<{ wrap?: string }>
        }> => React.isValidElement<{ height?: number }>(child) && child.props.height !== undefined,
      )
      expect(rows).toHaveLength(2)
      for (const row of rows) {
        expect(row.props.height).toBe(1)
        expect(row.props.children.props.wrap).toBe('truncate-end')
      }
    } finally {
      process.env.USER_TYPE = prevUserType
    }
  })

  test('同名 briefStandalone 工具多次调用时展示最新一次并计入折叠统计', () => {
    const progress = makeProgressMessages([
      {
        id: 'call-bash-1',
        name: 'Bash',
        input: { command: 'echo first' },
        resultOutput: 'first',
        isError: false,
      },
      {
        id: 'call-bash-2',
        name: 'Bash',
        input: { command: 'echo second' },
        resultOutput: 'second',
        isError: false,
      },
      {
        id: 'call-bash-3',
        name: 'Bash',
        input: { command: 'echo third' },
        resultOutput: 'third',
        isError: false,
      },
    ])

    const element = BriefStandalonePreview({ progressMessages: progress, tools: mockTools })
    expect(element).not.toBeNull()
    const serialized = JSON.stringify(element)

    // 展示最新的 Bash 调用
    expect(serialized).toContain('Bash(echo third)')
    // 前面两次同名调用被折叠进 +N more tool use 计数中
    expect(serialized).toContain('more tool use')
  })
})
