import * as React from 'react'
import { Pane } from '../../components/design-system/Pane.js'
import { PressEnterToContinue } from '../../components/PressEnterToContinue.js'
import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink/index.js'
import type { LocalJSXCommandCall } from '../types.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'

// --------------- arg parsing ---------------

type CodeReviewArgs = {
  effort: 'low' | 'medium' | 'high'
  fix: boolean
  comment: boolean
  prNumber?: number
}

const EFFORT_LEVELS = ['low', 'medium', 'high'] as const

function parseArgs(raw: string): CodeReviewArgs {
  const parts = raw.trim().split(/\s+/).filter(Boolean)
  const result: CodeReviewArgs = { effort: 'medium', fix: false, comment: false }

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p === '--fix') {
      result.fix = true
    } else if (p === '--comment') {
      result.comment = true
    } else if (EFFORT_LEVELS.includes(p as 'low' | 'medium' | 'high')) {
      result.effort = p as CodeReviewArgs['effort']
    } else if (/^\d+$/.test(p)) {
      result.prNumber = Number.parseInt(p, 10)
    }
  }

  return result
}

// --------------- git helpers ---------------

async function getGitDiff(): Promise<string> {
  const { execSync } = await import('node:child_process')
  try {
    return execSync('git diff --unified=3', { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 })
  } catch {
    return execSync('git diff --no-color --unified=3 2>/dev/null || echo ""', {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    })
  }
}

async function getGitStagedDiff(): Promise<string> {
  const { execSync } = await import('node:child_process')
  try {
    return execSync('git diff --cached --unified=3', {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    })
  } catch {
    return ''
  }
}

async function getPRDiff(prNumber: number): Promise<string> {
  const { execSync } = await import('node:child_process')
  return execSync(`gh pr diff ${prNumber}`, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 })
}

async function getPRInfo(prNumber: number): Promise<string> {
  const { execSync } = await import('node:child_process')
  try {
    return execSync(
      `gh pr view ${prNumber} --json title,body,author,baseRefName,headRefName,state,additions,deletions,changedFiles,labels`,
      { encoding: 'utf-8' },
    )
  } catch {
    return '{}'
  }
}

// --------------- review prompt builder ---------------

const EFFORT_PROMPTS: Record<string, string> = {
  low: 'You are a concise code reviewer. Focus on:\n1. Critical bugs or security issues\n2. Obvious code quality problems\nKeep the review brief — 3-5 bullet points maximum.',

  medium:
    'You are a thorough code reviewer. Focus on:\n1. Code correctness and potential bugs\n2. Security implications\n3. Performance considerations\n4. Code style and maintainability\n5. Test coverage suggestions\nFormat with clear sections. Be specific and actionable.',

  high: "You are a meticulous code reviewer performing deep analysis. Focus on:\n1. Correctness — edge cases, race conditions, error handling\n2. Security — injection, auth, data validation, secret exposure\n3. Performance — algorithmic complexity, resource leaks, caching\n4. Architecture — coupling, separation of concerns, API design\n5. Maintainability — naming, comments, complexity, duplication\n6. Test adequacy — what's missing and what's over-specified\n7. Operational — logging, monitoring, feature flags, rollback\nProvide specific line-level feedback with code examples where relevant.",
}

function buildReviewPrompt(
  diff: string,
  info: string,
  effort: string,
  fix: boolean,
  comment: boolean,
): string {
  const guidelines = EFFORT_PROMPTS[effort] || EFFORT_PROMPTS.medium
  let prompt = `${guidelines}\n\n`
  prompt += `Diff to review:\n\`\`\`diff\n${diff.slice(0, 80000)}\n\`\`\`\n\n`
  if (info) {
    prompt += `PR Info:\n${info}\n\n`
  }
  if (fix) {
    prompt +=
      'After analysis, APPLY the suggested fixes directly to the working tree using FileEditTool/FileWriteTool.\n'
  }
  if (comment) {
    prompt += 'Format review items as GitHub PR review comments with file paths and line numbers.\n'
  }
  return prompt
}

// --------------- review execution ---------------

