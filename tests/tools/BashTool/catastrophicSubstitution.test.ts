/**
 * checkCatastrophicInsideSubstitutions 测试：命令替换内灾难性删除检测。
 *
 * 验证 P0-1：在 $(...)、`...`、<(...) 中检测 rm/rmdir 危险路径，
 * 即使在 bypassPermissions/auto 模式下也应强制 ask。
 */
import { describe, expect, test } from 'bun:test'
import { checkCatastrophicInsideSubstitutions } from '../../../src/tools/BashTool/pathValidation.js'

describe('checkCatastrophicInsideSubstitutions', () => {
  // ── 无替换 → passthrough ───────────────────────────────────────────────

  test('无命令替换 → passthrough', () => {
    const r = checkCatastrophicInsideSubstitutions('ls -la', '/home/user')
    expect(r.behavior).toBe('passthrough')
  })

  test('普通 rm（无替换）→ passthrough', () => {
    const r = checkCatastrophicInsideSubstitutions('rm file.txt', '/home/user')
    expect(r.behavior).toBe('passthrough')
  })

  test('rm 普通路径在 $() 内 → passthrough', () => {
    const r = checkCatastrophicInsideSubstitutions('echo $(rm /tmp/foo)', '/home/user')
    expect(r.behavior).toBe('passthrough')
  })

  // ── $() 内灾难性删除 → ask ────────────────────────────────────────────

  test('$() 内 rm -rf / → ask', () => {
    const r = checkCatastrophicInsideSubstitutions('echo $(rm -rf /)', '/home/user')
    expect(r.behavior).toBe('ask')
    expect(r.decisionReason?.type).toBe('safetyCheck')
    expect(r.decisionReason).toHaveProperty('classifierApprovable', false)
  })

  test('$() 内 rmdir ~ → ask', () => {
    const r = checkCatastrophicInsideSubstitutions('echo $(rmdir ~)', '/home/user')
    expect(r.behavior).toBe('ask')
  })

  test('$() 内 rm -rf /etc → ask', () => {
    const r = checkCatastrophicInsideSubstitutions('echo $(rm -rf /etc)', '/home/user')
    expect(r.behavior).toBe('ask')
  })

  test('$() 内 rm -rf $UNSET/* → ask（展开为 / *）', () => {
    const r = checkCatastrophicInsideSubstitutions('echo $(rm -rf /*)', '/home/user')
    expect(r.behavior).toBe('ask')
  })

  // ── 反引号内灾难性删除 → ask ──────────────────────────────────────────

  test('反引号内 rm -rf / → ask', () => {
    const r = checkCatastrophicInsideSubstitutions('echo `rm -rf /`', '/home/user')
    expect(r.behavior).toBe('ask')
  })

  test('反引号内 rm -rf ~ → ask', () => {
    const r = checkCatastrophicInsideSubstitutions('echo `rm -rf ~`', '/home/user')
    expect(r.behavior).toBe('ask')
  })

  // ── <() 内灾难性删除 → ask ──────────────────────────────────────────

  test('<() 内 rm -rf / → ask', () => {
    const r = checkCatastrophicInsideSubstitutions('cat <(rm -rf /)', '/home/user')
    expect(r.behavior).toBe('ask')
  })

  // ── 复合命令内检测 ────────────────────────────────────────────────────

  test('$() 内复合命令 cd /tmp && rm -rf / → ask', () => {
    const r = checkCatastrophicInsideSubstitutions('echo $(cd /tmp && rm -rf /)', '/home/user')
    expect(r.behavior).toBe('ask')
  })

  test('$() 内复合命令 rm -rf /; echo done → ask', () => {
    const r = checkCatastrophicInsideSubstitutions('echo $(rm -rf /; echo done)', '/home/user')
    expect(r.behavior).toBe('ask')
  })

  // ── 嵌套 / 过多替换 ──────────────────────────────────────────────────

  test('64+ 替换 + 含 rm → ask', () => {
    // 构造 65 个替换
    const subs = Array.from({ length: 65 }, (_, i) => `$(echo ${i})`).join(' ')
    const cmd = `rm -rf ${subs}`
    const r = checkCatastrophicInsideSubstitutions(cmd, '/home/user')
    expect(r.behavior).toBe('ask')
  })

  test('64+ 替换但不含 rm → passthrough', () => {
    const subs = Array.from({ length: 65 }, (_, i) => `$(echo ${i})`).join(' ')
    const cmd = `ls ${subs}`
    const r = checkCatastrophicInsideSubstitutions(cmd, '/home/user')
    expect(r.behavior).toBe('passthrough')
  })

  // ── 边界：安全路径在 $() 内 → passthrough ────────────────────────────

  test('$() 内 rm 临时文件 → passthrough', () => {
    const r = checkCatastrophicInsideSubstitutions('echo $(rm /tmp/myapp-temp-123)', '/home/user')
    expect(r.behavior).toBe('passthrough')
  })

  test('$() 内 rm 当前目录相对路径 → passthrough', () => {
    const r = checkCatastrophicInsideSubstitutions('echo $(rm ./foo.txt)', '/home/user')
    expect(r.behavior).toBe('passthrough')
  })

  test('$() 内 rm 项目路径 → passthrough', () => {
    const r = checkCatastrophicInsideSubstitutions(
      'echo $(rm /home/user/project/dist)',
      '/home/user',
    )
    expect(r.behavior).toBe('passthrough')
  })
})
