// .zy/scheduled_tasks.json 的非 React 调度器核心。
// 由 REPL（通过 useScheduledTasks）和 SDK/-p 模式（print.ts）共享。
//
// 生命周期：轮询 getScheduledTasksEnabled() 直到为 true（CronCreate 运行或 skill
// on: 触发器触发时标志会翻转）→ 加载任务、监听文件并启动 1 秒检查计时器 → 触发时
// 调用 onFire(prompt)。stop() 会完全清理。

import type { FSWatcher } from 'chokidar'
import {
  getScheduledTasksEnabled,
  getSessionCronTasks,
  removeSessionCronTasks,
  setScheduledTasksEnabled,
} from 'src/bootstrap/runtime/runtimeContext.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { cronToHuman } from '../../utils/cron.js'
import {
  type CronJitterConfig,
  type CronTask,
  DEFAULT_CRON_JITTER_CONFIG,
  findMissedTasks,
  getCronFilePath,
  hasCronTasksSync,
  jitteredNextCronRunMs,
  markCronTasksFired,
  oneShotJitteredNextCronRunMs,
  readCronTasks,
  removeCronTasks,
} from '../jobs/cronTasks.js'
import { releaseSchedulerLock, tryAcquireSchedulerLock } from '../jobs/cronTasksLock.js'
import { logForDebugging } from '../../services/infra/debug.js'

const CHECK_INTERVAL_MS = 1000
const FILE_STABILITY_MS = 300
// 非持有会话重新探测调度器锁的频率。时间粒度可较粗，因为只有持有会话崩溃时接管才重要。
const LOCK_PROBE_INTERVAL_MS = 5000
/**
 * 循环任务创建于 `maxAgeMs` 之前、应在下次触发时删除则为 true。永久任务永不过期。
 * `maxAgeMs === 0` 表示无限期（永不过期）。调用时取自
 * {@link CronJitterConfig.recurringMaxAgeMs}。
 * 为便于测试而提取：调度器的 check() 深埋在 setInterval/chokidar/锁机制中。
 */
export function isRecurringTaskAged(t: CronTask, nowMs: number, maxAgeMs: number): boolean {
  if (maxAgeMs === 0) {
    return false
  }
  return Boolean(t.recurring && !t.permanent && nowMs - t.createdAt >= maxAgeMs)
}

type CronSchedulerOptions = {
  /** 任务触发时调用（常规触发或启动时错过）。 */
  onFire: (prompt: string) => void
  /** 为 true 时，触发延后到下一次 tick。 */
  isLoading: () => boolean
  /**
   * 为 true 时，绕过 check() 中的 isLoading 守卫，并自动启用调度器，无需等待
   * setScheduledTasksEnabled()。自动启用是关键部分：assistant 模式在安装时就有
   * scheduled_tasks.json 中的任务，不应等待加载器 skill 翻转标志。#20425 后，
   * isLoading 绕过的重要性较低（assistant 模式现在与正常 REPL 一样在轮次之间空闲）。
   */
  assistantMode?: boolean
  /**
   * 提供时，常规触发会收到完整 CronTask（该次触发不调用 onFire）。这让 daemon
   * 调用方可获取任务 id/cron 等信息，而非只有 prompt 字符串。
   */
  onFireTask?: (task: CronTask) => void
  /**
   * 提供时，初始加载会收到错过的一次性任务（不使用预格式化通知调用 onFire）。
   * 由 daemon 决定如何展示它们。
   */
  onMissed?: (tasks: CronTask[]) => void
  /**
   * 包含 .zy/scheduled_tasks.json 的目录。提供时，调度器不会触及 bootstrap 状态：
   * 不读取 getProjectRoot/getSessionId，且跳过 getScheduledTasksEnabled() 轮询
   * （启动时立即运行 enable()）。Agent SDK daemon 调用方必须提供。
   */
  dir?: string
  /**
   * 写入锁文件的所有者键。默认值为 getSessionId()。daemon 调用方没有会话，必须
   * 传入每进程稳定 UUID。无论如何，PID 仍是存活探针。
   */
  lockIdentity?: string
  /**
   * 返回本次 tick 使用的 cron 抖动配置。每个 check() 周期调用一次。REPL 调用方
   * 传入由 GrowthBook 支持的实现（见 cronJitterConfig.ts）以实现实时调优：ops
   * 可在 :00 负载峰值期间的会话中扩大抖动窗口，无需重启客户端。Agent SDK daemon
   * 调用方不传入该项，使用 DEFAULT_CRON_JITTER_CONFIG；这是安全的，因为 daemon
   * 本就会在配置变更时重启，且可使 growthbook.ts → config.ts → commands.ts → REPL
   * 链不进入 sdk.mjs。
   */
  getJitterConfig?: () => CronJitterConfig
  /**
   * 紧急开关：每次 check() tick 轮询一次。为 true 时，check() 会在触发任何任务前
   * 退出，现有 cron 在会话中立即停止。CLI 调用方注入 `() => !isKairosCronEnabled()`，
   * 因此关闭 zy_kairos_cron gate 可停止已运行的调度器（不只是新调度器）。daemon 调用方
   * 不传入它，理由与 getJitterConfig 相同。
   */
  isKilled?: () => boolean
  /**
   * 在任何副作用前应用的单任务守卫。返回 false 的任务对此调度器不可见：不会触发、
   * 不会写入 `lastFiredAt`、不会删除、不会作为错过任务展示，也不会出现在
   * `getNextFireTime()` 中。daemon cron worker 使用 `t => t.permanent`，以便同一
   * scheduled_tasks.json 中的非永久任务不受影响。
   */
  filter?: (t: CronTask) => boolean
}

