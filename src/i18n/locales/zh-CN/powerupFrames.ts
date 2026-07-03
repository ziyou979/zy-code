import type { PowerupFramesMap } from '../../../commands/powerup/frames.js'

/**
 * 演示帧数据（中文）— 课程详情视图里循环播放的"输入 \u2192\uFE0E 响应"小动画。
 * 命令/标志/路径保持英文；说明性输出译成中文。
 */
export const zhPowerupFrames: PowerupFramesMap = {
  atMentions: [
    { prompt: '@src/utils/config 解释一下', response: '读取 config.ts… 加载 ~/.zy/config.json' },
    { prompt: '@config:42 这一行做什么', response: '第 42 行：DEFAULT_THEME = "dark"' },
    { prompt: '@*.test.ts 哪些覆盖 auth', response: '12 个测试文件中 3 个引用了 auth' },
  ],
  modes: [
    { prompt: '[ask] 重构 parser.ts', response: '方案就绪 — 等你确认' },
    { prompt: '[auto-edit] 重构 parser.ts', response: '\u2713\uFE0E 改了 2 个文件 · 测试待跑' },
    { prompt: '[plan] 重构 parser.ts', response: '已起草 4 步方案，未做修改' },
  ],
  undo: [
    { prompt: 'Esc  Esc', response: '已撤销最后一步 · 恢复 2 个文件' },
    { prompt: '/rewind 3', response: '回退 3 轮 · checkpoint 已载入' },
    { prompt: '/branch from #7', response: '从第 7 轮分叉出新对话' },
  ],
  background: [
    { prompt: '跑一遍完整测试 &', response: '\u25b6\uFE0E 任务 #1 已转入后台' },
    { prompt: '/tasks', response: '[#1] tests · 运行中 · 已耗时 2m' },
    { prompt: '(通知弹出)', response: '\u2713\uFE0E 任务 #1 完成 — 184 通过' },
  ],
  memory: [
    { prompt: '/memory 编辑后总是跑 prettier', response: '\u2713\uFE0E 已写入 ./AGENTS.md' },
    { prompt: '(下次会话)', response: '从 AGENTS.md 加载了 3 条规则' },
  ],
  mcp: [
    { prompt: '/mcp add notion', response: '\u2713\uFE0E 连接成功 · 可用 4 个工具' },
    { prompt: '找一下 Q4 OKR 文档', response: '搜 Notion… 已打开 "Q4 OKRs"' },
  ],
  automate: [
    { prompt: '(保存 .zy/skills/deploy.md)', response: '\u2713\uFE0E skill "deploy" 已注册' },
    { prompt: '/deploy staging', response: '构建 \u2192\uFE0E 上传 \u2192\uFE0E 发布 · 完成' },
  ],
  subagents: [
    { prompt: '并行重构所有组件', response: '正在派发 4 个 subagent（worktree）…' },
    { prompt: '/agents', response: '4 运行 · 2 完成 · 0 阻塞' },
  ],
  crossDevice: [
    { prompt: '/remote-control', response: '在手机上打开 https://zy.run/abc' },
    { prompt: '(手机端)', response: '已连接 · 会话已转交' },
  ],
  modelDial: [
    { prompt: '/model standard', response: '已切换到 standard 模型' },
    { prompt: '/effort high', response: 'Effort: high · 启用深度思考' },
  ],
}
