// Content for the zy-api bundled skill.
// Each .md file is inlined as a string at build time via Bun's text loader.

// @ts-ignore
import csharpZyApi from './zy-api/csharp/zy-api.md'
// @ts-ignore
import curlExamples from './zy-api/curl/examples.md'
// @ts-ignore
import goZyApi from './zy-api/go/zy-api.md'
// @ts-ignore
import javaZyApi from './zy-api/java/zy-api.md'
// @ts-ignore
import phpZyApi from './zy-api/php/zy-api.md'
// @ts-ignore
import pythonAgentSdkPatterns from './zy-api/python/agent-sdk/patterns.md'
// @ts-ignore
import pythonAgentSdkReadme from './zy-api/python/agent-sdk/README.md'
// @ts-ignore
import pythonZyApiBatches from './zy-api/python/zy-api/batches.md'
// @ts-ignore
import pythonZyApiFilesApi from './zy-api/python/zy-api/files-api.md'
// @ts-ignore
import pythonZyApiReadme from './zy-api/python/zy-api/README.md'
// @ts-ignore
import pythonZyApiStreaming from './zy-api/python/zy-api/streaming.md'
// @ts-ignore
import pythonZyApiToolUse from './zy-api/python/zy-api/tool-use.md'
// @ts-ignore
import rubyZyApi from './zy-api/ruby/zy-api.md'
// @ts-ignore
import skillPrompt from './zy-api/SKILL.md'
// @ts-ignore
import sharedErrorCodes from './zy-api/shared/error-codes.md'
// @ts-ignore
import sharedLiveSources from './zy-api/shared/live-sources.md'
// @ts-ignore
import sharedModels from './zy-api/shared/models.md'
// @ts-ignore
import sharedPromptCaching from './zy-api/shared/prompt-caching.md'
// @ts-ignore
import sharedToolUseConcepts from './zy-api/shared/tool-use-concepts.md'
// @ts-ignore
import typescriptAgentSdkPatterns from './zy-api/typescript/agent-sdk/patterns.md'
// @ts-ignore
import typescriptAgentSdkReadme from './zy-api/typescript/agent-sdk/README.md'
// @ts-ignore
import typescriptZyApiBatches from './zy-api/typescript/zy-api/batches.md'
// @ts-ignore
import typescriptZyApiFilesApi from './zy-api/typescript/zy-api/files-api.md'
// @ts-ignore
import typescriptZyApiReadme from './zy-api/typescript/zy-api/README.md'
// @ts-ignore
import typescriptZyApiStreaming from './zy-api/typescript/zy-api/streaming.md'
// @ts-ignore
import typescriptZyApiToolUse from './zy-api/typescript/zy-api/tool-use.md'

export const SKILL_PROMPT: string = skillPrompt

export const SKILL_FILES: Record<string, string> = {
  'csharp/zy-api.md': csharpZyApi,
  'curl/examples.md': curlExamples,
  'go/zy-api.md': goZyApi,
  'java/zy-api.md': javaZyApi,
  'php/zy-api.md': phpZyApi,
  'python/agent-sdk/README.md': pythonAgentSdkReadme,
  'python/agent-sdk/patterns.md': pythonAgentSdkPatterns,
  'python/zy-api/README.md': pythonZyApiReadme,
  'python/zy-api/batches.md': pythonZyApiBatches,
  'python/zy-api/files-api.md': pythonZyApiFilesApi,
  'python/zy-api/streaming.md': pythonZyApiStreaming,
  'python/zy-api/tool-use.md': pythonZyApiToolUse,
  'ruby/zy-api.md': rubyZyApi,
  'shared/error-codes.md': sharedErrorCodes,
  'shared/live-sources.md': sharedLiveSources,
  'shared/models.md': sharedModels,
  'shared/prompt-caching.md': sharedPromptCaching,
  'shared/tool-use-concepts.md': sharedToolUseConcepts,
  'typescript/agent-sdk/README.md': typescriptAgentSdkReadme,
  'typescript/agent-sdk/patterns.md': typescriptAgentSdkPatterns,
  'typescript/zy-api/README.md': typescriptZyApiReadme,
  'typescript/zy-api/batches.md': typescriptZyApiBatches,
  'typescript/zy-api/files-api.md': typescriptZyApiFilesApi,
  'typescript/zy-api/streaming.md': typescriptZyApiStreaming,
  'typescript/zy-api/tool-use.md': typescriptZyApiToolUse,
}
