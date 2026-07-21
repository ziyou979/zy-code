import type { Dirent, Stats } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import * as path from 'node:path'
import { errorMessage, getErrnoCode, isENOENT } from '../../utils/errors.js'
import { FRONTMATTER_REGEX } from '../markdown/frontmatterParser.js'
import { jsonParse } from '../../services/infra/slowOperations.js'
import { parseYaml } from '../../utils/yaml.js'
import { PluginHooksSchema } from './schemas.js'
import {
  detectManifestType,
  formatZodErrors,
  type ValidationError,
  type ValidationResult,
  type ValidationWarning,
  validateMarketplaceManifest,
  validatePluginManifest,
} from './validatePlugin.js'

/**
 * Validate the YAML frontmatter in a plugin component markdown file.
 *
 * The runtime loader (parseFrontmatter) silently drops unparseable YAML to a
 * debug log and returns an empty object. That's the right resilience choice
 * for the load path, but authors running `zy plugin validate` want a hard
 * signal. This re-parses the frontmatter block and surfaces what the loader
 * would silently swallow.
 */
function validateComponentFile(
  filePath: string,
  content: string,
  fileType: 'skill' | 'agent' | 'command',
): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  const match = content.match(FRONTMATTER_REGEX)
  if (!match) {
    warnings.push({
      path: 'frontmatter',
      message:
        'No frontmatter block found. Add YAML frontmatter between --- delimiters ' +
        'at the top of the file to set description and other metadata.',
    })
    return { success: true, errors, warnings, filePath, fileType }
  }

  const frontmatterText = match[1] || ''
  let parsed: unknown
  try {
    parsed = parseYaml(frontmatterText)
  } catch (e) {
    errors.push({
      path: 'frontmatter',
      message:
        `YAML frontmatter failed to parse: ${errorMessage(e)}. ` +
        `At runtime this ${fileType} loads with empty metadata (all frontmatter ` +
        `fields silently dropped).`,
    })
    return { success: false, errors, warnings, filePath, fileType }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push({
      path: 'frontmatter',
      message:
        'Frontmatter must be a YAML mapping (key: value pairs), got ' +
        `${Array.isArray(parsed) ? 'an array' : parsed === null ? 'null' : typeof parsed}.`,
    })
    return { success: false, errors, warnings, filePath, fileType }
  }

  const fm = parsed as Record<string, unknown>

  // description: must be scalar. coerceDescriptionToString logs+drops arrays/objects at runtime.
  if (fm.description !== undefined) {
    const d = fm.description
    if (typeof d !== 'string' && typeof d !== 'number' && typeof d !== 'boolean' && d !== null) {
      errors.push({
        path: 'description',
        message:
          `description must be a string, got ${Array.isArray(d) ? 'array' : typeof d}. ` +
          `At runtime this value is dropped.`,
      })
    }
  } else {
    warnings.push({
      path: 'description',
      message: `No description in frontmatter. A description helps users understand when to use this ${fileType}.`,
    })
  }

  // name: if present, must be a string (skills/commands use it as displayName;
  // plugin agents use it as the agentType stem — non-strings would stringify to garbage)
  if (fm.name !== undefined && fm.name !== null && typeof fm.name !== 'string') {
    errors.push({
      path: 'name',
      message: `name must be a string, got ${typeof fm.name}.`,
    })
  }

  // allowed-tools: string or array of strings
  const at = fm['allowed-tools']
  if (at !== undefined && at !== null) {
    if (typeof at !== 'string' && !Array.isArray(at)) {
      errors.push({
        path: 'allowed-tools',
        message: `allowed-tools must be a string or array of strings, got ${typeof at}.`,
      })
    } else if (Array.isArray(at) && at.some((t) => typeof t !== 'string')) {
      errors.push({
        path: 'allowed-tools',
        message: 'allowed-tools array must contain only strings.',
      })
    }
  }

  // shell: 'bash' | 'powershell' (controls !`cmd` block routing)
  const sh = fm.shell
  if (sh !== undefined && sh !== null) {
    if (typeof sh !== 'string') {
      errors.push({
        path: 'shell',
        message: `shell must be a string, got ${typeof sh}.`,
      })
    } else {
      // Normalize to match parseShellFrontmatter() runtime behavior —
      // `shell: PowerShell` should not fail validation but work at runtime.
      const normalized = sh.trim().toLowerCase()
      if (normalized !== 'bash' && normalized !== 'powershell') {
        errors.push({
          path: 'shell',
          message: `shell must be 'bash' or 'powershell', got '${sh}'.`,
        })
      }
    }
  }

  return { success: errors.length === 0, errors, warnings, filePath, fileType }
}

/**
 * Validate a plugin's hooks.json file. Unlike frontmatter, this one HARD-ERRORS
 * at runtime (pluginLoader uses .parse() not .safeParse()) — a bad hooks.json
 * breaks the whole plugin. Surfacing it here is essential.
 */
async function validateHooksJson(filePath: string): Promise<ValidationResult> {
  let content: string
  try {
    content = await readFile(filePath, { encoding: 'utf-8' })
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    // ENOENT is fine — hooks are optional
    if (code === 'ENOENT') {
      return {
        success: true,
        errors: [],
        warnings: [],
        filePath,
        fileType: 'hooks',
      }
    }
    return {
      success: false,
      errors: [{ path: 'file', message: `Failed to read file: ${errorMessage(e)}` }],
      warnings: [],
      filePath,
      fileType: 'hooks',
    }
  }

  let parsed: unknown
  try {
    parsed = jsonParse(content)
  } catch (e) {
    return {
      success: false,
      errors: [
        {
          path: 'json',
          message:
            `Invalid JSON syntax: ${errorMessage(e)}. ` +
            `At runtime this breaks the entire plugin load.`,
        },
      ],
      warnings: [],
      filePath,
      fileType: 'hooks',
    }
  }

  const result = PluginHooksSchema().safeParse(parsed)
  if (!result.success) {
    return {
      success: false,
      errors: formatZodErrors(result.error),
      warnings: [],
      filePath,
      fileType: 'hooks',
    }
  }

  return {
    success: true,
    errors: [],
    warnings: [],
    filePath,
    fileType: 'hooks',
  }
}

