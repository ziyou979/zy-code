import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

test('URL 和注释标记不截断翻译值，URL 内插值仍参与对称检查', () => {
  const root = mkdtempSync(join(tmpdir(), 'zy-locale-lint-'))
  try {
    const locales = join(root, 'src/i18n/locales')
    for (const locale of ['en', 'zh-CN']) {
      mkdirSync(join(locales, locale), { recursive: true })
      writeFileSync(join(locales, `${locale}.ts`), `export { messages } from './${locale}/misc.js'`)
      writeFileSync(
        join(locales, locale, 'misc.ts'),
        `export const messages = {
        // 'ignored': 'fake',
        'help':
          'https://example.test/{page}',
        'example': '/* literal */',
      }`,
      )
    }
    const run = () =>
      spawnSync(
        process.execPath,
        [resolve(import.meta.dirname, '../../scripts/lint-locale-consistency.ts')],
        {
          env: { ...process.env, ZY_LOCALE_ROOT: root },
          encoding: 'utf8',
        },
      )
    const valid = run()
    expect(valid.status).toBe(0)
    expect(valid.stderr).toContain('2 keys')
    writeFileSync(
      join(locales, 'zh-CN/misc.ts'),
      `export const messages = {
      'help': 'https://example.test/{other}',
      'example': '/* literal */',
    }`,
    )
    const invalid = run()
    expect(invalid.status).toBe(1)
    expect(invalid.stderr).toContain('插值')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 30000)
