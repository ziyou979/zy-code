/**
 * dev / build 的 feature 宏清单一致性守门。
 *
 * feature() 是编译期宏：dist 由 build.ts 的 features 数组 DCE，dev 由
 * package.json dev 脚本的 --feature=NAME 逐个注入（devPreload.ts 无法设置）。
 * 两份清单是手写维护的，漂移会导致 dev 与 dist 功能面不一致（界面、工具、
 * 命令差异）。此测试直读仓库真实文件，双向断言集合相等。
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..', '..')

function getDevScriptFeatures(): string[] {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
    scripts: { dev: string }
  }
  return [...packageJson.scripts.dev.matchAll(/--feature=([A-Z_0-9]+)/g)].map((m) => m[1])
}

function getBuildFeatures(): string[] {
  const buildTs = readFileSync(join(repoRoot, 'build.ts'), 'utf-8')
  const arrayMatch = buildTs.match(/features:\s*\[([^\]]*)\]/)
  if (!arrayMatch) {
    throw new Error('build.ts 中未找到 features 数组')
  }
  return [...arrayMatch[1].matchAll(/'([A-Z_0-9]+)'/g)].map((m) => m[1])
}

describe('dev --feature 与 build.ts features 对齐', () => {
  test('两边清单完全一致且非空', () => {
    const devFeatures = getDevScriptFeatures()
    const buildFeatures = getBuildFeatures()

    expect(devFeatures.length).toBeGreaterThan(0)
    expect(buildFeatures.length).toBeGreaterThan(0)

    const devSet = new Set(devFeatures)
    const buildSet = new Set(buildFeatures)
    // 双向差集为空：dev 缺项或 build 缺项都算漂移
    expect([...buildSet].filter((f) => !devSet.has(f))).toEqual([])
    expect([...devSet].filter((f) => !buildSet.has(f))).toEqual([])
  })

  test('dev preload 始终选择 React development runtime', () => {
    const preloadPath = join(repoRoot, 'src', 'entrypoints', 'devPreload.ts')
    const result = Bun.spawnSync(
      [
        process.execPath,
        '--preload',
        preloadPath,
        '-e',
        "process.stdout.write(process.env.NODE_ENV ?? '')",
      ],
      {
        env: { ...process.env, NODE_ENV: 'production' },
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe('development')
  })
})
