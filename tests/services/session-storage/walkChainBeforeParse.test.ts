import { describe, expect, test } from 'bun:test'
import { buildConversationChain } from '../../../src/services/session-storage/chain.js'
import {
  repairBrokenParentUuidChains,
  walkChainBeforeParse,
} from '../../../src/services/session-storage/logLoading.js'
import type { TranscriptMessage } from '../../../src/types/logs.js'

const SID = '11111111-1111-4111-8111-111111111111'
const U_COLD = '22222222-2222-4222-8222-222222222222'
const A_COLD = '33333333-3333-4333-8333-333333333333'
const B1 = '44444444-4444-4444-8444-444444444444'
const U_HOT = '55555555-5555-4555-8555-555555555555'
const A_HOT_ROOT = '66666666-6666-4666-8666-666666666666'
const A_HOT_LEAF = '77777777-7777-4777-8777-777777777777'
const U_DEAD = '88888888-8888-4888-8888-888888888888'
const A_DEAD = '99999999-9999-4999-8999-999999999999'
const EARLY_COLD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function msgLine(fields: {
  parentUuid: string | null
  uuid: string
  type: 'user' | 'assistant' | 'system'
  subtype?: string
  isSidechain?: boolean
  text?: string
  /** 模拟 createCompactBoundaryMessage：timestamp 在 uuid 前 */
  compactTimestampBeforeUuid?: boolean
}): string {
  if (fields.type === 'system' && fields.subtype === 'compact_boundary') {
    // 与落盘形状一致：parentUuid 开头，timestamp 在 uuid 前，无 ","timestamp" 紧跟 uuid
    const o: Record<string, unknown> = {
      parentUuid: fields.parentUuid,
      isSidechain: fields.isSidechain ?? false,
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      timestamp: '2026-01-01T00:00:00.000Z',
      uuid: fields.uuid,
      level: 'info',
      sessionId: SID,
      compactMetadata: { trigger: 'manual', preTokens: 1 },
    }
    return `${JSON.stringify(o)}\n`
  }

  const base: Record<string, unknown> = {
    parentUuid: fields.parentUuid,
    isSidechain: fields.isSidechain ?? false,
    type: fields.type,
    uuid: fields.uuid,
    timestamp: '2026-01-01T00:00:00.000Z',
    sessionId: SID,
  }
  if (fields.type === 'user' || fields.type === 'assistant') {
    base.message = {
      role: fields.type,
      content: [{ type: 'text', text: fields.text ?? fields.uuid }],
    }
  }
  return `${JSON.stringify(base)}\n`
}

/** 填充到足够大的无关死字节，迫使 walk 真的裁剪而非 early-return */
function padDeadBranch(
  seed: string,
  minDeadBytes: number,
  parentUuid: string | null = null,
): string {
  let out = ''
  let i = 0
  let prevParent: string | null = parentUuid
  while (Buffer.byteLength(out) < minDeadBytes) {
    const u = `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, '0')}`
    const a = `cccccccc-cccc-4ccc-8ccc-${String(i).padStart(12, '0')}`
    out += msgLine({
      parentUuid: prevParent,
      uuid: u,
      type: 'user',
      text: `${seed}-${i}-${'x'.repeat(200)}`,
    })
    out += msgLine({
      parentUuid: u,
      uuid: a,
      type: 'assistant',
      text: `${seed}-a-${i}-${'y'.repeat(200)}`,
    })
    prevParent = null
    i++
  }
  return out
}

