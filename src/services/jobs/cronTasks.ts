// 定时 prompt，存储于 <project>/.zy/scheduled_tasks.json。
//
// 任务分为两类：
//   - 单次任务（recurring: false/undefined）：触发一次后自动删除。
//   - 周期任务（recurring: true）：按计划触发，再从当前时间重新安排；持续存在，
//     直至通过 CronDelete 显式删除，或达到可配置上限后自动过期。
//
// 文件格式：
//   { "tasks": [{ id, cron, prompt, createdAt, recurring?, permanent? }] }

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  addSessionCronTask,
  getSessionCronTasks,
  getProjectRoot,
  removeSessionCronTasks,
} from 'src/bootstrap/runtime/runtimeContext.js'
import { computeNextCronRun, parseCronExpression } from '../../utils/cron.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { isFsInaccessible } from '../../utils/errors.js'
import { getFsImplementation } from '../../services/infra/fsOperations.js'
import { safeParseJSON } from '../../utils/json.js'
import { logError } from '../../services/infra/log.js'
import { jsonStringify } from '../../services/infra/slowOperations.js'

export type CronTask = {
  id: string
  /** 5 字段 cron 字符串（本地时间）；写入时校验，读取时再次校验。 */
  cron: string
  /** 任务触发时入队的 prompt。 */
  prompt: string
  /** 任务创建时的 epoch 毫秒数，用作漏执行检测锚点。 */
  createdAt: number
  /**
   * 最近一次触发的 epoch 毫秒数。每次周期触发后由 scheduler 写回，使下一次触发
   * 计算可跨进程重启。scheduler 以 `lastFiredAt ?? createdAt` 为首次锚点：从未触发
   * 的任务使用 createdAt；已触发任务则重建上个进程内相同的 `nextFireAt`。
   * 单次任务不设置，因为触发后即删除。
   */
  lastFiredAt?: number
  /** 为 true 时，任务触发后重新安排，而非删除。 */
  recurring?: boolean
  /**
   * 为 true 时不受 recurringMaxAgeMs 自动过期限制。供 assistant 模式内置任务
   *（catch-up/morning-checkin/dream）使用的系统逃生口；installer 的
   * writeIfMissing() 会跳过已有文件，重装无法重建这些任务。不能通过 CronCreateTool
   * 设置，只能由 src/assistant/install.ts 直接写入 scheduled_tasks.json。
   */
  permanent?: boolean
  /**
   * 仅运行时 flag。false 表示会话级，绝不写入磁盘。文件任务保持 undefined；
   * writeCronTasks 会移除该字段，使磁盘格式保持不变。
   */
  durable?: boolean
  /**
   * 仅运行时。设置后表示任务由进程内 teammate 创建，scheduler 会将触发事件路由到
   * 该 teammate 队列，而非主 REPL。绝不写入磁盘，因为 teammate cron 始终仅限会话。
   */
  agentId?: string
}

type CronFile = { tasks: CronTask[] }

const CRON_FILE_REL = join('.zy', 'scheduled_tasks.json')

/**
 * cron 文件路径。`dir` 默认取 getProjectRoot()；不经过 main.tsx 的上下文
 *（如没有 bootstrap state 的 Agent SDK daemon）应显式传入。
 */
export function getCronFilePath(dir?: string): string {
  return join(dir ?? getProjectRoot(), CRON_FILE_REL)
}

/**
 * 读取并解析 .zy/scheduled_tasks.json。文件缺失、为空或格式错误时返回空任务列表。
 * cron 字符串无效的任务会静默丢弃并记录 debug 日志，避免单个坏条目阻塞整个文件。
 */
export async function readCronTasks(dir?: string): Promise<CronTask[]> {
  const fs = getFsImplementation()
  let raw: string
  try {
    raw = await fs.readFile(getCronFilePath(dir), { encoding: 'utf-8' })
  } catch (e: unknown) {
    if (isFsInaccessible(e)) {
      return []
    }
    logError(e)
    return []
  }

  const parsed = safeParseJSON(raw, false)
  if (!parsed || typeof parsed !== 'object') {
    return []
  }
  const file = parsed as Partial<CronFile>
  if (!Array.isArray(file.tasks)) {
    return []
  }

  const out: CronTask[] = []
  for (const t of file.tasks) {
    if (
      !t ||
      typeof t.id !== 'string' ||
      typeof t.cron !== 'string' ||
      typeof t.prompt !== 'string' ||
      typeof t.createdAt !== 'number'
    ) {
      logForDebugging(`[ScheduledTasks] skipping malformed task: ${jsonStringify(t)}`)
      continue
    }
    if (!parseCronExpression(t.cron)) {
      logForDebugging(`[ScheduledTasks] skipping task ${t.id} with invalid cron '${t.cron}'`)
      continue
    }
    out.push({
      id: t.id,
      cron: t.cron,
      prompt: t.prompt,
      createdAt: t.createdAt,
      ...(typeof t.lastFiredAt === 'number' ? { lastFiredAt: t.lastFiredAt } : {}),
      ...(t.recurring ? { recurring: true } : {}),
      ...(t.permanent ? { permanent: true } : {}),
    })
  }
  return out
}

