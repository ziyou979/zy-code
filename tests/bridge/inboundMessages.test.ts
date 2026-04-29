/**
 * 入站测试：bridge 客户端 ImageBlock 归一化
 * 被测函数：bridge/inboundMessages.ts
 *   - normalizeImageBlocks
 *   - extractInboundMessageFields
 *
 * 重点关注：删除 ImageBlock.source 后，旧版 bridge 客户端发上来的
 *   v1 嵌套形态、v2 平铺缺字段形态都能被自动归一为 v2 平铺。
 */
import { describe, test, expect } from 'bun:test'
import {
  normalizeImageBlocks,
  extractInboundMessageFields,
} from '../../src/bridge/inboundMessages.js'
import type { ContentBlock, ImageBlock } from '../../src/types/llm.js'

// 1×1 px 透明 PNG（用于 magic byte 探测兜底）
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

describe('normalizeImageBlocks: 三种历史形态归一为 v2 平铺', () => {
  test('全部已是规范 v2 平铺：返回原数组引用（零分配 fast-path）', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'hello' } as any,
      { type: 'image', mimeType: 'image/png', data: PNG_BASE64 } as ImageBlock,
    ]
    const out = normalizeImageBlocks(blocks)
    expect(out).toBe(blocks) // 同一引用
  })

  test('v2 平铺缺 mimeType：用 magic byte 探测补齐', () => {
    const blocks: ContentBlock[] = [
      { type: 'image', data: PNG_BASE64 } as any,
    ]
    const out = normalizeImageBlocks(blocks)
    expect(out).not.toBe(blocks)
    const img = out[0] as ImageBlock
    expect(img.type).toBe('image')
    expect(img.mimeType).toBe('image/png')
    expect(img.data).toBe(PNG_BASE64)
    // 不再带 source 字段
    expect((img as any).source).toBeUndefined()
  })

  test('v1 嵌套 source 含 mediaType + data：抹平成 v2 平铺', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'image',
        source: {
          type: 'base64',
          mediaType: 'image/jpeg',
          data: 'aGVsbG8=',
        },
      } as any,
    ]
    const out = normalizeImageBlocks(blocks)
    const img = out[0] as ImageBlock
    expect(img).toEqual({
      type: 'image',
      mimeType: 'image/jpeg',
      data: 'aGVsbG8=',
    })
    expect((img as any).source).toBeUndefined()
  })

  test('v1 嵌套 source 但 mediaType 缺失：用 magic byte 探测兜底', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'image',
        source: { type: 'base64', data: PNG_BASE64 },
      } as any,
    ]
    const out = normalizeImageBlocks(blocks)
    const img = out[0] as ImageBlock
    expect(img.type).toBe('image')
    expect(img.mimeType).toBe('image/png') // magic byte 识别成 png
    expect(img.data).toBe(PNG_BASE64)
    expect((img as any).source).toBeUndefined()
  })

  test('混合：text + 规范 image + 异常 image，仅异常 image 被改写', () => {
    const goodImg: ImageBlock = {
      type: 'image',
      mimeType: 'image/png',
      data: PNG_BASE64,
    }
    const badImg = {
      type: 'image',
      source: { type: 'base64', mediaType: 'image/webp', data: 'd2VicA==' },
    } as any
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'hi' } as any,
      goodImg,
      badImg,
    ]
    const out = normalizeImageBlocks(blocks)
    expect(out).not.toBe(blocks) // 触发 normalize
    expect(out[0]).toEqual({ type: 'text', text: 'hi' } as any)
    // good 块保持不变（同对象）
    expect(out[1]).toBe(goodImg)
    // bad 块被改写
    expect(out[2]).toEqual({
      type: 'image',
      mimeType: 'image/webp',
      data: 'd2VicA==',
    })
  })

  test('空数组：返回原数组引用', () => {
    const blocks: ContentBlock[] = []
    const out = normalizeImageBlocks(blocks)
    expect(out).toBe(blocks)
  })
})

describe('extractInboundMessageFields: SDKMessage → enqueue payload', () => {
  test('user 消息含字符串 content：直接返回，不触发图片归一', () => {
    const fields = extractInboundMessageFields({
      type: 'user',
      message: { role: 'user', content: 'hello world' },
    } as any)
    expect(fields).toEqual({ content: 'hello world', uuid: undefined })
  })

  test('user 消息含 v1 嵌套 image block：归一成 v2 平铺', () => {
    const fields = extractInboundMessageFields({
      type: 'user',
      uuid: '11111111-1111-1111-1111-111111111111',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'see' } as any,
          {
            type: 'image',
            source: {
              type: 'base64',
              mediaType: 'image/jpeg',
              data: 'aGVsbG8=',
            },
          } as any,
        ],
      },
    } as any)
    expect(fields?.uuid).toBe('11111111-1111-1111-1111-111111111111' as any)
    const arr = fields?.content as ContentBlock[]
    expect(Array.isArray(arr)).toBe(true)
    expect(arr[1]).toEqual({
      type: 'image',
      mimeType: 'image/jpeg',
      data: 'aGVsbG8=',
    } as any)
  })

  test('非 user 消息：返回 undefined', () => {
    expect(
      extractInboundMessageFields({
        type: 'assistant',
        message: { role: 'assistant', content: 'hi' },
      } as any),
    ).toBeUndefined()
  })

  test('content 缺失或空数组：返回 undefined（避免 enqueue 空消息）', () => {
    expect(
      extractInboundMessageFields({ type: 'user', message: {} } as any),
    ).toBeUndefined()
    expect(
      extractInboundMessageFields({
        type: 'user',
        message: { role: 'user', content: [] },
      } as any),
    ).toBeUndefined()
  })
})
