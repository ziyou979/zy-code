import * as React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { Markdown } from '../../components/Markdown.js'
import { Select } from '../../components/CustomSelect/select.js'
import { ProgressBar } from '../../components/design-system/ProgressBar.js'
import { tSync } from '../../i18n/index.js'
import { Box, Text, useInput } from '../../ink.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

interface PowerupLesson {
  id: string
  title: string
  tagline: string
  body: string
}

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

function loadUnlocked(): Set<string> {
  const stored = getGlobalConfig().powerupsUnlocked ?? []
  const valid = new Set(LESSONS.map((l) => l.id))
  return new Set(stored.filter((id) => valid.has(id)))
}

function persistUnlocked(next: Set<string>): void {
  saveGlobalConfig((config) => ({
    ...config,
    powerupsUnlocked: [...next],
  }))
}

type Props = { onDone: LocalJSXCommandOnDone }

function PowerupApp({ onDone }: Props) {
  const [unlocked, setUnlocked] = useState<Set<string>>(() => loadUnlocked())
  const [openLessonId, setOpenLessonId] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string>(LESSONS[0].id)

  const total = LESSONS.length
  const completed = unlocked.size
  const allDone = completed === total

  const close = useCallback(() => {
    onDone(tSync('powerup.closed'), { display: 'system' })
  }, [onDone])

  const markDone = useCallback(
    (id: string) => {
      setUnlocked((prev) => {
        if (prev.has(id)) return prev
        const next = new Set(prev)
        next.add(id)
        persistUnlocked(next)
        return next
      })
    },
    [],
  )

  const options = useMemo(
    () =>
      LESSONS.map((lesson, idx) => {
        const done = unlocked.has(lesson.id)
        const marker = done ? (
          <Text color="success">✓</Text>
        ) : (
          <Text color="inactive">○</Text>
        )
        return {
          value: lesson.id,
          label: (
            <Text>
              [{marker}] <Text bold>{lesson.title}</Text>
            </Text>
          ),
          description: lesson.tagline,
        }
      }),
    [unlocked],
  )

  const openLesson = LESSONS.find((l) => l.id === openLessonId) ?? null

  // eslint-disable-next-line custom-rules/prefer-use-keybindings -- raw y/n/Esc keystrokes inside detail view
  useInput(
    (input, key) => {
      if (!openLesson) return
      if (key.escape || input === 'n' || input === 'N') {
        setOpenLessonId(null)
        return
      }
      if (key.return || input === 'y' || input === 'Y') {
        markDone(openLesson.id)
        setOpenLessonId(null)
      }
    },
    { isActive: openLesson !== null },
  )

  if (openLesson) {
    const isUnlocked = unlocked.has(openLesson.id)
    const badge = isUnlocked ? tSync('powerup.unlockedBadge') : tSync('powerup.todoBadge')
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1} gap={1}>
        <Box flexDirection="column">
          <Text bold>{openLesson.title}</Text>
          <Text color="subtle">
            {openLesson.tagline} · {badge}
          </Text>
        </Box>
        <Markdown>{openLesson.body}</Markdown>
        <Text color="subtle">{tSync('powerup.detailHint')}</Text>
      </Box>
    )
  }

  const progressLabel = tSync('powerup.progressLabel', {
    completed: String(completed),
    total: String(total),
  })

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box flexDirection="row" gap={2}>
        <Text bold>⚡ {allDone ? tSync('powerup.titleAll') : tSync('powerup.title')}</Text>
        <Text color="subtle">{progressLabel}</Text>
      </Box>
      <Box>
        <ProgressBar
          ratio={completed / total}
          width={20}
          fillColor="zy"
          emptyColor="inactive"
        />
      </Box>
      <Box marginTop={1}>
        <Text color="subtle">
          {allDone ? tSync('powerup.subtitleAll') : tSync('powerup.subtitle')}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Select
          options={options}
          defaultFocusValue={focusId}
          onFocus={setFocusId}
          onChange={(id) => setOpenLessonId(id)}
          onCancel={close}
          inlineDescriptions
          visibleOptionCount={LESSONS.length}
        />
      </Box>
    </Box>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: unknown,
  _args?: string,
): Promise<React.ReactNode> {
  return <PowerupApp onDone={onDone} />
}
