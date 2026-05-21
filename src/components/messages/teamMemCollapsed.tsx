import { tSync } from '../../i18n/index.js'
import { Text } from '../../ink.js'
import type { CollapsedReadSearchGroup } from '../../types/message.js'

/**
 * 普通函数（非 React 组件），这样 React Compiler 不会
 * 为了记忆化而提前提升 teamMemory* 属性访问。此模块
 * 仅在 feature('TEAMMEM') 为 true 时加载。
 */
export function checkHasTeamMemOps(message: CollapsedReadSearchGroup): boolean {
  return (
    (message.teamMemorySearchCount ?? 0) > 0 ||
    (message.teamMemoryReadCount ?? 0) > 0 ||
    (message.teamMemoryWriteCount ?? 0) > 0
  )
}

/**
 * 渲染折叠 read/search UI 中的 team memory 计数部分。
 * 此模块仅在 feature('TEAMMEM') 为 true 时加载，
 * 因此 DCE 会在 external 构建中完全移除它。
 */
export function TeamMemCountParts({ message, isActiveGroup, hasPrecedingParts }) {
  const tmReadCount = message.teamMemoryReadCount ?? 0
  const tmSearchCount = message.teamMemorySearchCount ?? 0
  const tmWriteCount = message.teamMemoryWriteCount ?? 0
  if (tmReadCount === 0 && tmSearchCount === 0 && tmWriteCount === 0) {
    return null
  }
  const nodes = []
  let count = hasPrecedingParts ? 1 : 0
  if (tmReadCount > 0) {
    const verbKey = isActiveGroup
      ? count === 0
        ? 'read.first'
        : 'read.sub'
      : count === 0
        ? 'read.done'
        : 'read.doneSub'
    const verb = tSync(`teamMem.${verbKey}`)
    if (count > 0) {
      nodes.push(<Text key="comma-tmr">, </Text>)
    }
    nodes.push(
      <Text key="team-mem-read">
        {verb} {<Text bold={true}>{tmReadCount}</Text>} team{' '}
        {tmReadCount === 1 ? tSync('teamMem.memory_one') : tSync('teamMem.memory_other')}
      </Text>,
    )
    count++
  }
  if (tmSearchCount > 0) {
    const verbKey = isActiveGroup
      ? count === 0
        ? 'search.first'
        : 'search.sub'
      : count === 0
        ? 'search.done'
        : 'search.doneSub'
    const verb_0 = tSync(`teamMem.${verbKey}`)
    if (count > 0) {
      nodes.push(<Text key="comma-tms">, </Text>)
    }
    nodes.push(<Text key="team-mem-search">{`${verb_0} ${tSync('teamMem.memory_other')}`}</Text>)
    count++
  }
  if (tmWriteCount > 0) {
    const verbKey = isActiveGroup
      ? count === 0
        ? 'write.first'
        : 'write.sub'
      : count === 0
        ? 'write.done'
        : 'write.doneSub'
    const verb_1 = tSync(`teamMem.${verbKey}`)
    if (count > 0) {
      nodes.push(<Text key="comma-tmw">, </Text>)
    }
    nodes.push(
      <Text key="team-mem-write">
        {verb_1} {<Text bold={true}>{tmWriteCount}</Text>} team{' '}
        {tmWriteCount === 1 ? tSync('teamMem.memory_one') : tSync('teamMem.memory_other')}
      </Text>,
    )
  }
  return <>{nodes}</>
}
