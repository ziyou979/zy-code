import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getCwd } from '../../utils/cwd.js'
import { parseMeta, type WorkflowMeta } from './runtime/sandbox.js'

const MAX_SCRIPT_BYTES = 524288

export interface WorkflowDefinition {
  name: string
  description: string
  whenToUse?: string
  source: 'user' | 'project'
  filePath: string
  meta: WorkflowMeta
}

function getUserWorkflowsDir(): string {
  return join(homedir(), '.zy', 'workflows')
}

function getProjectWorkflowsDir(): string {
  return join(getCwd(), 'workflows')
}

function scanDirectory(dir: string, source: 'user' | 'project'): WorkflowDefinition[] {
  const definitions: WorkflowDefinition[] = []

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }

  for (const entry of entries) {
    if (!entry.endsWith('.js')) {
      continue
    }

    const filePath = join(dir, entry)
    try {
      const stat = statSync(filePath)
      if (!stat.isFile()) {
        continue
      }
      if (stat.size > MAX_SCRIPT_BYTES) {
        continue
      }

      const content = readFileSync(filePath, 'utf-8')
      const meta = parseMeta(content)

      definitions.push({
        name: meta.name,
        description: meta.description,
        whenToUse: meta.whenToUse,
        source,
        filePath,
        meta,
      })
    } catch {
      // 解析失败的文件跳过
    }
  }

  return definitions
}

export function getAllWorkflows(): WorkflowDefinition[] {
  const userWorkflows = scanDirectory(getUserWorkflowsDir(), 'user')
  const projectWorkflows = scanDirectory(getProjectWorkflowsDir(), 'project')
  return [...projectWorkflows, ...userWorkflows]
}

export function resolveWorkflow(name: string): WorkflowDefinition | undefined {
  const all = getAllWorkflows()
  return all.find((w) => w.name === name)
}