/**
 * 同步检查 cron 文件是否有有效任务。cronScheduler.start() 据此决定是否自动启用；
 * 只读取一次文件。
 */
export function hasCronTasksSync(dir?: string): boolean {
  let raw: string
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs -- called once from cronScheduler.start()
    raw = readFileSync(getCronFilePath(dir), 'utf-8')
  } catch {
    return false
  }
  const parsed = safeParseJSON(raw, false)
  if (!parsed || typeof parsed !== 'object') {
    return false
  }
  const tasks = (parsed as Partial<CronFile>).tasks
  return Array.isArray(tasks) && tasks.length > 0
}

/**
 * 用指定任务覆盖 .zy/scheduled_tasks.json；.zy/ 缺失时创建。空任务列表写入空文件
 * 而非删除，使 file watcher 能在最后一个任务移除时看到 change event。
 */
export async function writeCronTasks(tasks: CronTask[], dir?: string): Promise<void> {
  const root = dir ?? getProjectRoot()
  await mkdir(join(root, '.zy'), { recursive: true })
  // 移除仅运行时 `durable` flag；磁盘内容按定义均持久化。排除该字段可让
  // readCronTasks() 自然得到 durable: undefined，无需显式设置。
  const body: CronFile = {
    tasks: tasks.map(({ durable: _durable, ...rest }) => rest),
  }
  await writeFile(getCronFilePath(root), `${jsonStringify(body, null, 2)}\n`, 'utf-8')
}

/**
 * 追加任务并返回生成的 id。调用方负责预先校验 cron 字符串，tool 通过
 * validateInput 完成此操作。
 *
 * `durable` 为 false 时任务仅保存在进程内存（会话运行时状态），本会话中按计划
 * 触发，但不写入 .zy/scheduled_tasks.json，并随进程结束。scheduler 直接将会话
 * 任务合并到 tick loop，无需文件 change event。
 */
export async function addCronTask(
  cron: string,
  prompt: string,
  recurring: boolean,
  durable: boolean,
  agentId?: string,
): Promise<string> {
  // 使用短 ID；MAX_JOBS=50 时 8 位十六进制已足够，也避免 tool 层与磁盘间反复
  // 处理 slice/prefix。
  const id = randomUUID().slice(0, 8)
  const task = {
    id,
    cron,
    prompt,
    createdAt: Date.now(),
    ...(recurring ? { recurring: true } : {}),
  }
  if (!durable) {
    addSessionCronTask({ ...task, ...(agentId ? { agentId } : {}) })
    return id
  }
  const tasks = await readCronTasks()
  tasks.push(task)
  await writeCronTasks(tasks)
  return id
}

/**
 * 按 id 移除任务。没有匹配项时不执行操作，如另一会话抢先处理。
 * 同时用于单次触发清理和显式 CronDelete。
 *
 * 以 `dir` undefined（REPL 路径）调用时也扫描内存会话存储，因为调用方不知道 id
 * 位于哪个存储。Daemon 调用方显式传入 `dir`，没有会话；`dir !== undefined`
 * 守卫可避免该路径访问 bootstrap state，测试会保证这一点。
 */
export async function removeCronTasks(ids: string[], dir?: string): Promise<void> {
  if (ids.length === 0) {
    return
  }
  // 先扫描会话存储。全部 id 都在那里处理后即可结束，完全跳过文件读取。
  // removeSessionCronTasks 未命中时不操作并返回 0，因此已有持久删除路径可直接继续，
  // 不产生分配。
  if (dir === undefined && removeSessionCronTasks(ids) === ids.length) {
    return
  }
  const idSet = new Set(ids)
  const tasks = await readCronTasks(dir)
  const remaining = tasks.filter((t) => !idSet.has(t.id))
  if (remaining.length === tasks.length) {
    return
  }
  await writeCronTasks(remaining, dir)
}

