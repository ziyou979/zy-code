/**
 * 索引刷新行为的集成测试（对齐 Claude Code 的 [FileIndex] 设计）：
 * 1. rg 回退输出排序 → 截断集合与签名跨轮次确定，乱序输出不再触发虚假重建。
 * 2. 主构建路径的中途失效守卫 → load 期间缓存被重置时丢弃过期结果、
 *    不写签名，避免"签名已写但新索引为空"导致建议永久静默丢失。
 *
 * mock 面刻意收窄到 file-index / git / ripgrep 三个直接依赖；
 * settings/config/cwd 走真实实现（config 守卫由 NODE_ENV=test 豁免，见 bunfig preload），
 * 以限制对同一 bun test 进程里并发交错运行的其它文件的污染。
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import * as path from 'node:path'

type LoadCall = { index: unknown; list: string[] }
const loadCalls: LoadCall[] = []
// 在 loadFromFileListAsync 被调用的同步时刻触发（用于模拟"构建中途缓存被清"）
let onLoadHook: (() => void) | null = null
// ripgrep 输出顺序由 rgQueue 逐次弹出控制（绝对路径，贴近真实返回形态）
let rgQueue: string[][] = []
const TEST_CWD = path.resolve('.')

const realFileIndex = await import('../../src/native-ts/file-index/index.js')
const realGit = await import('../../src/services/infra/git.js')
const realRipgrep = await import('../../src/services/file-search/ripgrep.js')

mock.module('../../src/native-ts/file-index/index.js', () => ({
  ...realFileIndex,
  CHUNK_MS: 4,
  yieldToEventLoop: async () => {},
  FileIndex: class {
    loadFromFileListAsync(fileList: string[]) {
      loadCalls.push({ index: this, list: [...fileList] })
      if (onLoadHook) {
        const hook = onLoadHook
        onLoadHook = null
        hook()
      }
      return { done: Promise.resolve() }
    }
  },
}))

// findGitRoot → null：强制 getProjectFiles 走 ripgrep 回退路径
mock.module('../../src/services/infra/git.js', () => ({
  ...realGit,
  findGitRoot: () => null,
  gitExe: () => 'git',
}))

mock.module('../../src/services/file-search/ripgrep.js', () => ({
  ...realRipgrep,
  ripGrep: async () => {
    const next = rgQueue.length > 0 ? rgQueue.shift()! : ['z.ts', 'm.ts', 'a.ts', 'b.ts', 'c.ts']
    return next.map((f) => path.join(TEST_CWD, f))
  },
}))

const m = await import('../../src/hooks/fileSuggestions.js')

function resetMocks() {
  loadCalls.length = 0
  onLoadHook = null
  rgQueue = []
  m.clearFileSuggestionCaches()
}

describe('FileIndex 刷新（对齐 CC）', () => {
  afterEach(() => {
    resetMocks()
  })

  test('rg 乱序输出经排序后签名稳定，不触发第二次的虚假重建', async () => {
    resetMocks()
    const order1 = ['z.ts', 'm.ts', 'a.ts', 'b.ts', 'c.ts']
    const order2 = ['c.ts', 'b.ts', 'a.ts', 'm.ts', 'z.ts'] // 集合相同、顺序相反
    rgQueue = [order1, order2]

    await m.getPathsForSuggestions()
    await m.getPathsForSuggestions()

    // 无 .sort() 时两轮截断/哈希集合顺序不同 → 签名翻转 → 重建两次。
    // 排序后第二轮签名一致 → 跳过重建，仅一次加载。
    expect(loadCalls).toHaveLength(1)
    const files = loadCalls[0]!.list.slice(-5)
    expect(files).toEqual([...order1].sort())
  })

  test('load 期间缓存被重置时丢弃结果，下一轮在新索引上重建', async () => {
    resetMocks()
    const order = ['b.ts', 'a.ts', 'c.ts']
    rgQueue = [order, order] // 两轮内容一致

    // 模拟会话恢复：构建进行到 load 的同步时刻把缓存整个重置
    onLoadHook = () => {
      m.clearFileSuggestionCaches()
    }
    const index1 = await m.getPathsForSuggestions()
    expect(loadCalls).toHaveLength(1)

    // 第二轮：同一列表再次刷新
    const index2 = await m.getPathsForSuggestions()

    // 守卫生效：第一轮丢弃后不写签名，第二轮必须真正重建
    // （旧行为：第一轮把签名写到已被替换的索引上，第二轮命中残留签名而跳过，
    // 留下一个从未加载过的空索引 → 文件建议永久为空）。
    expect(loadCalls).toHaveLength(2)
    expect(index1).not.toBe(index2)
    expect(loadCalls[0]!.index).not.toBe(loadCalls[1]!.index)
  })
})

// 本文件结束后把三个 mock 恢复为真实快照，把污染限制在执行窗口内
afterAll(() => {
  mock.module('../../src/native-ts/file-index/index.js', () => ({ ...realFileIndex }))
  mock.module('../../src/services/infra/git.js', () => ({ ...realGit }))
  mock.module('../../src/services/file-search/ripgrep.js', () => ({ ...realRipgrep }))
})