export type CronScheduler = {
  start: () => void
  stop: () => void
  /**
   * 所有已加载任务中最早计划触发时间的 Epoch 毫秒值；若没有计划任务（没有任务或
   * 所有任务已在执行中）则为 null。daemon 调用方据此决定是销毁空闲 agent 子进程，
   * 还是为即将发生的触发保持预热。
   */
  getNextFireTime: () => number | null
}

export function createCronScheduler(options: CronSchedulerOptions): CronScheduler {
  const {
    onFire,
    isLoading,
    assistantMode = false,
    onFireTask,
    onMissed,
    dir,
    lockIdentity,
    getJitterConfig,
    isKilled,
    filter,
  } = options
  const lockOpts = dir || lockIdentity ? { dir, lockIdentity } : undefined

  // 仅文件支持的任务。会话任务（durable: false）不在此加载：它们可在会话中途添加/删除
  // 而没有文件事件，因此 check() 会在每次 tick 从 bootstrap 状态重新读取。
  let tasks: CronTask[] = []
  // 每个任务的下次触发时间（Epoch 毫秒）。
  const nextFireAt = new Map<string, number>()
  // 已为其入队“错过任务” prompt 的 ID，防止用户回答前每次文件变更都重复询问。
  const missedAsked = new Set<string>()
  // 当前已入队但尚未从文件移除的任务。防止 removeCronTasks 完成前计时器再次 tick 时
  // 重复触发。
  const inFlight = new Set<string>()

  let enablePoll: ReturnType<typeof setInterval> | null = null
  let checkTimer: ReturnType<typeof setInterval> | null = null
  let lockProbeTimer: ReturnType<typeof setInterval> | null = null
  let watcher: FSWatcher | null = null
  let stopped = false
  let isOwner = false

  async function load(initial: boolean) {
    const next = await readCronTasks(dir)
    if (stopped) {
      return
    }
    tasks = next

    // 仅在初始加载时展示错过任务。由 Chokidar 触发的重新加载将过期任务交给 check()
    // （其从 createdAt 锚定并立即触发）。这避免了对会话中途才过期的任务显示误导性的
    // “ZY 未运行时错过” prompt。循环任务不展示也不删除：check() 能正确处理它们
    // （首次 tick 触发并向前重新计划）。只有错过的一次性任务需要用户输入（现在运行一次
    // 或永久丢弃）。
    if (!initial) {
      return
    }

    const now = Date.now()
    const missed = findMissedTasks(next, now).filter(
      (t) => !t.recurring && !missedAsked.has(t.id) && (!filter || filter(t)),
    )
    if (missed.length > 0) {
      for (const t of missed) {
        missedAsked.add(t.id)
        // 在异步 removeCronTasks + chokidar 重新加载链进行期间，防止 check() 再次触发
        // 原始 prompt。
        nextFireAt.set(t.id, Infinity)
      }
      logEvent('zy_scheduled_task_missed', {
        count: missed.length,
        taskIds: missed
          .map((t) => t.id)
          .join(',') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      if (onMissed) {
        onMissed(missed)
      } else {
        onFire(buildMissedTaskNotification(missed))
      }
      void removeCronTasks(
        missed.map((t) => t.id),
        dir,
      ).catch((e) => logForDebugging(`[ScheduledTasks] failed to remove missed tasks: ${e}`))
      logForDebugging(`[ScheduledTasks] surfaced ${missed.length} missed one-shot task(s)`)
    }
  }

  function check() {
    if (isKilled?.()) {
      return
    }
    if (isLoading() && !assistantMode) {
      return
    }
    const now = Date.now()
    const seen = new Set<string>()
    // 本次 tick 触发的文件支持循环任务。循环后批量调用一次 markCronTasksFired，
    // 使 N 次触发只写入一次。排除会话任务：它们随进程结束，无需持久化。
    const firedFileRecurring: string[] = []
    // 每次 tick 读取一次。REPL 调用方传入由 GrowthBook 支持的 getJitterConfig，
    // 使配置推送无需重启即可生效。Daemon 和 SDK 调用方不传入它，使用
    // DEFAULT_CRON_JITTER_CONFIG（安全：抖动是用于 REPL 集群削峰的 ops 手段，
    // 并非 daemon 所关心的问题）。
    const jitterCfg = getJitterConfig?.() ?? DEFAULT_CRON_JITTER_CONFIG

    // 共享循环体。`isSession` 决定一次性任务的清理路径：会话任务从内存同步移除，
    // 文件任务则经过异步 removeCronTasks + chokidar 重新加载。
    function process(t: CronTask, isSession: boolean) {
      if (filter && !filter(t)) {
        return
      }
      seen.add(t.id)
      if (inFlight.has(t.id)) {
        return
      }

      let next = nextFireAt.get(t.id)
      if (next === undefined) {
        // 首次发现：从 lastFiredAt（循环任务）或 createdAt 锚定。未触发过的循环任务
        // 使用 createdAt：如果 isLoading 使本次 tick 晚于触发时间，从 `now` 锚定会为
        // 固定 cron（`30 14 27 2 *`）计算出下一年。已触发任务使用 lastFiredAt：下方重新
        // 计划会把 `now` 写回磁盘，因此下次进程启动时首次发现会计算出与此处内存设置相同
        // 的 newNext。否则空闲时销毁的 daemon 子进程会丢失 nextFireAt，下次启动从 10 天前
        // 的 createdAt 重新锚定，导致每轮都触发所有任务。
        next = t.recurring
          ? (jitteredNextCronRunMs(t.cron, t.lastFiredAt ?? t.createdAt, t.id, jitterCfg) ??
            Infinity)
          : (oneShotJitteredNextCronRunMs(t.cron, t.createdAt, t.id, jitterCfg) ?? Infinity)
        nextFireAt.set(t.id, next)
        logForDebugging(
          `[ScheduledTasks] scheduled ${t.id} for ${next === Infinity ? 'never' : new Date(next).toISOString()}`,
        )
      }

      if (now < next) {
        return
      }

      logForDebugging(`[ScheduledTasks] firing ${t.id}${t.recurring ? ' (recurring)' : ''}`)
      logEvent('zy_scheduled_task_fire', {
        recurring: t.recurring ?? false,
        taskId: t.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      if (onFireTask) {
        onFireTask(t)
      } else {
        onFire(t.prompt)
      }

      // 过期循环任务落入下方的一次性删除路径（会话任务同步移除；文件任务使用异步
      // inFlight/chokidar 路径）。最后触发一次后移除。
      const aged = isRecurringTaskAged(t, now, jitterCfg.recurringMaxAgeMs)
      if (aged) {
        const ageHours = Math.floor((now - t.createdAt) / 1000 / 60 / 60)
        logForDebugging(
          `[ScheduledTasks] recurring task ${t.id} aged out (${ageHours}h since creation), deleting after final fire`,
        )
        logEvent('zy_scheduled_task_expired', {
          taskId: t.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          ageHours,
        })
      }

      if (t.recurring && !aged) {
        // 循环任务：从 now（而非 next）重新计划，避免会话被阻塞时快速追赶。抖动让每个
        // 周期不落在精确的 :00 时钟边界。
        const newNext = jitteredNextCronRunMs(t.cron, now, t.id, jitterCfg) ?? Infinity
        nextFireAt.set(t.id, newNext)
        // 持久化 lastFiredAt=now，使下次进程启动时首次发现能重建相同的 newNext。
        // 会话任务跳过：它们仅限当前进程。
        if (!isSession) {
          firedFileRecurring.push(t.id)
        }
      } else if (isSession) {
        // 一次性（或过期循环）会话任务：同步从内存移除。不存在 inFlight 窗口：下次 tick
        // 会从不含此 ID 的会话存储读取。
        removeSessionCronTasks([t.id])
        nextFireAt.delete(t.id)
      } else {
        // 一次性（或过期循环）文件任务：从磁盘删除。inFlight 防止异步
        // removeCronTasks + chokidar 重新加载期间重复触发。
        inFlight.add(t.id)
        void removeCronTasks([t.id], dir)
          .catch((e) => logForDebugging(`[ScheduledTasks] failed to remove task ${t.id}: ${e}`))
          .finally(() => inFlight.delete(t.id))
        nextFireAt.delete(t.id)
      }
    }

    // 文件支持的任务：仅在持有调度器锁时处理。该锁用于阻止同一 cwd 中的两个 Zy 会话
    // 重复触发同一磁盘任务。
    if (isOwner) {
      for (const t of tasks) {
        process(t, false)
      }
      // 批量写入 lastFiredAt。inFlight 防止 Chokidar 触发的重新加载期间重复触发
      // （与下方 removeCronTasks 使用同一模式）：重新加载会用刚写入的 lastFiredAt
      // 重设 `tasks`，首次发现会得到与内存中已设置相同的 newNext，因此即使没有
      // inFlight 也具有幂等性。仍然守卫以使语义清晰。
      if (firedFileRecurring.length > 0) {
        for (const id of firedFileRecurring) {
          inFlight.add(id)
        }
        void markCronTasksFired(firedFileRecurring, now, dir)
          .catch((e) => logForDebugging(`[ScheduledTasks] failed to persist lastFiredAt: ${e}`))
          .finally(() => {
            for (const id of firedFileRecurring) {
              inFlight.delete(id)
            }
          })
      }
    }
    // 仅会话任务：进程私有，锁不适用；其他会话看不到它们，也没有重复触发风险。每次 tick
    // 从 bootstrap 状态重新读取（无 chokidar、无 load()）。daemon 路径（`dir !== undefined`）
    // 从不触及 bootstrap 状态，因此跳过。
    if (dir === undefined) {
      for (const t of getSessionCronTasks()) {
        process(t, true)
      }
    }

    if (seen.size === 0) {
      // 本次 tick 没有活动任务：清除整个计划，使 getNextFireTime() 返回 null。下方的
      // 驱逐循环在此不可达（seen 为空），否则陈旧条目会无限保留并使 daemon agent 保持预热。
      nextFireAt.clear()
      return
    }
    // 驱逐不再存在的任务的计划条目。!isOwner 时，文件任务 ID 不在 `seen` 中而被驱逐，
    // 这无害：它们会在首次持有者 tick 时从 createdAt 重新锚定。
    for (const id of nextFireAt.keys()) {
      if (!seen.has(id)) {
        nextFireAt.delete(id)
      }
    }
  }

  async function enable() {
    if (stopped) {
      return
    }
    if (enablePoll) {
      clearInterval(enablePoll)
      enablePoll = null
    }

    const { default: chokidar } = await import('chokidar')
    if (stopped) {
      return
    }

    // 获取每项目调度器锁。只有持有会话运行 check()。其他会话定期探测以在持有者死亡时
    // 接管。防止多个 Zy 共享 cwd 时重复触发。
    isOwner = await tryAcquireSchedulerLock(lockOpts).catch(() => false)
    if (stopped) {
      if (isOwner) {
        isOwner = false
        void releaseSchedulerLock(lockOpts)
      }
      return
    }
    if (!isOwner) {
      lockProbeTimer = setInterval(() => {
        void tryAcquireSchedulerLock(lockOpts)
          .then((owned) => {
            if (stopped) {
              if (owned) {
                void releaseSchedulerLock(lockOpts)
              }
              return
            }
            if (owned) {
              isOwner = true
              if (lockProbeTimer) {
                clearInterval(lockProbeTimer)
                lockProbeTimer = null
              }
            }
          })
          .catch((e) => logForDebugging(String(e), { level: 'error' }))
      }, LOCK_PROBE_INTERVAL_MS)
      lockProbeTimer.unref?.()
    }

    void load(true)

    const path = getCronFilePath(dir)
    watcher = chokidar.watch(path, {
      persistent: false,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: FILE_STABILITY_MS },
      ignorePermissionErrors: true,
    })
    watcher.on('add', () => void load(false))
    watcher.on('change', () => void load(false))
    watcher.on('unlink', () => {
      if (!stopped) {
        tasks = []
        nextFireAt.clear()
      }
    })

    checkTimer = setInterval(check, CHECK_INTERVAL_MS)
    // 不要仅因调度器就保持进程存活：在 -p 文本模式中，即使创建了 cron，进程也应在单轮后退出。
    checkTimer.unref?.()
  }

  return {
    start() {
      stopped = false
      // Daemon 路径（显式提供 dir）：不触及 bootstrap 状态，因为
      // getScheduledTasksEnabled() 会读取从未初始化的标志。daemon 请求调度，直接启用。
      if (dir !== undefined) {
        logForDebugging(
          `[ScheduledTasks] scheduler start() — dir=${dir}, hasTasks=${hasCronTasksSync(dir)}`,
        )
        void enable()
        return
      }
      logForDebugging(
        `[ScheduledTasks] scheduler start() — enabled=${getScheduledTasksEnabled()}, hasTasks=${hasCronTasksSync()}`,
      )
      // scheduled_tasks.json 有记录时自动启用。CronCreateTool 也会在会话中途创建任务时设置它。
      if (!getScheduledTasksEnabled() && (assistantMode || hasCronTasksSync())) {
        setScheduledTasksEnabled(true)
      }
      if (getScheduledTasksEnabled()) {
        void enable()
        return
      }
      enablePoll = setInterval(
        (en) => {
          if (getScheduledTasksEnabled()) {
            void en()
          }
        },
        CHECK_INTERVAL_MS,
        enable,
      )
      enablePoll.unref?.()
    },
    stop() {
      stopped = true
      if (enablePoll) {
        clearInterval(enablePoll)
        enablePoll = null
      }
      if (checkTimer) {
        clearInterval(checkTimer)
        checkTimer = null
      }
      if (lockProbeTimer) {
        clearInterval(lockProbeTimer)
        lockProbeTimer = null
      }
      void watcher?.close()
      watcher = null
      if (isOwner) {
        isOwner = false
        void releaseSchedulerLock(lockOpts)
      }
    },
    getNextFireTime() {
      // nextFireAt 对“永不”（执行中的一次性任务、错误 cron 字符串）使用 Infinity。过滤它们，
      // 使调用方可区分“即将发生”和“没有待处理项”。
      let min = Infinity
      for (const t of nextFireAt.values()) {
        if (t < min) {
          min = t
        }
      }
      return min === Infinity ? null : min
    },
  }
}

/**
 * 构建错过任务的通知文本。指导语位于任务列表之前，列表包裹在代码围栏中，使多行祈使
 * prompt 不会被解释为立即指令，从而避免自我注入的 prompt injection。完整 prompt 正文
 * 会被保留：此路径确实需要模型在用户确认后执行 prompt，并且模型看到此通知前任务已从 JSON 删除。
 */
export function buildMissedTaskNotification(missed: CronTask[]): string {
  const plural = missed.length > 1
  const header =
    `The following one-shot scheduled task${plural ? 's were' : ' was'} missed while Zy was not running. ` +
    `${plural ? 'They have' : 'It has'} already been removed from .zy/scheduled_tasks.json.\n\n` +
    `Do NOT execute ${plural ? 'these prompts' : 'this prompt'} yet. ` +
    `First use the AskUserQuestion tool to ask whether to run ${plural ? 'each one' : 'it'} now. ` +
    `Only execute if the user confirms.`

  const blocks = missed.map((t) => {
    const meta = `[${cronToHuman(t.cron)}, created ${new Date(t.createdAt).toLocaleString()}]`
    // 使用比 prompt 中任意反引号连续段多一个的围栏，以使包含 ``` 的 prompt 无法提前关闭
    // 围栏并取消包裹尾随文本（CommonMark 围栏匹配规则）。
    const longestRun = (t.prompt.match(/`+/g) ?? []).reduce(
      (max: number, run: string) => Math.max(max, run.length),
      0,
    )
    const fence = '`'.repeat(Math.max(3, longestRun + 1))
    return `${meta}\n${fence}\n${t.prompt}\n${fence}`
  })

  return `${header}\n\n${blocks.join('\n\n')}`
}
