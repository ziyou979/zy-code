import { describe, expect, test } from 'bun:test'
import {
  assertMessageInputModalities,
  getMessageMediaInputModalities,
} from '../../../src/services/model/modelInputCapabilities.js'
import type { AssistantMessage, UserMessage } from '../../../src/types/message.js'

function userMessage(content: UserMessage['message']['content']): UserMessage {
  return {
    type: 'user',
    uuid: 'user-message',
    timestamp: '2026-08-22T00:00:00.000Z',
    message: { role: 'user', content },
  }
}

describe('modelInputCapabilities', () => {
  test('识别普通图片、文档和工具结果中的图片', () => {
    const messages: (UserMessage | AssistantMessage)[] = [
      userMessage([
        { type: 'text', text: '请分析附件' },
        { type: 'image', mimeType: 'image/png', data: 'image-data' },
        { type: 'document', source: { type: 'base64', data: 'document-data' } },
        {
          type: 'tool_result',
          toolCallId: 'tool-call',
          content: [{ type: 'image', mimeType: 'image/png', data: 'tool-image-data' }],
        },
      ]),
    ]

    expect(getMessageMediaInputModalities(messages)).toEqual(['image/png', 'document'])
  })

  test('显式声明为纯文本时拒绝图片输入', () => {
    const messages = [userMessage([{ type: 'image', mimeType: 'image/png', data: 'image-data' }])]

    // 全量测试会并行切换 i18n 语言，因此这里只断言行为，不耦合具体语言文案。
    expect(() => assertMessageInputModalities('text-only', messages, ['text'])).toThrow()
  })

  test('视觉模型允许图片，未声明能力的模型保持兼容', () => {
    const messages = [userMessage([{ type: 'image', mimeType: 'image/png', data: 'image-data' }])]

    expect(() => assertMessageInputModalities('vision', messages, ['text', 'image'])).not.toThrow()
    expect(() =>
      assertMessageInputModalities('undeclared-model', messages, undefined),
    ).not.toThrow()
  })
})

test('按具体 MIME 区分图片格式，并检查工具结果和 PDF 来源字段', () => {
  const jpeg = [userMessage([{ type: 'image', mimeType: 'image/jpeg', data: 'jpeg' }])]
  expect(() => assertMessageInputModalities('jpeg', jpeg, ['text', 'image/jpeg'])).not.toThrow()
  expect(() => assertMessageInputModalities('png', jpeg, ['text', 'image/png'])).toThrow()
  expect(() => assertMessageInputModalities('generic', jpeg, ['image'])).not.toThrow()
  const nested = [
    userMessage([
      {
        type: 'tool_result',
        toolCallId: 'x',
        content: [{ type: 'image', mimeType: 'image/webp', data: 'webp' }],
      },
    ]),
  ]
  expect(() => assertMessageInputModalities('jpeg', nested, ['image/jpeg'])).toThrow()
  for (const key of ['mediaType', 'media_type', 'mimeType']) {
    const pdf = [
      userMessage([{ type: 'document', source: { [key]: 'application/pdf', data: 'pdf' } }]),
    ]
    expect(getMessageMediaInputModalities(pdf)).toEqual(['application/pdf'])
    expect(() => assertMessageInputModalities('pdf', pdf, ['application/pdf'])).not.toThrow()
    expect(() => assertMessageInputModalities('doc', pdf, ['document'])).not.toThrow()
    expect(() => assertMessageInputModalities('jpeg', pdf, ['image/jpeg'])).toThrow()
  }
  const unknown = [userMessage([{ type: 'document', source: {} }])]
  expect(() => assertMessageInputModalities('pdf', unknown, ['application/pdf'])).toThrow()
})
