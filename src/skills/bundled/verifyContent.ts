// Content for the verify bundled skill.
// Each .md file is inlined as a string at build time via Bun's text loader.

// @ts-ignore
import cliMd from './verify/examples/cli.md'
// @ts-ignore
import serverMd from './verify/examples/server.md'
// @ts-ignore
import skillMd from './verify/SKILL.md'

export const SKILL_MD: string = skillMd

export const SKILL_FILES: Record<string, string> = {
  'examples/cli.md': cliMd,
  'examples/server.md': serverMd,
}
