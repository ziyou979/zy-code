import type { PowerupFramesMap } from '../../../commands/powerup/frames.js'

/**
 * 演示帧数据 — 课程详情视图里循环播放的"输入 \u2192\uFE0E 响应"小动画。
 * 帧文案应短、能放进 60 列终端；保持命令/标志原样不译。
 */
export const enPowerupFrames: PowerupFramesMap = {
  atMentions: [
    {
      prompt: '@src/utils/config explain this',
      response: 'Reading config.ts… loads ~/.zy/config.json',
    },
    {
      prompt: '@config:42 what does this line do',
      response: 'Line 42 sets DEFAULT_THEME = "dark"',
    },
    {
      prompt: '@*.test.ts which suites cover auth',
      response: 'Found 3 of 12 test files referencing auth',
    },
  ],
  modes: [
    { prompt: '[ask] refactor parser.ts', response: 'Plan ready — waiting for your OK' },
    {
      prompt: '[auto-edit] refactor parser.ts',
      response: '\u2713\uFE0E rewrote 2 files · tests pending',
    },
    { prompt: '[plan] refactor parser.ts', response: 'Drafted 4-step plan, no edits made' },
  ],
  undo: [
    { prompt: 'Esc  Esc', response: 'Reverted last step · 2 files restored' },
    { prompt: '/rewind 3', response: 'Jumped back 3 turns · checkpoint loaded' },
    { prompt: '/branch from #7', response: 'New conversation forked at turn 7' },
  ],
  background: [
    { prompt: 'run the full test suite &', response: '\u25b6\uFE0E Task #1 started in background' },
    { prompt: '/tasks', response: '[#1] tests · running · 2m elapsed' },
    { prompt: '(notification)', response: '\u2713\uFE0E Task #1 done — 184 passed' },
  ],
  memory: [
    {
      prompt: '/memory always run prettier after edits',
      response: '\u2713\uFE0E Added to ./AGENTS.md',
    },
    { prompt: '(next session)', response: 'Loaded 3 rules from AGENTS.md' },
  ],
  mcp: [
    { prompt: '/mcp add notion', response: '\u2713\uFE0E Connected · 4 tools available' },
    { prompt: 'find the Q4 OKR doc', response: 'Searching Notion… opened "Q4 OKRs"' },
  ],
  automate: [
    { prompt: '(saving .zy/skills/deploy.md)', response: '\u2713\uFE0E Skill "deploy" registered' },
    {
      prompt: '/deploy staging',
      response: 'build \u2192\uFE0E upload \u2192\uFE0E release · done',
    },
  ],
  subagents: [
    {
      prompt: 'refactor every component in parallel',
      response: 'Spawning 4 subagents (worktrees)…',
    },
    { prompt: '/agents', response: '4 running · 2 done · 0 blocked' },
  ],
  crossDevice: [
    { prompt: '/remote-control', response: 'Open https://zy.run/abc on your phone' },
    { prompt: '(from phone)', response: 'Connected · session forwarded' },
  ],
  modelDial: [
    { prompt: '/model standard', response: 'Switched to standard model' },
    { prompt: '/effort high', response: 'Effort: high · deeper reasoning enabled' },
  ],
}
