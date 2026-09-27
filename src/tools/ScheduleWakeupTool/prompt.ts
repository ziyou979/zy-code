export const SCHEDULE_WAKEUP_TOOL_NAME = 'ScheduleWakeup'

export const DESCRIPTION = 'Schedule, replace, or stop the next wakeup for a self-paced loop'

export const PROMPT = `Use this tool only for a dynamic /loop that has no fixed interval.

Each loop turn must call ScheduleWakeup again to continue. If you do not call it, the loop ends. There can be only one pending dynamic wakeup per session; scheduling a new one replaces the previous one. Call with stop=true when the task is complete, permanently blocked, or the user asks to stop.

Choose delaySeconds from 60 to 3600 based on the next useful observation. For slow external work, 1200-1800 seconds is a reasonable fallback. Keep prompt stable: it must describe the same loop objective and include <<autonomous-loop-dynamic>> so a later turn can recognize the wakeup as autonomous rather than a new user request.

Unless stop=true, every call must provide delaySeconds, a non-empty reason explaining why that delay is the next useful observation time, and a non-empty prompt containing <<autonomous-loop-dynamic>>. Keep the prompt focused on the same objective and preserve the user's constraints. With stop=true, these fields may be omitted.

For monitoring loops, unless the user requests periodic status reports, keep unchanged or non-actionable checks quiet. Notify the user when there is a meaningful change, completion, failure, or required user action. Keep this notification intent in the stable prompt carried to the next wakeup.

Set noop=true only after a completed observation found no meaningful change, made no changes, and needs no user-facing report. Never use it for failed checks, errors, completed objectives, or requests for user action. It is a display hint, not a way to skip the check or stop the loop. Omit it or use false when there is progress. Consecutive quiet read-only checks may be collapsed in the normal UI; the full transcript remains available.`
