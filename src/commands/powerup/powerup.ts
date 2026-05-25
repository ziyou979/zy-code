import type { LocalCommandCall } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

/**
 * Powerup 课程定义
 */
interface PowerupLesson {
  id: string
  title: string
  tagline: string
  body: string
}

/**
 * 10 节内置课程，覆盖 zy-code 高频但容易被忽略的特性
 */
const LESSONS: PowerupLesson[] = [
  {
    id: 'at-mentions',
    title: 'Talk to your codebase',
    tagline: '@ files, line refs',
    body: [
      '在输入框中用 `@` 模糊匹配文件路径，快速引用上下文。',
      '',
      '**用法：**',
      '- `@src/utils/config` — 引用整个文件',
      '- `@config:42` — 引用 config 文件第 42 行',
      '- `@*.test.ts` — 引用所有测试文件',
      '',
      '**进阶：**',
      '- 拖拽文件到终端也可引用',
      '- 多个 @ 可在一条消息中组合使用',
    ].join('\n'),
  },
  {
    id: 'modes',
    title: 'Steer with modes',
    tagline: 'shift+tab, plan, auto',
    body: [
      '用 `Shift+Tab` 切换权限模式，控制 zy-code 的自主程度。',
      '',
      '**4 种模式：**',
      '- **Ask** — 每步都确认（最安全）',
      '- **Auto-edit** — 自动编辑文件，命令需确认',
      '- **Full-auto** — 完全自主执行',
      '- **Plan** — 只做分析和规划，不执行任何修改',
      '',
      '**进阶：**',
      '- 在消息末尾加 `!` 可临时切换到 full-auto',
      '- `/plan` 可直接进入规划模式',
    ].join('\n'),
  },
  {
    id: 'undo',
    title: 'Undo anything',
    tagline: '/rewind, Esc-Esc',
    body: [
      '随时回退 zy-code 做的更改，不怕出错。',
      '',
      '**用法：**',
      '- `Esc-Esc` — 中断当前操作并撤销最后一步',
      '- `/rewind` — 回退到任意历史节点',
      '- `/clear` — 清空上下文重新开始',
      '',
      '**进阶：**',
      '- 文件编辑会生成 checkpoint，可精确回退到任何一步',
      '- `/branch` 可从历史节点分叉出新对话',
    ].join('\n'),
  },
  {
    id: 'background',
    title: 'Run in the background',
    tagline: 'tasks, /tasks',
    body: [
      '把耗时任务放到后台运行，继续做别的事。',
      '',
      '**用法：**',
      '- 消息末尾加 `&` — 发送后立即进入后台执行',
      '- `/tasks` — 查看所有后台任务状态',
      '- `Ctrl+B` — 将当前对话移入后台',
      '',
      '**进阶：**',
      '- 后台任务完成后会推送通知',
      '- 配合 `--worktree` 可并行处理多个不冲突的任务',
    ].join('\n'),
  },
  {
    id: 'memory',
    title: 'Teach your rules',
    tagline: 'AGENTS.md, /memory',
    body: [
      '用 AGENTS.md 教 zy-code 记住你的编码习惯和项目规范。',
      '',
      '**三级记忆：**',
      '- `~/.zy/AGENTS.md` — 全局规则（影响所有项目）',
      '- `./AGENTS.md` — 项目根目录规则',
      '- `./src/AGENTS.md` — 子目录规则（在该目录工作时生效）',
      '',
      '**进阶：**',
      '- `/memory` 快捷写入规则',
      '- 规则支持 glob 模式匹配文件',
    ].join('\n'),
  },
  {
    id: 'mcp',
    title: 'Extend with tools',
    tagline: 'MCP, /mcp',
    body: [
      '通过 MCP (Model Context Protocol) 接入外部工具和数据源。',
      '',
      '**用法：**',
      '- `/mcp` — 管理已连接的 MCP 服务器',
      '- 项目根目录 `.mcp.json` — 声明项目需要的 MCP 服务器',
      '',
      '**常见场景：**',
      '- 连接数据库查询工具',
      '- 接入 Jira / Linear 等项目管理工具',
      '- 使用浏览器自动化工具测试 Web 应用',
    ].join('\n'),
  },
  {
    id: 'automate',
    title: 'Automate your workflow',
    tagline: 'skills, hooks',
    body: [
      '用 custom skills 和 hooks 自动化重复性工作。',
      '',
      '**Skills（自定义命令）：**',
      '- 在 `.zy/skills/` 下创建 markdown 文件定义新命令',
      '- 可包含 prompt 模板和工具调用',
      '',
      '**Hooks（生命周期钩子）：**',
      '- 在 settings 中定义，工具执行前后自动触发',
      '- 常见用途：自动格式化、自动测试、通知',
      '',
      '**进阶：**',
      '- `/powerup done automate` 标记本课完成后试试创建你的第一个 skill',
    ].join('\n'),
  },
  {
    id: 'subagents',
    title: 'Multiply yourself',
    tagline: 'subagents, /agents',
    body: [
      '启动并行 subagent 同时处理多个子任务。',
      '',
      '**用法：**',
      '- zy-code 会自动判断何时需要拆分为 subagent',
      '- 你也可以明确说"并行处理这些文件"',
      '',
      '**进阶：**',
      '- `--worktree` 标志让 subagent 在独立 git worktree 中工作',
      '- `/agents` 查看当前活跃的 agent 列表',
      '- 适合批量重构、多文件生成等场景',
    ].join('\n'),
  },
  {
    id: 'cross-device',
    title: 'Code from anywhere',
    tagline: '/remote-control, /teleport',
    body: [
      '从手机或其他设备接管当前会话。',
      '',
      '**用法：**',
      '- `/remote-control` — 生成远程控制链接',
      '- `/teleport` — 将当前会话状态转移到另一台设备',
      '',
      '**场景：**',
      '- 下班路上用手机监控后台任务',
      '- 在会议中用平板审查代码',
      '- 在多台电脑间无缝切换',
    ].join('\n'),
  },
  {
    id: 'model-dial',
    title: 'Dial the model',
    tagline: '/model, /effort',
    body: [
      '按需切换模型和思考深度，平衡速度与质量。',
      '',
      '**用法：**',
      '- `/model` — 切换到其他模型',
      '- `/effort` — 调整思考深度（low/medium/high）',
      '',
      '**建议：**',
      '- 简单问题用 compact 模型 + low effort，节省成本',
      '- 复杂架构设计用 advanced 模型 + high effort',
      '- 默认的 standard + medium 适合日常编码',
    ].join('\n'),
  },
]

