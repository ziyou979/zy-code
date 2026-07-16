/**
 * lint-architecture 脚本治理回归测试。
 *
 * 这些用例直接拉起真实脚本，验证门禁语义而不是复制实现，
 * 这样脚本重构后仍能守住“基线可信、违规可审计”的目标。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const lintScript = join(repoRoot, 'scripts', 'lint-architecture.ts')
const tempRoots: string[] = []

type RunResult = {
  exitCode: number
  stdout: string
  stderr: string
}

function createFixtureProject(files: Record<string, string>): {
  root: string
  baselinePath: string
} {
  const root = mkdtempSync(join(tmpdir(), 'zy-arch-lint-'))
  const baselinePath = join(root, 'scripts', 'architecture-debt-baseline.json')
  tempRoots.push(root)

  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'scripts'), { recursive: true })

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(root, relativePath)
    mkdirSync(resolve(absolutePath, '..'), { recursive: true })
    writeFileSync(absolutePath, content)
  }

  return { root, baselinePath }
}

function runLint(root: string, baselinePath: string, args: string[] = []): RunResult {
  const env = {
    ...process.env,
    ZY_ARCH_ROOT: root,
    ZY_ARCH_BASELINE_PATH: baselinePath,
  }

  const result = spawnSync(process.execPath, [lintScript, ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  })

  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

describe('lint-architecture', () => {
  test('历史根文件按大小写不敏感识别，不误报为新增文件', () => {
    const fixture = createFixtureProject({
      'src/queryEngine.ts': 'export const queryEngine = 1\n',
    })

    const result = runLint(fixture.root, fixture.baselinePath, ['--write-baseline'])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain('src/ 根目录历史文件 queryEngine.ts')
    expect(result.stderr).not.toContain('src/ 根目录新增文件 queryEngine.ts')
  })

  test('普通 kebab-case TypeScript 模块会被命名规则拦下', () => {
    const fixture = createFixtureProject({
      'src/utils/foo-bar.ts': 'export const fooBar = 1\n',
      'src/utils/useSelectState.ts': 'export function useSelectState() { return 1 }\n',
    })

    const result = runLint(fixture.root, fixture.baselinePath, ['--write-baseline'])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain('普通模块建议 camelCase: foo-bar.ts')
    expect(result.stderr).not.toContain('普通模块建议 camelCase: useSelectState.ts')
  })

  test('if 条件中的 feature 复合逻辑只按一个源码点报错', () => {
    const fixture = createFixtureProject({
      'src/utils/featureGate.ts': [
        'export function shouldRun(ready: boolean) {',
        "  if (feature('FLAG_A') && ready) {",
        '    return true',
        '  }',
        "  return !feature('FLAG_B')",
        '}',
        '',
      ].join('\n'),
    })

    const result = runLint(fixture.root, fixture.baselinePath, ['--write-baseline'])
    const matches = result.stderr.match(/feature\(\) 在 if 中不能与 && 组合/g) ?? []

    expect(result.exitCode).toBe(0)
    expect(matches).toHaveLength(1)
    expect(result.stderr).not.toContain('feature() 不能用于 && 表达式')
  })

  test('as any 基线按具体位置比较，不允许不同文件之间平移', () => {
    const fixture = createFixtureProject({
      'src/utils/firstAny.ts': 'export const firstValue = 1 as any\n',
    })

    const baselineResult = runLint(fixture.root, fixture.baselinePath, ['--write-baseline'])
    expect(baselineResult.exitCode).toBe(0)

    writeFileSync(
      join(fixture.root, 'src', 'utils', 'firstAny.ts'),
      'export const firstValue = 1\n',
    )
    writeFileSync(
      join(fixture.root, 'src', 'utils', 'secondAny.ts'),
      'export const secondValue = 2 as any\n',
    )

    const compareResult = runLint(fixture.root, fixture.baselinePath)

    expect(compareResult.exitCode).toBe(1)
    expect(compareResult.stderr).toContain('as any 新增 1 处')
    expect(compareResult.stderr).toContain('utils/secondAny.ts:1')
  })

  test('超长 utils 文件会触发长度门禁', () => {
    const longLines = Array.from(
      { length: 801 },
      (_, index) => `export const value${index} = ${index}`,
    )
    const fixture = createFixtureProject({
      'src/utils/tooLong.ts': `${longLines.join('\n')}\n`,
    })

    const result = runLint(fixture.root, fixture.baselinePath, ['--write-baseline'])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain('utils 文件超过 800 行上限（当前 801 行）')
  })

  test('UI 中硬编码用户文本会被拦下，但 i18n key 不会误报', () => {
    const fixture = createFixtureProject({
      'src/components/Greeting.tsx': [
        "import { tSync } from '../i18n/index.js'",
        '',
        'export function Greeting() {',
        "  const title = tSync('greeting.title')",
        '  return (',
        '    <>',
        '      <div title="Hello there">Welcome back</div>',
        '      <span>{title}</span>',
        '    </>',
        '  )',
        '}',
        '',
      ].join('\n'),
      'src/i18n/index.ts': 'export const tSync = (key: string) => key\n',
    })

    const result = runLint(fixture.root, fixture.baselinePath, ['--write-baseline'])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain('JSX 属性 title 存在硬编码用户文本: Hello there')
    expect(result.stderr).toContain('JSX 文本 存在硬编码用户文本: Welcome back')
    expect(result.stderr).not.toContain('greeting.title')
  })
})
