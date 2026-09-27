import { describe, expect, test } from 'bun:test'
import { messagesToAnthropic } from '../../../../src/services/api/conversions/anthropic.js'
import { messagesToOpenAI } from '../../../../src/services/api/conversions/openai.js'
import { messagesToResponses } from '../../../../src/services/api/conversions/openaiResponses.js'
import { FileReadTool } from '../../../../src/tools/FileReadTool/FileReadTool.js'
import type { LLMMessage, ToolResultBlock } from '../../../../src/types/llm.js'

// 有效的 1×1 PNG，覆盖实际 Read 输出到请求图片字段的完整转换。
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='

function readImage(id: string): ToolResultBlock {
  return FileReadTool.mapToolResultToToolResultBlock(
    { type: 'image', file: { base64: png, type: 'image/png', originalSize: 68 } },
    id,
  )
}

function calls(...ids: string[]): LLMMessage {
  return {
    role: 'assistant',
    content: ids.map((id) => ({
      type: 'tool_call',
      id,
      name: 'Read',
      input: { file_path: `/tmp/${id}.png` },
    })),
  }
}

const formats = [
  {
    name: 'Chat',
    convert: messagesToOpenAI,
    output: (id: string) => ({ role: 'tool', tool_call_id: id }),
    image: (data = png, mimeType = 'image/png') => ({
      type: 'image_url',
      image_url: { url: `data:${mimeType};base64,${data}` },
    }),
    text: (text: string) => ({ type: 'text', text }),
  },
  {
    name: 'Responses',
    convert: messagesToResponses,
    output: (id: string) => ({ type: 'function_call_output', call_id: id }),
    image: (data = png, mimeType = 'image/png') => ({
      type: 'input_image',
      detail: 'auto',
      image_url: `data:${mimeType};base64,${data}`,
    }),
    text: (text: string) => ({ type: 'input_text', text }),
  },
]

for (const format of formats) {
  describe(`toolResultImages ${format.name}`, () => {
    test('Read 的实际图片输出进入视觉字段，历史消息不被修改', () => {
      const messages: LLMMessage[] = [
        calls('read_1'),
        { role: 'user', content: [readImage('read_1')] },
      ]
      const before = structuredClone(messages)
      const result = format.convert(messages)
      expect(result).toHaveLength(3)
      expect(result[1]).toMatchObject(format.output('read_1'))
      expect(result[2]).toMatchObject({
        role: 'user',
        content: [format.text('Images from tool result read_1:'), format.image()],
      })
      expect(JSON.stringify(result[1])).not.toContain('(empty)')
      expect(JSON.stringify(result[1])).not.toContain(png)
      expect(messages).toEqual(before)
    })

    for (const splitMessages of [false, true]) {
      test(`并行图片结果全部返回后再附图（${splitMessages ? '分开消息' : '同一消息'}）`, () => {
        const results = [readImage('read_1'), readImage('read_2')]
        const messages: LLMMessage[] = [
          calls('read_1', 'read_2'),
          ...(splitMessages
            ? results.map((block) => ({ role: 'user' as const, content: [block] }))
            : [{ role: 'user' as const, content: results }]),
          { role: 'assistant', content: [{ type: 'text', text: 'Checked.' }] },
        ]
        const converted = format.convert(messages)
        // Responses 的两个调用是两个 item，Chat 则是一条 assistant 消息。
        const start = format.name === 'Responses' ? 2 : 1
        expect(converted.slice(start, start + 3)).toMatchObject([
          format.output('read_1'),
          format.output('read_2'),
          {
            role: 'user',
            content: [
              format.text('Images from tool result read_1:'),
              format.image(),
              format.text('Images from tool result read_2:'),
              format.image(),
            ],
          },
        ])
        expect(converted.at(-1)).toMatchObject({ role: 'assistant' })
      })
    }

    test('保留混合结果文本、多图顺序和 MIME，等待独立 tool 角色返回', () => {
      const messages: LLMMessage[] = [
        calls('read_1', 'read_2'),
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolCallId: 'read_1',
              content: [
                { type: 'text', text: 'First frame' },
                { type: 'image', mimeType: 'image/png', data: png },
                { type: 'text', text: 'Second frame' },
                { type: 'image', mimeType: 'image/jpeg', data: 'jpeg-data' },
              ],
            },
          ],
        },
        { role: 'tool', toolCallId: 'read_2', content: 'Done' },
        { role: 'user', content: [{ type: 'text', text: 'Compare them.' }] },
      ]
      const converted = format.convert(messages)
      const start = format.name === 'Responses' ? 2 : 1
      expect(JSON.stringify(converted[start])).toContain('First frame')
      expect(JSON.stringify(converted[start])).toContain('Second frame')
      expect(converted[start + 1]).toMatchObject(format.output('read_2'))
      expect(converted[start + 2]).toMatchObject({
        role: 'user',
        content: [
          format.text('Images from tool result read_1:'),
          format.image(),
          format.image('jpeg-data', 'image/jpeg'),
        ],
      })
      expect(JSON.stringify(converted.at(-1))).toContain('Compare them.')
    })
  })
}

describe('toolResultImages Anthropic', () => {
  test('Read 图片保留为工具结果内的原生图片块', () => {
    const messages: LLMMessage[] = [
      calls('read_1'),
      { role: 'user', content: [readImage('read_1')] },
    ]
    const before = structuredClone(messages)
    expect(messagesToAnthropic(messages)[1]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'read_1',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
          ],
        },
      ],
    })
    expect(messages).toEqual(before)
  })

  test('保留工具结果的错误状态、缓存标记和混合内容', () => {
    const result = messagesToAnthropic([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolCallId: 'read_1',
            isError: false,
            cache_control: { type: 'ephemeral' },
            content: [
              { type: 'text', text: 'Frame' },
              { type: 'image', mimeType: 'image/jpeg', data: 'jpeg-data' },
            ],
          },
          { type: 'tool_result', toolCallId: 'read_2', isError: true, content: 'Missing file' },
        ],
      },
    ])
    expect(result[0].content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'read_1',
        is_error: false,
        cache_control: { type: 'ephemeral' },
        content: [
          { type: 'text', text: 'Frame' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: 'jpeg-data' },
          },
        ],
      },
      { type: 'tool_result', tool_use_id: 'read_2', is_error: true, content: 'Missing file' },
    ])
  })
})