/**
 * 获取已解锁的课程 id 集合
 */
function getUnlockedSet(): Set<string> {
  const config = getGlobalConfig()
  const unlocked = config.powerupsUnlocked ?? []
  // 过滤掉已不存在的 lesson id
  return new Set(unlocked.filter((lessonId) => LESSONS.some((lesson) => lesson.id === lessonId)))
}

/**
 * 标记课程为已完成并持久化
 */
function markLessonDone(lessonId: string): boolean {
  const existing = getUnlockedSet()
  if (existing.has(lessonId)) {
    return false // 已经完成过
  }
  existing.add(lessonId)
  saveGlobalConfig((config) => ({
    ...config,
    powerupsUnlocked: [...existing],
  }))
  return true
}

/**
 * 渲染进度条
 */
function renderProgressBar(completed: number, total: number, width: number = 16): string {
  const filled = Math.round((completed / total) * width)
  const empty = width - filled
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`
}

/**
 * 格式化课程列表（带进度）
 */
function formatLessonList(unlocked: Set<string>): string {
  const total = LESSONS.length
  const completed = unlocked.size
  const progressBar = renderProgressBar(completed, total)
  const allDone = completed === total

  const lines: string[] = []

  // 标题和进度
  lines.push(allDone ? '## ⚡ All powered up!' : '## ⚡ Power-ups')
  lines.push('')
  lines.push(`${progressBar} **${completed}/${total}** unlocked`)
  lines.push('')

  // 副标题
  if (allDone) {
    lines.push('*Now go build something.*')
  } else {
    lines.push(
      '*Each power-up teaches one thing zy-code can do that most people miss. Open one, read it, try it, mark it done.*',
    )
  }
  lines.push('')

  // 课程列表
  LESSONS.forEach((lesson, index) => {
    const done = unlocked.has(lesson.id)
    const marker = done ? '✓' : '○'
    const number = String(index + 1).padStart(2, ' ')
    lines.push(`  ${number}. [${marker}] **${lesson.title}** — ${lesson.tagline}`)
  })

  lines.push('')
  lines.push('---')
  lines.push('`/powerup <number|id>` 查看详情 · `/powerup done <number|id>` 标记完成')

  return lines.join('\n')
}

/**
 * 格式化单个课程详情
 */
function formatLessonDetail(lesson: PowerupLesson, isUnlocked: boolean): string {
  const badge = isUnlocked ? '✓ 已完成' : '○ 未完成'
  const lines: string[] = []

  lines.push(`## ${lesson.title}`)
  lines.push(`*${lesson.tagline}* · [${badge}]`)
  lines.push('')
  lines.push(lesson.body)
  lines.push('')
  lines.push('---')

  if (!isUnlocked) {
    lines.push(`读完并试过后，运行 \`/powerup done ${lesson.id}\` 标记完成`)
  } else {
    lines.push('*你已完成这节课 ✓*')
  }

  return lines.join('\n')
}

