/**
 * 校验 god file API 表面与提交的 baseline 一致。
 *
 * Phase 4 重构每个 god file 时，预期 diff 此快照应为空（仅当
 * 故意增删 export 才更新）。如果 refactor 误改了 export 集合或
 * 签名，此测试会失败并指出文件。
 *
 * 主动更新快照：bun scripts/api-snapshot.ts
 */
import { test, expect } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { basename } from 'node:path'
import { GOD_FILES, generateSnapshot } from '../../scripts/api-snapshot.js'

for (const file of GOD_FILES) {
  test(`api-snapshot ${basename(file)} matches committed baseline`, () => {
    const snapshotPath = `tests/api-snapshot/${basename(file, '.ts')}.snapshot.txt`
    if (!existsSync(snapshotPath)) {
      throw new Error(
        `Snapshot file ${snapshotPath} missing. Run: bun scripts/api-snapshot.ts`,
      )
    }
    const committed = readFileSync(snapshotPath, 'utf8')
    const actual = generateSnapshot(file)
    expect(actual).toBe(committed)
  })
}
