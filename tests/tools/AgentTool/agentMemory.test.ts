import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  configureRuntimeContext,
  resetRuntimeContext,
} from '../../../src/bootstrap/runtime/runtimeContext.js'
import { isAgentMemoryPath } from '../../../src/tools/AgentTool/agentMemory.js'
import { findCanonicalGitRoot } from '../../../src/services/infra/git.js'
import { sanitizePath } from '../../../src/utils/path.js'

const originalRemoteMemoryDir = process.env.ZY_CODE_REMOTE_MEMORY_DIR

afterEach(() => {
  resetRuntimeContext()
  if (originalRemoteMemoryDir === undefined) {
    delete process.env.ZY_CODE_REMOTE_MEMORY_DIR
  } else {
    process.env.ZY_CODE_REMOTE_MEMORY_DIR = originalRemoteMemoryDir
  }
})

describe('isAgentMemoryPath', () => {
  test('remote local scope 仅接受当前项目的精确目录层级', () => {
    const projectRoot = join(process.cwd(), 'current-project')
    const remoteRoot = join(process.cwd(), 'remote-memory')
    configureRuntimeContext({
      getCwdState: () => projectRoot,
      getOriginalCwd: () => projectRoot,
      getProjectRoot: () => projectRoot,
    })
    process.env.ZY_CODE_REMOTE_MEMORY_DIR = remoteRoot
    const projectKey = sanitizePath(findCanonicalGitRoot(projectRoot) ?? projectRoot)

    expect(
      isAgentMemoryPath(
        join(remoteRoot, 'projects', projectKey, 'agent-memory-local', 'explore', 'MEMORY.md'),
      ),
    ).toBe(true)
    expect(
      isAgentMemoryPath(
        join(remoteRoot, 'projects', 'other-project', 'agent-memory-local', 'explore', 'MEMORY.md'),
      ),
    ).toBe(false)
    expect(
      isAgentMemoryPath(
        join(remoteRoot, 'projects', projectKey, 'nested-agent-memory-local', 'MEMORY.md'),
      ),
    ).toBe(false)
  })

  test('拒绝 agent memory 目录的前缀碰撞路径', () => {
    const projectRoot = join(process.cwd(), 'project-prefix')
    configureRuntimeContext({
      getCwdState: () => projectRoot,
      getOriginalCwd: () => projectRoot,
      getProjectRoot: () => projectRoot,
    })
    delete process.env.ZY_CODE_REMOTE_MEMORY_DIR

    expect(
      isAgentMemoryPath(join(projectRoot, '.zy', 'agent-memory', 'explore', 'MEMORY.md')),
    ).toBe(true)
    expect(
      isAgentMemoryPath(join(projectRoot, '.zy', 'agent-memory-evil', 'explore', 'MEMORY.md')),
    ).toBe(false)
  })

  test('Windows 下 agent memory 路径大小写不影响包含关系', () => {
    if (process.platform !== 'win32') {
      return
    }
    const projectRoot = join(process.cwd(), 'CaseProject')
    configureRuntimeContext({
      getCwdState: () => projectRoot,
      getOriginalCwd: () => projectRoot,
      getProjectRoot: () => projectRoot,
    })
    delete process.env.ZY_CODE_REMOTE_MEMORY_DIR

    expect(
      isAgentMemoryPath(
        join(projectRoot.toUpperCase(), '.ZY', 'AGENT-MEMORY', 'EXPLORE', 'MEMORY.MD'),
      ),
    ).toBe(true)
  })
})