/**
 * Recursively collect .md files under a directory. Uses withFileTypes to
 * avoid a stat per entry. Returns absolute paths so error messages stay
 * readable.
 */
async function collectMarkdown(dir: string, isSkillsDir: boolean): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return []
    }
    throw e
  }

  // Skills use <name>/SKILL.md — only descend one level, only collect SKILL.md.
  // Matches the runtime loader: single .md files in skills/ are NOT loaded,
  // and subdirectories of a skill dir aren't scanned. Paths are speculative
  // (the subdir may lack SKILL.md); the caller handles ENOENT.
  if (isSkillsDir) {
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name, 'SKILL.md'))
  }

  // Commands/agents: recurse and collect all .md files.
  const out: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await collectMarkdown(full, false)))
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(full)
    }
  }
  return out
}

/**
 * Validate the content files inside a plugin directory — skills, agents,
 * commands, and hooks.json. Scans the default component directories (the
 * manifest can declare custom paths but the default layout covers the vast
 * majority of plugins; this is a linter, not a loader).
 *
 * Returns one ValidationResult per file that has errors or warnings. A clean
 * plugin returns an empty array.
 */
export async function validatePluginContents(pluginDir: string): Promise<ValidationResult[]> {
  const results: ValidationResult[] = []

  const dirs: Array<['skill' | 'agent' | 'command', string]> = [
    ['skill', path.join(pluginDir, 'skills')],
    ['agent', path.join(pluginDir, 'agents')],
    ['command', path.join(pluginDir, 'commands')],
  ]

  for (const [fileType, dir] of dirs) {
    const files = await collectMarkdown(dir, fileType === 'skill')
    for (const filePath of files) {
      let content: string
      try {
        content = await readFile(filePath, { encoding: 'utf-8' })
      } catch (e: unknown) {
        // ENOENT is expected for speculative skill paths (subdirs without SKILL.md)
        if (isENOENT(e)) {
          continue
        }
        results.push({
          success: false,
          errors: [{ path: 'file', message: `Failed to read: ${errorMessage(e)}` }],
          warnings: [],
          filePath,
          fileType,
        })
        continue
      }
      const result = validateComponentFile(filePath, content, fileType)
      if (result.errors.length > 0 || result.warnings.length > 0) {
        results.push(result)
      }
    }
  }

  const hooksResult = await validateHooksJson(path.join(pluginDir, 'hooks', 'hooks.json'))
  if (hooksResult.errors.length > 0 || hooksResult.warnings.length > 0) {
    results.push(hooksResult)
  }

  return results
}

/**
 * Validate a manifest file or directory (auto-detects type)
 */
export async function validateManifest(filePath: string): Promise<ValidationResult> {
  const absolutePath = path.resolve(filePath)

  // Stat path to check if it's a directory — handle ENOENT inline
  let stats: Stats | null = null
  try {
    stats = await stat(absolutePath)
  } catch (e: unknown) {
    if (!isENOENT(e)) {
      throw e
    }
  }

  if (stats?.isDirectory()) {
    // Look for manifest files in .zy-plugin directory
    // Prefer marketplace.json over plugin.json
    const marketplacePath = path.join(absolutePath, '.zy-plugin', 'marketplace.json')
    const marketplaceResult = await validateMarketplaceManifest(marketplacePath)
    // Only fall through if the marketplace file was not found (ENOENT)
    if (marketplaceResult.errors[0]?.code !== 'ENOENT') {
      return marketplaceResult
    }

    const pluginPath = path.join(absolutePath, '.zy-plugin', 'plugin.json')
    const pluginResult = await validatePluginManifest(pluginPath)
    if (pluginResult.errors[0]?.code !== 'ENOENT') {
      return pluginResult
    }

    return {
      success: false,
      errors: [
        {
          path: 'directory',
          message: `No manifest found in directory. Expected .zy-plugin/marketplace.json or .zy-plugin/plugin.json`,
        },
      ],
      warnings: [],
      filePath: absolutePath,
      fileType: 'plugin',
    }
  }

  const manifestType = detectManifestType(filePath)

  switch (manifestType) {
    case 'plugin':
      return validatePluginManifest(filePath)
    case 'marketplace':
      return validateMarketplaceManifest(filePath)
    case 'unknown': {
      // Try to parse and guess based on content
      try {
        const content = await readFile(absolutePath, { encoding: 'utf-8' })
        const parsed = jsonParse(content) as Record<string, unknown>

        // Heuristic: if it has a "plugins" array, it's probably a marketplace
        if (Array.isArray(parsed.plugins)) {
          return validateMarketplaceManifest(filePath)
        }
      } catch (e: unknown) {
        const code = getErrnoCode(e)
        if (code === 'ENOENT') {
          return {
            success: false,
            errors: [
              {
                path: 'file',
                message: `File not found: ${absolutePath}`,
              },
            ],
            warnings: [],
            filePath: absolutePath,
            fileType: 'plugin', // Default to plugin for error reporting
          }
        }
        // Fall through to default validation for other errors (e.g., JSON parse)
      }

      // Default: validate as plugin manifest
      return validatePluginManifest(filePath)
    }
  }
}
