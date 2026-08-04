export const SCHEDULE_WAKEUP_TOOL_NAME = 'ScheduleWakeup'

export const DESCRIPTION = 'Schedule, replace, or stop the next wakeup for a self-paced loop'

export const PROMPT = `Use this tool only for a dynamic /loop that has no fixed interval.

Each loop turn must call ScheduleWakeup again to continue. If you do not call it, the loop ends. There can be only one pending dynamic wakeup per session; scheduling a new one replaces the previous one. Call with stop=true when the task is complete, permanently blocked, or the user asks to stop.

Choose delaySeconds from 60 to 3600 based on the next useful observation. For slow external work, 1200-1800 seconds is a reasonable fallback. Keep prompt stable: it must describe the same loop objective and include <<autonomous-loop-dynamic>> so a later turn can recognize the wakeup as autonomous rather than a new user request.`