/**
 * 为指定周期任务写入 `lastFiredAt` 并回写。采用批处理，使一个 scheduler tick 中
 * N 次触发只需一次读改写，而非 N 次。仅处理文件任务；会话任务随进程结束，
 * 无需持久化触发时间。没有 id 匹配时不操作，说明任务在触发与写入间已被删除。
 *
 * scheduler 锁确保最多一个进程调用。chokidar 捕获写入并触发 reload，从刚写入的
 * `lastFiredAt` 重新生成 `nextFireAt`；该操作幂等，相同计算得到相同结果。
 */
export async function markCronTasksFired(
  ids: string[],
  firedAt: number,
  dir?: string,
): Promise<void> {
  if (ids.length === 0) {
    return
  }
  const idSet = new Set(ids)
  const tasks = await readCronTasks(dir)
  let changed = false
  for (const t of tasks) {
    if (idSet.has(t.id)) {
      t.lastFiredAt = firedAt
      changed = true
    }
  }
  if (!changed) {
    return
  }
  await writeCronTasks(tasks, dir)
}

/**
 * 合并文件任务和仅会话任务。会话任务设置 `durable: false` 供调用方区分；
 * 文件任务原样返回，durable 为 undefined。
 *
 * 仅在 `dir` 为 undefined 时合并；显式传入 `dir` 的 daemon 调用方没有会话存储。
 */
export async function listAllCronTasks(dir?: string): Promise<CronTask[]> {
  const fileTasks = await readCronTasks(dir)
  if (dir !== undefined) {
    return fileTasks
  }
  const sessionTasks = getSessionCronTasks().map((t) => ({
    ...t,
    durable: false as const,
  }))
  return [...fileTasks, ...sessionTasks]
}

/**
 * cron 字符串在 `fromMs` 之后的下一触发 epoch 毫秒数。无效或未来 366 天内
 * 无匹配时返回 null。
 */
export function nextCronRunMs(cron: string, fromMs: number): number | null {
  const fields = parseCronExpression(cron)
  if (!fields) {
    return null
  }
  const next = computeNextCronRun(fields, new Date(fromMs))
  return next ? next.getTime() : null
}

/**
 * cron scheduler 调优参数。运行时来自 `zy_kairos_cron_config` GrowthBook JSON
 * 配置（见 cronJitterConfig.ts），使运维无需发布客户端构建即可全局调整行为。
 * 此处默认值精确保留引入配置前的行为。
 */
export type CronJitterConfig = {
  /** 周期任务向后延迟占两次触发间隔的比例。 */
  recurringFrac: number
  /** 周期向后延迟上限，不受间隔长度影响。 */
  recurringCapMs: number
  /** 单次任务向前提前量：最多可提前的毫秒数。 */
  oneShotMaxMs: number
  /**
   * 单次任务向前提前量：minute-mod gate 匹配时至少提前的毫秒数。0 表示 hash 接近
   * 零的 taskId 会在精确时间点触发；提高该值可保证没有任务落在时钟边界。
   */
  oneShotFloorMs: number
  /**
   * 对满足 `minute % N === 0` 的分钟触发增加 jitter。30 对应 :00/:30，
   * 15 对应 :00/:15/:30/:45，1 对应每分钟。
   */
  oneShotMinuteMod: number
  /**
   * 周期任务创建后经过该毫秒数自动过期，除非标记 `permanent`。cron 是多日会话
   * 的主要驱动因素，无界周期会让 Tier-1 heap 泄漏无限累积。默认 7 天可覆盖
   * “本周每小时检查 PR”等流程，同时限制最坏会话寿命。assistant 模式的
   * permanent 任务永不过期，因为删除后 install.ts 的 writeIfMissing() 无法重建。
   *
   * `0` 表示无限制，任务永不自动过期。
   */
  recurringMaxAgeMs: number
}

export const DEFAULT_CRON_JITTER_CONFIG: CronJitterConfig = {
  recurringFrac: 0.1,
  recurringCapMs: 15 * 60 * 1000,
  oneShotMaxMs: 90 * 1000,
  oneShotFloorMs: 0,
  oneShotMinuteMod: 30,
  recurringMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
}

/**
 * taskId 是 8 位十六进制 UUID 切片（见 {@link addCronTask}），解析为 u32 后映射到
 * [0, 1)。跨重启稳定，并在全局均匀分布。非十六进制 id（手工编辑 JSON）退回 0，
 * 即无 jitter。
 */
function jitterFrac(taskId: string): number {
  const frac = parseInt(taskId.slice(0, 8), 16) / 0x1_0000_0000
  return Number.isFinite(frac) ? frac : 0
}