/**
 * 根据编号或关键词匹配课程
 */
function findLesson(query: string): PowerupLesson | undefined {
  const index = parseInt(query, 10)
  if (!Number.isNaN(index) && index >= 1 && index <= LESSONS.length) {
    return LESSONS[index - 1]
  }
  return LESSONS.find((lesson) => lesson.id === query || lesson.title.toLowerCase().includes(query))
}

export const call: LocalCommandCall = async (args) => {
  const trimmedArgs = args.trim().toLowerCase()
  const unlocked = getUnlockedSet()

  // 无参数：显示课程列表
  if (!trimmedArgs) {
    return { type: 'text', value: formatLessonList(unlocked) }
  }

  // done 子命令：标记完成
  if (trimmedArgs.startsWith('done')) {
    const doneQuery = trimmedArgs.slice(4).trim()
    if (!doneQuery) {
      return { type: 'text', value: '⚠️ 请指定要标记完成的课程：`/powerup done <number|id>`' }
    }

    const lesson = findLesson(doneQuery)
    if (!lesson) {
      return { type: 'text', value: `⚠️ 未找到课程: "${doneQuery}"` }
    }

    const isNew = markLessonDone(lesson.id)
    const newUnlocked = getUnlockedSet()
    const allDone = newUnlocked.size === LESSONS.length

    if (!isNew) {
      return { type: 'text', value: `"${lesson.title}" 已经完成过了 ✓` }
    }

    const lines: string[] = []
    lines.push(`✓ **${lesson.title}** — 完成！`)

    if (allDone) {
      lines.push('')
      lines.push('🎉 **All powered up!** 你已解锁所有课程。Now go build something.')
    } else {
      lines.push(`  (${newUnlocked.size}/${LESSONS.length} unlocked)`)
    }

    return { type: 'text', value: lines.join('\n') }
  }

  // 按编号或关键词查看课程详情
  const lesson = findLesson(trimmedArgs)
  if (!lesson) {
    return {
      type: 'text',
      value: `⚠️ 未找到课程: "${trimmedArgs}"。运行 \`/powerup\` 查看全部课程。`,
    }
  }

  return { type: 'text', value: formatLessonDetail(lesson, unlocked.has(lesson.id)) }
}
