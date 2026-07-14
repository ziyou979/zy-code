/**
 * 本地技能搜索 — 从配置目录扫描和索引技能文件
 *
 * 扫描 .zy/skills/ 目录及 builtin 技能目录，
 * 根据名称、描述和关键词匹配用户查询。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getProjectRoot } from '../../bootstrap/runtime/runtimeContext.js'
import { getZyConfigHomeDir } from '../../utils/envUtils.js'

type SkillEntry = {
  name: string
  description: string
  path: string
  source: 'project' | 'user' | 'builtin'
}

let _index: Map<string, SkillEntry> | null = null

function getSkillDirs(): { path: string; source: 'project' | 'user' | 'builtin' }[] {
  const dirs: { path: string; source: 'project' | 'user' | 'builtin' }[] = []

  // 项目级技能目录
  try {
    const projectRoot = getProjectRoot()
    const projectSkills = join(projectRoot, '.zy', 'skills')
    if (existsSync(projectSkills)) {
      dirs.push({ path: projectSkills, source: 'project' })
    }
  } catch {
    // 项目根目录读取失败时跳过
  }

  // 用户级技能目录
  try {
    const userSkills = join(getZyConfigHomeDir(), 'skills')
    if (existsSync(userSkills)) {
      dirs.push({ path: userSkills, source: 'user' })
    }
  } catch {
    // 用户目录读取失败时跳过
  }

  return dirs
}

function scanSkillDir(dir: string, source: 'project' | 'user' | 'builtin'): SkillEntry[] {
  const entries: SkillEntry[] = []
  try {
    const items = readdirSync(dir)
    for (const item of items) {
      const fullPath = join(dir, item)
      try {
        const st = statSync(fullPath)
        if (st.isDirectory()) {
          // 查找 SKILL.md 或 skill.md
          for (const name of ['SKILL.md', 'skill.md', 'README.md']) {
            const skillFile = join(fullPath, name)
            if (existsSync(skillFile)) {
              const content = readFileSync(skillFile, 'utf-8')
              const desc = extractDescription(content)
              entries.push({ name: item, description: desc, path: fullPath, source })
              break
            }
          }
        } else if (st.isFile() && (item.endsWith('.md') || item.endsWith('.txt'))) {
          const content = readFileSync(fullPath, 'utf-8')
          const desc = extractDescription(content)
          const name = item.replace(/\.(md|txt)$/i, '')
          entries.push({ name, description: desc, path: fullPath, source })
        }
      } catch {
        // 单个文件/目录读取失败时跳过
      }
    }
  } catch {
    // 目录读取失败时返回空
  }
  return entries
}

function extractDescription(content: string): string {
  // 尝试从 frontmatter 中提取 description
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (fmMatch) {
    const fm = fmMatch[1] ?? ''
    const descMatch = fm.match(/description:\s*(.+)/)
    if (descMatch) {
      return descMatch[1]?.trim() ?? ''
    }
  }
  // 取第一行非空非标题文本作为描述
  const lines = content.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')) {
      return trimmed.slice(0, 100)
    }
  }
  return ''
}

function buildIndex(): Map<string, SkillEntry> {
  const index = new Map<string, SkillEntry>()
  const dirs = getSkillDirs()
  for (const { path, source } of dirs) {
    const entries = scanSkillDir(path, source)
    for (const entry of entries) {
      if (!index.has(entry.name)) {
        index.set(entry.name, entry)
      }
    }
  }
  return index
}

export function clearSkillIndexCache(): void {
  _index = null
}

export function searchLocalSkills(query: string, limit: number = 10): SkillEntry[] {
  if (!_index) {
    _index = buildIndex()
  }

  const q = query.toLowerCase()
  const results: { entry: SkillEntry; score: number }[] = []

  for (const entry of _index.values()) {
    let score = 0
    const nameLower = entry.name.toLowerCase()
    if (nameLower === q) {
      score += 100
    } else if (nameLower.includes(q)) {
      score += 50
    } else {
      // 部分匹配名称
      const nameParts = nameLower.split(/[-_\s]+/)
      for (const part of nameParts) {
        if (part === q) {
          score += 30
        } else if (part.includes(q)) {
          score += 15
        }
      }
    }

    // 描述匹配
    const descLower = entry.description.toLowerCase()
    if (descLower.includes(q)) {
      score += 10
    }

    if (score > 0) {
      results.push({ entry, score })
    }
  }

  results.sort((a, b) => b.score - a.score)
  return results.slice(0, limit).map((r) => r.entry)
}

export function getSkillIndex(): Map<string, SkillEntry> {
  if (!_index) {
    _index = buildIndex()
  }
  return new Map(_index)
}
