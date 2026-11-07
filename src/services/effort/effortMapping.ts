import { parseModelCapabilityEntry } from '../settings/localModelCapabilities.js'
import type { PersistableEffortLevel } from './effortTypes.js'

/** 界面输入与文件复用同一档位 schema，并拒绝会被悄悄忽略的未映射强度。 */
export function parseEffortMapping(
  value: string,
): { levels: PersistableEffortLevel[]; map?: Record<string, string> } | undefined {
  try {
    const input: unknown = JSON.parse(value)
    const effort = parseModelCapabilityEntry({
      pattern: 'editor',
      capabilities: { thinking: { effort: input } },
    })?.capabilities.thinking?.effort
    if (!effort) {
      return undefined
    }
    const config = Array.isArray(effort) ? { levels: effort } : effort
    if (!config.levels.length || new Set(config.levels).size !== config.levels.length) {
      return undefined
    }
    // ultra 是应用的思考回传模式，复用 extreme 映射，不是新的平台强度。
    if (
      config.levels.some(
        (level) =>
          level !== 'off' && level !== 'on' && level !== 'ultra' && !config.map?.[level]?.trim(),
      )
    ) {
      return undefined
    }
    if (
      config.map &&
      Object.entries(config.map).some(
        ([level, mapped]) =>
          !(config.levels as readonly string[]).includes(level) ||
          !mapped.trim() ||
          level === 'off' ||
          level === 'ultra',
      )
    ) {
      return undefined
    }
    if (config.levels.includes('ultra') && !config.map?.extreme?.trim()) {
      return undefined
    }
    return {
      ...config,
      ...(config.map
        ? {
            map: Object.fromEntries(
              Object.entries(config.map).map(([level, mapped]) => [level, mapped.trim()]),
            ),
          }
        : {}),
    }
  } catch {
    return undefined
  }
}
