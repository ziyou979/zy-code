import { describe, expect, test } from 'bun:test'

describe('briefGate', () => {
  test('设置模块加载后仍能取得完整门控导出', () => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        '--feature=KAIROS',
        '-e',
        "await import('./src/components/Settings/Config.tsx'); const gate = require('./src/tools/BriefTool/briefGate.js'); console.log(typeof gate.isBriefEntitled, typeof gate.isBriefEnabled)",
      ],
      {
        cwd: process.cwd(),
        stderr: 'pipe',
        stdout: 'pipe',
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr.toString()).toBe('')
    expect(result.stdout.toString().trim()).toBe('function function')
  }, 15_000)
})