async function performReview(diff: string, info: string, args: CodeReviewArgs): Promise<string> {
  const prompt = buildReviewPrompt(diff, info, args.effort, args.fix, args.comment)

  const { sideQuery } = await import('../../services/query/sideQuery.js')
  const { getMainLoopModel } = await import('../../services/model/model.js')

  const model = getMainLoopModel() || 'default'
  const response = await sideQuery({
    querySource: 'code_review',
    model,
    system: prompt,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text' as const,
            text: 'Please review the diff above and provide your analysis.',
          },
        ],
      },
    ],
    max_tokens: args.effort === 'high' ? 8192 : args.effort === 'low' ? 2048 : 4096,
    maxRetries: 1,
  })
  const result = response.content.map((b: any) => (b.type === 'text' ? b.text : '')).join('\n')

  let output = result
  if (args.fix && !args.comment) {
    output += '\n\n---\n' + tSync('codeReview.fixApplied')
  }
  return output
}

// --------------- Runner component ---------------

function CodeReviewRunner({
  args,
  onDone,
}: {
  args: CodeReviewArgs
  onDone: (text: string) => void
}) {
  const [state, setState] = React.useState<'collecting' | 'reviewing' | 'done' | 'error'>(
    'collecting',
  )
  const [message, setMessage] = React.useState('')

  React.useEffect(() => {
    let cancelled = false

    async function run() {
      try {
        setMessage(tSync('codeReview.collectingDiff'))
        let diff: string
        let info = ''

        if (args.prNumber) {
          diff = await getPRDiff(args.prNumber)
          info = await getPRInfo(args.prNumber)
          if (!cancelled) setMessage(tSync('codeReview.reviewingPR', { pr: String(args.prNumber) }))
        } else {
          const [working, staged] = await Promise.all([getGitDiff(), getGitStagedDiff()])
          diff = [staged, working].filter(Boolean).join('\n')
          if (!diff.trim()) {
            if (!cancelled) {
              setState('error')
              setMessage(tSync('codeReview.noChanges'))
            }
            return
          }
          if (!cancelled) setMessage(tSync('codeReview.reviewingChanges', { effort: args.effort }))
        }

        if (cancelled) return
        setState('reviewing')

        const MAX_DIFF_SIZE = 100_000
        if (diff.length > MAX_DIFF_SIZE) {
          diff = diff.slice(0, MAX_DIFF_SIZE) + '\n... [truncated]'
        }

        const result = await performReview(diff, info, args)
        if (!cancelled) {
          setState('done')
          setMessage(result)
        }
      } catch (err) {
        if (!cancelled) {
          setState('error')
          setMessage(tSync('codeReview.reviewError', { error: errorMessage(err) }))
        }
      }
    }

    run()
    return () => {
      cancelled = true
    }
  }, [args])

  if (state === 'collecting' || state === 'reviewing') {
    return (
      <Pane>
        <Box flexDirection="column">
          <Text bold={true}>{tSync('codeReview.title')}</Text>
          <Box marginTop={1}>
            <Text>
              {state === 'collecting' ? '⏳' : '🔍'} {message}
            </Text>
          </Box>
        </Box>
      </Pane>
    )
  }

  if (state === 'error') {
    onDone(message)
    return null
  }

  // done: call onDone with the result (PressEnterToContinue handles Enter key internally)
  onDone(message.slice(0, 2000))
  return null
}

// --------------- command entry ---------------

export const call: LocalJSXCommandCall = (onDone, _context, rawArgs) => {
  const args = parseArgs(rawArgs)
  logForDebugging(
    `/code-review: effort=${args.effort}, fix=${args.fix}, comment=${args.comment}, pr=${args.prNumber}`,
  )

  if (!args.prNumber && args.comment) {
    return Promise.resolve(
      <Pane>
        <Box flexDirection="column">
          <Text bold={true}>{tSync('codeReview.title')}</Text>
          <Box marginTop={1}>
            <Text>{tSync('codeReview.needPRForComment')}</Text>
          </Box>
          <Box marginTop={1}>
            <PressEnterToContinue />
          </Box>
        </Box>
      </Pane>,
    )
  }

  return Promise.resolve(<CodeReviewRunner args={args} onDone={onDone} />)
}
