import { describe, expect, test } from 'bun:test'
import { buildLoopPrompt } from '../../src/skills/bundled/loop.js'

describe('/loop 路由', () => {
  test('显式前置间隔使用固定 cron', () => {
    const prompt = buildLoopPrompt('5m check the deploy')
    expect(prompt).toContain('schedule a recurring prompt')
    expect(prompt).toContain('CronCreate')
    expect(prompt).not.toContain('autonomous-loop-dynamic')
  })

  test('尾部 every 间隔使用固定 cron', () => {
    expect(buildLoopPrompt('check the deploy every 20 minutes')).toContain(
      'schedule a recurring prompt',
    )
  })

  test('无间隔时使用动态续租', () => {
    const prompt = buildLoopPrompt('check the deploy')
    expect(prompt).toContain('dynamic self-paced loop')
    expect(prompt).toContain('ScheduleWakeup')
    expect(prompt).toContain('<<autonomous-loop-dynamic>>')
  })

  test('空输入仅返回用法', () => {
    expect(buildLoopPrompt('   ')).toContain('Usage: /loop')
  })
})