/**
 * 与 {@link nextCronRunMs} 相同，但增加确定性的每任务延迟，避免大量会话安排同一
 * cron 字符串时出现惊群，例如 `0 * * * *` 使所有任务在 :00 调用 inference。
 *
 * 延迟与当前触发间隔成比例（{@link CronJitterConfig.recurringFrac}，上限为
 * {@link CronJitterConfig.recurringCapMs}）。默认值下，每小时任务分散在
 * [:00, :06)，每分钟任务只分散几秒。
 * seconds.
 *
 * 仅用于周期任务。单次任务使用 {@link oneShotJitteredNextCronRunMs}，
 * 即向前 jitter，并受分钟 gate 控制。
 */
export function jitteredNextCronRunMs(
  cron: string,
  fromMs: number,
  taskId: string,
  cfg: CronJitterConfig = DEFAULT_CRON_JITTER_CONFIG,
): number | null {
  const nextRunMs = nextCronRunMs(cron, fromMs)
  if (nextRunMs === null) {
    return null
  }
  const followingRunMs = nextCronRunMs(cron, nextRunMs)
  // 未来一年内没有第二次匹配（如固定日期）时，无间隔可用于计算比例，且几乎没有
  // 惊群风险，直接在 nextRunMs 触发。
  if (followingRunMs === null) {
    return nextRunMs
  }
  const jitter = Math.min(
    jitterFrac(taskId) * cfg.recurringFrac * (followingRunMs - nextRunMs),
    cfg.recurringCapMs,
  )
  return nextRunMs + jitter
}

/**
 * 与 {@link nextCronRunMs} 相同，但触发时间落在匹配
 * {@link CronJitterConfig.oneShotMinuteMod} 的分钟边界时，减去确定性的每任务提前量。
 *
 * 单次任务由用户固定（如“下午 3 点提醒我”），延迟会破坏约定；稍早触发难以察觉，
 * 却可分散所有人选择整点造成的 inference 峰值。默认值（mod 30、最大 90 秒、
 * 下限 0）仅对 :00 和 :30 增加 jitter，因为人们常取整到半小时。
 *
 * 事故期间，运维可推送 `zy_kairos_cron_config`，例如
 * `{oneShotMinuteMod: 15, oneShotMaxMs: 300000, oneShotFloorMs: 30000}` to
 * 将 :00/:15/:30/:45 的触发分散到 [t-5min, t-30s] 窗口；每个任务至少提前
 * 30 秒，因此不会落在精确时间点。
 *
 * 检查计算后的触发时间而非 cron 字符串，因此 `0 15 * * *`、步进表达式和
 * `0,30 9 * * *` 落在匹配分钟时都会获得 jitter。结果钳制到 `fromMs`，避免任务
 * 在自身 jitter 窗口内创建时早于创建时间触发。
 */
export function oneShotJitteredNextCronRunMs(
  cron: string,
  fromMs: number,
  taskId: string,
  cfg: CronJitterConfig = DEFAULT_CRON_JITTER_CONFIG,
): number | null {
  const nextRunMs = nextCronRunMs(cron, fromMs)
  if (nextRunMs === null) {
    return null
  }
  // cron 分辨率为 1 分钟，计算时间的秒始终为 :00，因此检查分钟字段即可识别热点。
  // 使用本地 getMinutes() 而非 getUTCMinutes()：cron 按本地时间评估，用户选择的
  // 整点是其时区中的整点。半小时时差地区中，本地 :00 对应 UTC :30，使用 UTC
  // 会对错误时间点增加 jitter。
  if (new Date(nextRunMs).getMinutes() % cfg.oneShotMinuteMod !== 0) {
    return nextRunMs
  }
  // floor + frac * (max - floor) 在 [floor, max) 上均匀分布。floor=0 时退化为原始
  // frac * max；floor>0 时即使 taskId hash 为 0 也会提前 `floor` ms，不会精确触发。
  const lead = cfg.oneShotFloorMs + jitterFrac(taskId) * (cfg.oneShotMaxMs - cfg.oneShotFloorMs)
  // nextCronRunMs 保证 nextRunMs > fromMs，因此仅当任务在自身提前窗口内创建时，
  // max() 才会生效。
  return Math.max(nextRunMs - lead, fromMs)
}

/**
 * 从 createdAt 计算的下一计划时间已过去时，任务视为“missed”，并在启动时告知用户。
 * 同时适用于单次和周期任务；ZY 停止期间错过窗口的周期任务同样为 missed。
 */
export function findMissedTasks(tasks: CronTask[], nowMs: number): CronTask[] {
  return tasks.filter((t) => {
    const next = nextCronRunMs(t.cron, t.createdAt)
    return next !== null && next < nowMs
  })
}
