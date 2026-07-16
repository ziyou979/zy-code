/**
 * Auto mode subcommand handlers — dump default/merged classifier rules and
 * critique user-written rules. Dynamically imported when `zy auto-mode ...` runs.
 */

import { getMainLoopModel, parseUserSpecifiedModel } from '../../services/model/model.js'
import { errorMessage } from '../../utils/errors.js'
import {
  type AutoModeRules,
  buildDefaultSystemPrompt,
  getDefaultAutoModeRules,
} from '../../services/permissions/yoloClassifier.js'
import { getAutoModeConfig } from '../../services/settings/settings.js'
import { sideQuery } from '../../utils/sideQuery.js'
import { jsonStringify } from '../../utils/slowOperations.js'

function writeRules(rules: AutoModeRules): void {
  process.stdout.write(`${jsonStringify(rules, null, 2)}\n`)
}

export function autoModeDefaultsHandler(): void {
  writeRules(getDefaultAutoModeRules())
}

/**
 * Dump the effective auto mode config: user settings where provided, template
 * defaults otherwise. Per-section REPLACE semantics — matches how
 * buildYoloSystemPrompt resolves the permissions template (a non-empty user
 * section replaces that section's defaults entirely; an empty/absent section
 * falls through to defaults).
 */
export function autoModeConfigHandler(): void {
  const config = getAutoModeConfig()
  const defaults = getDefaultAutoModeRules()
  writeRules({
    allow: config?.allow?.length ? config.allow : defaults.allow,
    soft_deny: config?.soft_deny?.length ? config.soft_deny : defaults.soft_deny,
    hard_deny: config?.hard_deny?.length ? config.hard_deny : defaults.hard_deny,
    environment: config?.environment?.length ? config.environment : defaults.environment,
  })
}

const CRITIQUE_SYSTEM_PROMPT =
  'You are an expert reviewer of auto mode classifier rules for ZY Code.\n' +
  '\n' +
  'ZY Code has an "auto mode" that uses an AI classifier to decide whether ' +
  'tool calls should be auto-approved or require user confirmation. Users can ' +
  'write custom rules in four categories:\n' +
  '\n' +
  '- **allow**: Actions the classifier should auto-approve\n' +
  '- **soft_deny**: Destructive/irreversible actions the classifier should block ' +
  'unless clear user intent authorizes them\n' +
  '- **hard_deny**: Security-boundary actions the classifier should block ' +
  'unconditionally (user intent does not clear these)\n' +
  "- **environment**: Context about the user's setup that helps the classifier make decisions\n" +
  '\n' +
  "Your job is to critique the user's custom rules for clarity, completeness, " +
  'and potential issues. The classifier is an LLM that reads these rules as ' +
  'part of its system prompt.\n' +
  '\n' +
  'For each rule, evaluate:\n' +
  '1. **Clarity**: Is the rule unambiguous? Could the classifier misinterpret it?\n' +
  "2. **Completeness**: Are there gaps or edge cases the rule doesn't cover?\n" +
  '3. **Conflicts**: Do any of the rules conflict with each other?\n' +
  '4. **Actionability**: Is the rule specific enough for the classifier to act on?\n' +
  '\n' +
  'Be concise and constructive. Only comment on rules that could be improved. ' +
  'If all rules look good, say so.'

export async function autoModeCritiqueHandler(options: { model?: string }): Promise<void> {
  const config = getAutoModeConfig()
  const hasCustomRules =
    (config?.allow?.length ?? 0) > 0 ||
    (config?.soft_deny?.length ?? 0) > 0 ||
    (config?.hard_deny?.length ?? 0) > 0 ||
    (config?.environment?.length ?? 0) > 0

  if (!hasCustomRules) {
    process.stdout.write(
      'No custom auto mode rules found.\n\n' +
        'Add rules to your settings file under autoMode.{allow, soft_deny, hard_deny, environment}.\n' +
        'Run `zy auto-mode defaults` to see the default rules for reference.\n',
    )
    return
  }

  const model = options.model ? parseUserSpecifiedModel(options.model) : (getMainLoopModel() ?? '')

  const defaults = getDefaultAutoModeRules()
  const classifierPrompt = buildDefaultSystemPrompt()

  const userRulesSummary =
    formatRulesForCritique('allow', config?.allow ?? [], defaults.allow) +
    formatRulesForCritique('soft_deny', config?.soft_deny ?? [], defaults.soft_deny) +
    formatRulesForCritique('hard_deny', config?.hard_deny ?? [], defaults.hard_deny) +
    formatRulesForCritique('environment', config?.environment ?? [], defaults.environment)

  process.stdout.write('Analyzing your auto mode rules…\n\n')

  let response
  try {
    response = await sideQuery({
      querySource: 'auto_mode_critique' as const,
      model,
      system: CRITIQUE_SYSTEM_PROMPT,
      skipSystemPromptPrefix: true,
      max_tokens: 4096,
      messages: [
        {
          role: 'user' as const,
          content: [
            {
              type: 'text' as const,
              text:
                'Here is the full classifier system prompt that the auto mode classifier receives:\n\n' +
                '<classifier_system_prompt>\n' +
                classifierPrompt +
                '\n</classifier_system_prompt>\n\n' +
                "Here are the user's custom rules that REPLACE the corresponding default sections:\n\n" +
                userRulesSummary +
                '\nPlease critique these custom rules.',
            },
          ],
        },
      ],
    })
  } catch (error) {
    process.stderr.write(`Failed to analyze rules: ${errorMessage(error)}\n`)
    process.exitCode = 1
    return
  }

  const textBlock = response.content.find((block) => block.type === 'text')
  if (textBlock?.type === 'text') {
    process.stdout.write(`${textBlock.text}\n`)
  } else {
    process.stdout.write('No critique was generated. Please try again.\n')
  }
}

function formatRulesForCritique(
  section: string,
  userRules: string[],
  defaultRules: string[],
): string {
  if (userRules.length === 0) {
    return ''
  }
  const customLines = userRules.map((r) => `- ${r}`).join('\n')
  const defaultLines = defaultRules.map((r) => `- ${r}`).join('\n')
  return (
    '## ' +
    section +
    ' (custom rules replacing defaults)\n' +
    'Custom:\n' +
    customLines +
    '\n\n' +
    'Defaults being replaced:\n' +
    defaultLines +
    '\n\n'
  )
}