describe('walkChainBeforeParse 冷热分离', () => {
  test('CB 在 parent 链上时保留 cold；sidechain 死叉仍剔除', () => {
    // 有 CB 时 walk 保留 leaf 及之前全部主消息（正确性优先，避免断链丢 cold）。
    // 仍可丢掉 isSidechain 行；用大 sidechain pad 过 50% 门控。
    let sidePad = ''
    let i = 0
    while (Buffer.byteLength(sidePad) < 12 * 1024) {
      const u = `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, '0')}`
      const a = `cccccccc-cccc-4ccc-8ccc-${String(i).padStart(12, '0')}`
      sidePad += msgLine({
        parentUuid: null,
        uuid: u,
        type: 'user',
        isSidechain: true,
        text: `SIDE-${i}-${'x'.repeat(200)}`,
      })
      sidePad += msgLine({
        parentUuid: u,
        uuid: a,
        type: 'assistant',
        isSidechain: true,
        text: `SIDE-a-${i}-${'y'.repeat(200)}`,
      })
      i++
    }
    const earlyCold = msgLine({
      parentUuid: null,
      uuid: EARLY_COLD,
      type: 'user',
      text: 'EARLY_COLD',
    })
    const cold = msgLine({
      parentUuid: EARLY_COLD,
      uuid: U_COLD,
      type: 'user',
      text: 'COLD_TIP',
    })
    const coldA = msgLine({
      parentUuid: U_COLD,
      uuid: A_COLD,
      type: 'assistant',
      text: 'COLD_TIP_A',
    })
    const boundary = msgLine({
      parentUuid: null,
      uuid: B1,
      type: 'system',
      subtype: 'compact_boundary',
    })
    const hotU = msgLine({
      parentUuid: B1,
      uuid: U_HOT,
      type: 'user',
      text: 'HOT',
    })
    const hotA = msgLine({
      parentUuid: U_HOT,
      uuid: A_HOT_LEAF,
      type: 'assistant',
      text: 'HOT_A',
    })
    const deadSide = msgLine({
      parentUuid: null,
      uuid: U_DEAD,
      type: 'user',
      isSidechain: true,
      text: 'DEAD_SIDE',
    })

    const buf = Buffer.from(sidePad + earlyCold + cold + coldA + boundary + hotU + hotA + deadSide)
    const out = walkChainBeforeParse(buf)
    const text = out.toString('utf8')

    expect(text).toContain(EARLY_COLD)
    expect(text).toContain(U_COLD)
    expect(text).toContain(B1)
    expect(text).toContain(U_HOT)
    expect(text).toContain(A_HOT_LEAF)
    expect(text).not.toContain(U_DEAD)
    expect(text).not.toContain('SIDE-0-')
    expect(out.length).toBeLessThan(buf.length)
  })

  test('CB 后热根 parentUuid=null（真实 compact 后流式断链）时仍保留 cold+CB', () => {
    // 复现实测：CB → user(parent=CB) → assistant(parent=null) → … leaf
    // parent 链从 assistant 断掉，不含 CB；旧逻辑整段 cold 丢失。
    const coldBig: string[] = []
    for (let i = 0; i < 20; i++) {
      const u = `dddddddd-dddd-4ddd-8ddd-${String(i).padStart(12, '0')}`
      const a = `eeeeeeee-eeee-4eee-8eee-${String(i).padStart(12, '0')}`
      coldBig.push(
        msgLine({
          parentUuid: null,
          uuid: u,
          type: 'user',
          text: `big-cold-${i}-${'z'.repeat(300)}`,
        }),
      )
      coldBig.push(
        msgLine({
          parentUuid: u,
          uuid: a,
          type: 'assistant',
          text: `big-cold-a-${i}-${'w'.repeat(300)}`,
        }),
      )
    }
    const boundary = msgLine({
      parentUuid: null,
      uuid: B1,
      type: 'system',
      subtype: 'compact_boundary',
    })
    const hotU = msgLine({
      parentUuid: B1,
      uuid: U_HOT,
      type: 'user',
      text: 'HOT_SUMMARY',
    })
    // 断链热根
    const hotRoot = msgLine({
      parentUuid: null,
      uuid: A_HOT_ROOT,
      type: 'assistant',
      text: 'HOT_STREAM_ROOT',
    })
    const hotLeaf = msgLine({
      parentUuid: A_HOT_ROOT,
      uuid: A_HOT_LEAF,
      type: 'assistant',
      text: 'HOT_STREAM_LEAF',
    })
    const buf = Buffer.from(coldBig.join('') + boundary + hotU + hotRoot + hotLeaf)
    const out = walkChainBeforeParse(buf)
    const text = out.toString('utf8')

    expect(text).toContain(B1)
    expect(text).toContain(U_HOT)
    expect(text).toContain(A_HOT_ROOT)
    expect(text).toContain(A_HOT_LEAF)
    expect(text).toContain('big-cold-0')
    // cold 体量大 → 通常 early-return 全量，至少不得短于 hot 碎片
    expect(out.length).toBeGreaterThan(buf.length * 0.5)
  })

  test('无 compact_boundary 时行为仍为只保留 parent 热链', () => {
    const deadPad = padDeadBranch('NOCB', 8 * 1024)
    const deadU = msgLine({
      parentUuid: null,
      uuid: U_DEAD,
      type: 'user',
      text: 'ORPHAN',
    })
    const root = msgLine({
      parentUuid: null,
      uuid: U_HOT,
      type: 'user',
      text: 'ONLY_HOT',
    })
    const leaf = msgLine({
      parentUuid: U_HOT,
      uuid: A_HOT_LEAF,
      type: 'assistant',
      text: 'ONLY_HOT_A',
    })
    const buf = Buffer.from(deadPad + deadU + root + leaf)
    const out = walkChainBeforeParse(buf)
    const text = out.toString('utf8')
    expect(text).toContain(U_HOT)
    expect(text).toContain(A_HOT_LEAF)
    expect(text).not.toContain(U_DEAD)
  })
})

describe('repair + buildConversationChain 断链 hot', () => {
  test('repair 将 parentUuid=null 的热根挂到 CB，chain 含 cold+CB+hot', () => {
    const mk = (partial: Record<string, unknown>): TranscriptMessage =>
      ({
        isSidechain: false,
        sessionId: SID,
        cwd: '/tmp',
        userType: 'external',
        version: 'test',
        ...partial,
      }) as unknown as TranscriptMessage

    const map = new Map<string, TranscriptMessage>()
    const put = (m: TranscriptMessage) => map.set(m.uuid, m)

    put(
      mk({
        uuid: U_COLD,
        parentUuid: null,
        type: 'user',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'cold' }] },
      }),
    )
    put(
      mk({
        uuid: B1,
        parentUuid: null,
        type: 'system',
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        level: 'info',
        timestamp: '2026-01-01T00:00:02.000Z',
        compactMetadata: { trigger: 'manual', preTokens: 1 },
      }),
    )
    put(
      mk({
        uuid: U_HOT,
        parentUuid: B1,
        type: 'user',
        timestamp: '2026-01-01T00:00:03.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'hot summary' }] },
      }),
    )
    // 断链
    put(
      mk({
        uuid: A_HOT_ROOT,
        parentUuid: null,
        type: 'assistant',
        timestamp: '2026-01-01T00:00:04.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'stream root' }],
          id: 'm1',
          model: 't',
        },
      }),
    )
    put(
      mk({
        uuid: A_HOT_LEAF,
        parentUuid: A_HOT_ROOT,
        type: 'assistant',
        timestamp: '2026-01-01T00:00:05.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'stream leaf' }],
          id: 'm1',
          model: 't',
        },
      }),
    )

    repairBrokenParentUuidChains(map)
    expect(map.get(A_HOT_ROOT)!.parentUuid).toBe(U_HOT)
    // CB 保持 null
    expect(map.get(B1)!.parentUuid).toBeNull()

    const chain = buildConversationChain(map, map.get(A_HOT_LEAF)!)
    const uuids = chain.map((m) => m.uuid)
    expect(uuids).toContain(U_COLD)
    expect(uuids).toContain(B1)
    expect(uuids).toContain(U_HOT)
    expect(uuids).toContain(A_HOT_ROOT)
    expect(uuids).toContain(A_HOT_LEAF)
    expect(uuids.indexOf(U_COLD)).toBeLessThan(uuids.indexOf(B1))
    expect(uuids.indexOf(B1)).toBeLessThan(uuids.indexOf(A_HOT_LEAF))
  })
})
