import type { TranslationResource } from '../resourceTypes.js'

export const enOnboarding: TranslationResource = {
  'vertex.gcloudPathInvalid': 'Enter a valid path to the Google Cloud CLI executable.',
  'vertex.setup.intro':
    'Set up Vertex AI: credentials → project → location → access checks → confirm → model.',
  'vertex.setup.prerequisites':
    'You need a Google Cloud project with billing and the Vertex AI API enabled. The account needs Vertex AI User and Service Usage Consumer permissions. The next steps check these conditions.',
  'vertex.setup.adcDocs': 'Google ADC setup guide',
  'vertex.setup.newConnection': 'Create a new Vertex connection',
  'vertex.setup.start': 'Start or edit setup',
  'vertex.setup.back': 'Back',
  'vertex.setup.chooseCredentials': 'Choose how to obtain Google Cloud credentials',
  'vertex.setup.adcExplanation':
    'ADC is the credential used by applications. Signing in with gcloud auth login alone does not create ADC. Existing credential files can be reused without installing gcloud.',
  'vertex.setup.credentialPath': 'Credential file: {path}',
  'vertex.setup.useExisting': 'Verify and use the existing ADC file',
  'vertex.setup.authorizeBrowser': 'Authorize a Google account in the browser',
  'vertex.setup.useFile': 'Choose an ADC or service account credential file',
  'vertex.setup.filePrompt': 'Enter the full path to your Google credential JSON file',
  'vertex.setup.defaultAdc': 'Automatic ADC discovery',
  'vertex.setup.checkingCli': 'Checking Google Cloud CLI…',
  'vertex.setup.authorizing': 'Waiting for Google Cloud authorization…',
  'vertex.setup.consentHint':
    'Select your Google account, allow the Google Cloud cloud-platform permission, then return here. If the browser did not open, use the authorization link below.',
  'vertex.setup.cancelWaiting':
    'Esc cancels the current step; you can retry without switching your current model.',
  'vertex.setup.installCli':
    'Browser authorization requires Google Cloud CLI. Install it using the official guide, then retry. If this terminal cannot find it, enter its full executable path. Existing ADC files can be used without it.',
  'vertex.setup.retryCli': 'Check CLI again and authorize',
  'vertex.setup.enterCliPath': 'Enter the Google Cloud CLI executable path',
  'vertex.setup.cliPathPrompt': 'Full path to gcloud, gcloud.cmd, or gcloud.exe',
  'vertex.setup.loadingProjects': 'Verifying credentials and loading accessible projects…',
  'vertex.setup.chooseProject': 'Choose the project used for Vertex AI and quota',
  'vertex.setup.projectListUnavailable':
    'No projects were listed. You can enter a known project ID, create a project in Google Cloud Console, or retry after granting project visibility.',
  'vertex.setup.cloudRequestFailed':
    'Google Cloud check failed ({status}). Check permissions, cloud-platform authorization, API availability, and network access.',
  'vertex.setup.manualProject': 'Enter a project ID manually',
  'vertex.setup.refreshProjects': 'Reload projects',
  'vertex.setup.createProject': 'Open Google Cloud Console to create a project',
  'vertex.setup.invalidProject':
    'Enter a project ID, not its display name or number: 6–30 lowercase letters, digits, or hyphens; start with a letter and end with a letter or digit.',
  'vertex.setup.locationHint':
    'Choose a location supported by your model. Gemini 4 supports global, us, and eu. Other models may require a regional location; check availability before choosing a custom location.',
  'vertex.setup.locationGlobal': 'global — global endpoint',
  'vertex.setup.locationUs': 'us — United States multi-region',
  'vertex.setup.locationEu': 'eu — European Union multi-region',
  'vertex.setup.customLocation': 'Enter another region',
  'vertex.setup.locationPrompt': 'Vertex location, such as us-central1',
  'vertex.setup.invalidLocation':
    'Enter a valid Vertex location using lowercase letters, digits, and hyphens.',
  'vertex.setup.checkingProject': 'Checking project, billing, API, and IAM permissions…',
  'vertex.setup.checksTitle': 'Project readiness checks (no model generation)',
  'vertex.setup.check.project': 'Project active',
  'vertex.setup.check.billing': 'Billing enabled',
  'vertex.setup.check.api': 'Vertex AI API enabled',
  'vertex.setup.check.predict': 'Model invocation permission',
  'vertex.setup.check.quota': 'Quota project permission',
  'vertex.setup.status.ok': 'Passed',
  'vertex.setup.status.blocked': 'Action required',
  'vertex.setup.status.unknown': 'Not verified',
  'vertex.setup.checksHint':
    'Resolve required actions in Google Cloud Console, then recheck. Ask an administrator for Vertex AI User and Service Usage Consumer roles if needed. Some accounts cannot read billing or service status; unverified checks are not a successful model invocation.',
  'vertex.setup.apiConsole': 'Open Vertex AI API settings',
  'vertex.setup.billingConsole': 'Open project billing settings',
  'vertex.setup.iamConsole': 'Open project IAM permissions',
  'vertex.setup.continue': 'Continue to confirmation',
  'vertex.setup.continueUnknown': 'Continue with unverified checks',
  'vertex.setup.recheck': 'Run checks again',
  'vertex.setup.changeProject': 'Choose a different project',
  'vertex.setup.changeRegion': 'Choose a different location',
  'vertex.setup.changeCredentials': 'Choose different credentials',
  'vertex.setup.summary': 'Review and save the Vertex connection',
  'vertex.setup.connectionSummary': 'Connection: {connection}',
  'vertex.setup.connectionName': 'Enter a connection name',
  'vertex.setup.invalidConnectionId':
    'Use 1–64 letters, digits, dots, underscores, or hyphens for the connection name, starting with a letter or digit. Reserved names cannot be used.',
  'vertex.setup.connectionExists':
    'That connection name already exists. Choose another name to keep the existing connection.',
  'vertex.setup.quotaHint':
    'Vertex requests and quota attribution use project {project}. Model calls may incur Google Cloud charges.',
  'vertex.setup.saveHint':
    'Save the connection, then choose a model. This setup does not generate model output or change your global gcloud configuration.',
  'vertex.setup.save': 'Save connection and choose a model',
  'vertex.setup.rename': 'Change connection name',
  'google.invalidContinuation':
    'Gemini returned an unsupported or invalid continuation checkpoint. Generation stopped without increasing the output budget.',
  'google.unexpectedFinishReason': 'Gemini returned an unrecognized finish reason: {reason}.',
  'vertex.continuationRequiresBeta':
    'Gemini long output requires a Vertex v1beta1 endpoint. Update the connection endpoint or reduce the output budget.',
  'google.modelTurnEnding':
    'Gemini requires the request to end with user input or tool results. Continue the conversation before retrying.',
  'google.emptyConversation': 'Gemini requires nonempty user input or tool results.',
  'google.partialToolArguments':
    'Gemini returned partial tool arguments. Argument streaming is not supported by this client; no tool was executed.',
  'google.incompleteToolCall':
    'Gemini did not finish the tool call successfully. No tool was executed.',
  'vertex.connectionMissing': 'Configure a Vertex Gemini connection before signing in.',
  'vertex.credentialsMissing':
    'Google Cloud ADC credentials are missing or unreadable. Sign in again.',
  'vertex.gcloudMissing':
    'Google Cloud CLI was not found. Install it or enter its executable path in this setup wizard.',
  'vertex.loginFailed':
    'Google Cloud authorization failed. Allow the Google Cloud permission on the consent page and check your gcloud installation.',
  'vertex.loginOption': 'Google Cloud Vertex AI (ADC)',
  'vertex.loginTitle': 'Google Cloud Vertex AI',
  'vertex.loginProject': 'Project: {project} · Location: {location}',
  'vertex.loginHint':
    'Use existing ADC credentials or authorize Google Cloud in your browser. Checking credentials does not generate model output.',
  'vertex.loginWaiting': 'Checking credentials or waiting for Google Cloud authorization…',
  'vertex.openLoginPage': 'Open the Google authorization page',
  'vertex.checkCredentials': 'Verify existing credentials and continue',
  'vertex.browserLogin': 'Sign in again in the browser',
  'vertex.back': 'Back',
  'vertex.saveFailed':
    'Could not save the Vertex connection. Check access to auth.json and try again.',
  'vertex.enterProject': 'Enter the Google Cloud project ID',
  'vertex.projectPlaceholder': 'your-project-id',
  'vertex.selectLocation': 'Select the Vertex Gemini location',
  'vertex.adcHint':
    'Uses Google Application Default Credentials. First run gcloud auth application-default login. Model requests use your project billing.',
  'vertex.invalidEndpoint':
    'Vertex ADC requires an official HTTPS aiplatform.googleapis.com endpoint.',
  'vertex.projectMissing':
    'Configure vertex.project and vertex.location in auth.json, or set GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION.',
  'vertex.invalidModel': 'Enter a Vertex publisher model ID, such as gemini-4-argon.',
  'vertex.invalidGemini4Location': 'Gemini 4 requires the global, us, or eu location.',
  'vertex.emptyResponse': 'Vertex returned an empty streaming response.',
  'vertex.incompleteStream': 'Vertex disconnected before the response finished. Please try again.',
  'modelCapability.title': 'Model capabilities: {model}',
  'modelCapability.effort': 'Thinking effort mapping',
  'modelCapability.autoModeHint':
    'Auto mode is a ZYCode approval policy. After selecting the model, use /auto-mode to evaluate the actual approval classifier.',
  'modelCapability.effortJson': 'Effort JSON',
  'modelCapability.effortHint':
    'Only map confirmed levels: quick/light/balanced/thorough usually map to minimal/low/medium/high. extreme uses the declared strongest level (xhigh or max); ultra reuses extreme. on uses the provider default; off uses the thinking switch.',
  'modelCapability.effortExample':
    'Example: {"levels":["off","light","balanced"],"map":{"light":"low","balanced":"medium"}}',
  'modelCapability.invalidMapping':
    'Enter valid effort JSON. Each explicit strength needs a nonempty mapping; mapping keys must be listed in levels. off/on may use the switch/default.',
  'modelCapability.source': 'Capability source: {source}',
  'modelCapability.source.catalog': 'Provider metadata',
  'modelCapability.source.registry': 'Public catalog (models.dev)',
  'modelCapability.source.local': 'Your saved configuration',
  'modelCapability.source.unknown': 'Not available',
  'modelCapability.hint':
    'Review or edit capabilities for this connection. Unconfirmed fields remain unknown.',
  'modelCapability.useModel': 'Use this model',
  'modelCapability.image': 'Image input',
  'modelCapability.thinking': 'Thinking',
  'modelCapability.structured': 'Structured output',
  'modelCapability.context': 'Context window',
  'modelCapability.output': 'Maximum output tokens',
  'modelCapability.tokens': 'Token count',
  'modelCapability.numberHint':
    'Enter a positive integer. Leave empty to follow the automatic value.',
  'modelCapability.invalidNumber': 'Enter a positive integer token count.',
  'modelCapability.unknown': 'Unknown',
  'modelCapability.supported': 'Supported',
  'modelCapability.unsupported': 'Not supported',
  'modelCapability.followSource': 'Follow automatic or file configuration',
  'modelCapability.resolving': 'Looking up model capabilities…',
  'modelCapability.catalogIssue.timeout':
    'The public capability lookup timed out. Go back and refresh the model list to retry, or fill in unknown fields manually.',
  'modelCapability.catalogIssue.unavailable':
    'Could not load the public capability catalog. Check your network or proxy, then refresh the model list to retry. Unknown fields can be edited manually.',
  'modelCapability.catalogIssue.not-found':
    'The public catalog has no matching model ID. Fill in unknown capabilities manually.',
  'modelCapability.back': 'Back to model selection',
  'modelCapability.edit': 'Edit capabilities of the last focused model…',
  'onboarding.models.capabilitiesIncomplete':
    'Some capabilities are unconfirmed. Thinking, image input, or context limits may be unavailable.',
  'onboarding.models.capabilitySaveFailed':
    'Could not save the model capabilities. Check that your configuration directory is writable and try again.',
  'onboarding.apiFormat.anthropic': 'Anthropic format',
  'onboarding.apiFormat.anthropicDesc':
    'Uses Anthropic Messages API format (supports thinking, cache_control, etc.)',
  'onboarding.apiFormat.openai-chat': 'OpenAI Chat format',
  'onboarding.apiFormat.openai-chatDesc':
    'Uses OpenAI Chat Completions API format (for vLLM, LiteLLM, etc.)',
  'onboarding.apiFormat.openai-responses': 'OpenAI Responses format',
  'onboarding.apiFormat.openai-responsesDesc':
    'Uses OpenAI Responses API format (recommended for gpt-5 / o-series models)',
  'onboarding.apiFormat.google': 'Google / Gemini format',
  'onboarding.apiFormat.googleDesc':
    'Uses Google Generative AI native API format (for Gemini models)',
  'onboarding.apiFormatDescription': 'Choose the request format for your custom API endpoint.',
  'onboarding.baseUrlLabel': 'Base URL',
  'onboarding.confirmBack': 'Enter to confirm · Esc to go back',
  'onboarding.optionalApiKeyPlaceholder': 'sk-... (optional)',
  'onboarding.defaultApiKeyLabel': 'API Key',
  'onboarding.discoveredModel': 'Available via API',
  'onboarding.effort.desc':
    "How thorough should ZY Code's responses be? Medium balances quality and speed. You can change this later with /effort.",
  'onboarding.effort.title': 'Choose effort level',
  'onboarding.enterApiKey': 'Enter {apiKeyLabel}',
  'onboarding.enterModelName': 'Enter Model Name',
  'onboarding.enterToConfirm': 'Enter to confirm · Esc to exit',
  'onboarding.enterToConfirmSkip': 'Enter to confirm · Esc to skip',
  'onboarding.fetchingModels': 'Fetching available models...',
  'onboarding.models.refresh': 'Refresh model list',
  'onboarding.models.empty': 'The platform returned no models. Refresh or enter a model name.',
  'onboarding.models.unsupported':
    'This connection has no model list endpoint. Enter a model name.',
  'onboarding.models.authentication':
    'Model list authentication failed. Update your credentials and refresh.',
  'onboarding.models.http':
    'Could not fetch models (HTTP {status}). Refresh or enter a model name.',
  'onboarding.models.timeout': 'Fetching models timed out. Refresh or enter a model name.',
  'onboarding.models.network':
    'Could not connect to the model list endpoint. Refresh or enter a model name.',
  'onboarding.models.invalid-response':
    'The platform returned an unrecognized model list. Refresh or enter a model name.',
  'onboarding.models.cancelled': 'Fetching models was cancelled. Refresh to try again.',
  'onboarding.generic.baseUrlPlaceholder':
    'e.g. https://api.openai.com/v1 or http://localhost:8000/v1',
  'onboarding.generic.enterBaseUrl': 'Enter API Base URL',
  'onboarding.generic.enterModelsUrl': 'Enter Models Endpoint URL (optional)',
  'onboarding.generic.modelsUrlPlaceholder':
    'Press Enter to use {defaultUrl}, or enter custom path',
  'onboarding.generic.selectApiFormat': 'Select API Protocol Format',
  'onboarding.language.chinese': 'Chinese (Simplified)',
  'onboarding.language.english': 'English',
  'onboarding.languageDescription': 'This controls the language for the interface and responses.',
  'onboarding.model.custom': 'Custom model',
  'onboarding.model.customDesc': 'Enter a full model name',
  'onboarding.modelDescription': 'Model used at startup, can be changed later via /model',
  'onboarding.modelNameLabel': 'Model name',
  'onboarding.modelNamePlaceholder': 'e.g. qwen-max, qwen3.6-plus...',
  'onboarding.orCustomModel': 'Or select "Custom model" for other models',
  'onboarding.platform.ant-ling': 'Ant Ling',
  'onboarding.platform.ant-lingDesc': 'Ant Group Ling AI Platform (Ling, Ring, and Ming models)',
  'onboarding.platform.anthropic': 'Anthropic',
  'onboarding.platform.anthropicDesc': 'Anthropic Claude API',
  'onboarding.platform.atria': 'Atria',
  'onboarding.platform.atriaDesc': 'Atria model API platform',
  'onboarding.platform.gemini-oauth': 'Google Gemini (subscription)',
  'onboarding.platform.gemini-oauthDesc': 'Google AI subscription with OAuth authorization',
  'onboarding.platform.bedrock': 'AWS Bedrock',
  'onboarding.platform.bedrockDesc': 'AWS Bedrock model inference',
  'onboarding.platform.qianfan': 'Baidu AI Studio',
  'onboarding.platform.qianfanDesc': 'Baidu Qianfan / AI Studio Platform',
  'onboarding.platform.dashscope': 'Bailian DashScope',
  'onboarding.platform.dashscopeDesc': 'Alibaba Cloud Bailian Platform',
  'onboarding.platform.deepseek': 'DeepSeek',
  'onboarding.platform.deepseekDesc': 'DeepSeek AI Platform',
  'onboarding.platform.fireworks': 'Fireworks AI',
  'onboarding.platform.fireworksDesc': 'Fireworks AI inference platform',
  'onboarding.platform.azure': 'Microsoft Azure',
  'onboarding.platform.azureDesc': 'Azure AI model inference',
  'onboarding.platform.generic': 'Custom',
  'onboarding.platform.genericDesc': 'Custom API endpoint (Anthropic or OpenAI format)',
  'onboarding.platform.gemini': 'Google Gemini',
  'onboarding.platform.geminiDesc': 'Google Generative AI (Gemini models)',
  'onboarding.platform.groq': 'Groq',
  'onboarding.platform.groqDesc': 'Groq ultra-fast inference',
  'onboarding.platform.pangu': 'Huawei Pangu',
  'onboarding.platform.panguDesc': 'Huawei Pangu large model platform',
  'onboarding.platform.kimi': 'Kimi',
  'onboarding.platform.kimiDesc': 'Moonshot AI Kimi Platform',
  'onboarding.platform.llamacpp': 'llama.cpp',
  'onboarding.platform.llamacppDesc': 'Local models via llama.cpp server',
  'onboarding.platform.lmstudio': 'LM Studio',
  'onboarding.platform.lmstudioDesc': 'Local models via LM Studio',
  'onboarding.platform.local': 'Local Model',
  'onboarding.platform.localApiKey': 'Local endpoint URL (optional)',
  'onboarding.platform.localDesc': 'Locally deployed models (Ollama, vLLM, etc.)',
  'onboarding.platform.mimo': 'MiMo',
  'onboarding.platform.mimoDesc': 'Xiaomi MiMo AI Platform',
  'onboarding.platform.minimax': 'MiniMax',
  'onboarding.platform.minimaxDesc': 'MiniMax AI Platform',
  'onboarding.platform.nim': 'NVIDIA NIM',
  'onboarding.platform.nimDesc': 'NVIDIA NIM inference microservices',
  'onboarding.platform.ollama': 'Ollama',
  'onboarding.platform.ollamaDesc': 'Local open-source models via Ollama',
  'onboarding.platform.openai': 'OpenAI',
  'onboarding.platform.openaiDesc': 'OpenAI API (GPT-4, o-series, etc.)',
  'onboarding.platform.opencode-go': 'OpenCode Go',
  'onboarding.platform.opencode-goDesc': 'OpenCode Go subscription for curated coding models',
  'onboarding.platform.openrouter': 'OpenRouter',
  'onboarding.platform.openrouterDesc': 'Unified API for multiple model providers',
  'onboarding.platform.perplexity': 'Perplexity',
  'onboarding.platform.perplexityDesc': 'Perplexity AI search-augmented models',
  'onboarding.platform.siliconflow': 'SiliconFlow',
  'onboarding.platform.siliconflowDesc': 'SiliconFlow Cloud AI Platform',
  'onboarding.platform.stepfun': 'StepFun',
  'onboarding.platform.stepfunDesc': 'StepFun AI Platform (Step models)',
  'onboarding.platform.tencent': 'Tencent Hunyuan',
  'onboarding.platform.tencentDesc': 'Tencent Cloud LKE AI Platform',
  'onboarding.platform.together': 'Together AI',
  'onboarding.platform.togetherDesc': 'Together AI inference platform',
  'onboarding.platform.vertex': 'Google Vertex AI',
  'onboarding.platform.vertexDesc': 'Google Vertex AI model inference',
  'onboarding.platform.xai': 'xAI Grok',
  'onboarding.platform.xaiDesc': 'xAI API (Grok models)',
  'onboarding.platform.ark': 'Volcengine ARK',
  'onboarding.platform.arkDesc': 'ByteDance Volcengine ARK Platform',
  'onboarding.platform.zhipu': 'ZHIPU AI',
  'onboarding.platform.zhipuDesc': 'ZHIPU AI (ChatGLM, GLM-4, etc.)',
  'onboarding.pressAgainToExit': 'Press {key} again to exit',
  'onboarding.projectStep.workspace': 'Ask Zy to create a new app or clone a repository',
  'onboarding.projectStep.agentsMd':
    'Run /init to create a AGENTS.md file with instructions for ZY',
  'onboarding.security.risk1': 'ZY Code can make mistakes',
  'onboarding.security.risk1desc':
    'You should always review ZY Code&apos;s responses, especially when running code.',
  'onboarding.security.risk2': 'Due to prompt injection risks, only use it with code you trust',
  'onboarding.security.risk2desc': 'For more details see:',
  'onboarding.security.title': 'Security notes:',
  'onboarding.selectApiFormat': 'Select API format',
  'onboarding.selectDefaultModel': 'Select Default Conversation Model',
  'onboarding.selectLanguage': 'Select your language',
  'onboarding.selectPlatform': 'Select AI Platform',
  'onboarding.terminalSetup.appleSettings': 'Option+Enter for newlines and visual bell',
  'onboarding.terminalSetup.description':
    'For the optimal coding experience, enable the recommended settings for your terminal: {settings}',
  'onboarding.terminalSetup.no': 'No, maybe later with /terminal-setup',
  'onboarding.terminalSetup.otherSettings': 'Shift+Enter for newlines',
  'onboarding.terminalSetup.title': 'Use ZY Code&apos;s terminal setup?',
  'onboarding.terminalSetup.yes': 'Yes, use recommended settings',
  'onboarding.themeHelpText': '后续可通过 /theme 更改',
  'onboarding.tier.advanced.desc': 'Used for complex reasoning. Skip to use the standard model.',
  'onboarding.tier.advanced.title': 'Configure Advanced Tier Model (optional)',
  'onboarding.tier.compact.desc':
    'Used for fast/lightweight tasks (summaries, titles). Skip to use the standard model.',
  'onboarding.tier.compact.title': 'Configure Compact Tier Model (optional)',
  'onboarding.tier.custom': 'Custom model',
  'onboarding.tier.customDesc': 'Enter a full model name',
  'onboarding.tier.mainLoop.desc':
    'Which tier to use for the main conversation loop. Can be changed later via /config mainLoopModel.',
  'onboarding.tier.mainLoop.title': 'Select Main Conversation Tier',
  'onboarding.tier.option.advanced': 'Advanced — complex reasoning',
  'onboarding.tier.option.compact': 'Compact — fast/lightweight',
  'onboarding.tier.option.standard': 'Standard — everyday tasks (default)',
  'onboarding.tier.skip': 'Skip (use standard model)',
  'onboarding.tier.standard.desc': 'Used for everyday tasks. This is the minimum required tier.',
  'onboarding.tier.standard.title': 'Configure Standard Tier Model',
  'tip.agentFlag': 'Use --agent <agent_name> to directly start a conversation with a subagent',
  'tip.btwSideQuestion': 'Use /btw to ask a quick side question without interrupting current work',
  'tip.clearContext': 'Use /clear to start fresh when switching topics and free up context',
  'tip.colortermTruecolor':
    'Try setting environment variable COLORTERM=truecolor for richer colors',
  'tip.colorWhenMultiSessions':
    'Running multiple ZY Code sessions? Use /color and /rename to tell them apart at a glance.',
  'tip.continue': 'Run zycode --continue or zycode --resume to resume a conversation',
  'tip.customAgents':
    'Use /agents to optimize specific tasks. Eg. Software Architect, Code Writer, Code Reviewer',
  'tip.customCommands':
    'Create skills by adding .md files to .zy/skills/ in your project or ~/.zy/skills/ for skills that work in any project',
  'tip.defaultPermissionModeConfig':
    'Use /config to change your default permission mode (including Plan Mode)',
  'tip.desktopApp': 'Run ZY Code locally or remotely using the Zy desktop app',
  'tip.desktopShortcut': 'Continue your session in ZY Code Desktop with {shortcut}',
  'tip.doubleEsc': 'Double-tap esc to rewind the conversation to a previous point in time',
  'tip.doubleEscCodeRestore':
    'Double-tap esc to rewind the code and/or conversation to a previous point in time',
  'tip.dragAndDropImages': 'Did you know you can drag and drop image files into your terminal?',
  'tip.effortHighA': 'Working on something tricky? {cmd} gives better first answers',
  'tip.effortHighB': 'Use {cmd} for better one-shot answers. Zy thinks it through first.',
  'tip.enterToSteer': 'Send messages to ZY code while it works to steer ZY Code in real-time',
  'tip.feedbackCommand': 'Use /feedback to help us improve!',
  'tip.frontendDesignPlugin':
    'Working with HTML/CSS? Install the frontend-design plugin:\n{command}',
  'tip.gitWorktrees': 'Use git worktrees to run multiple ZY code sessions in parallel.',
  'tip.ideUpsellExternalTerminal': 'Connect ZY Code to your IDE · /ide',
  'tip.imagePaste': 'Use {shortcut} to paste images from your clipboard',
  'tip.installGithubApp':
    'Run /install-github-app to tag @zy right from your Github issues and PRs',
  'tip.installSlackApp': 'Run /install-slack-app to use ZY Code in Slack',
  'tip.loopCommandA':
    '{cmd} runs any prompt on a recurring schedule. Great for monitoring deploys, babysitting PRs, or polling status.',
  'tip.loopCommandB': 'Use {cmd} to run any prompt on a schedule. Set it and forget it.',
  'tip.memoryCommand': 'Use /memory to view and manage ZY Code memory',
  'tip.mobileApp': '/mobile to use ZY Code from the Zy app on your phone',
  'tip.newUserWarmup':
    'Start with small features or bug fixes, tell ZY code to propose a plan, and verify its suggested edits',
  'tip.opusPlanModeReminder':
    'Your default model setting is Opus Plan Mode. Press {shortcut} twice to activate Plan Mode and plan with Zy Opus.',
  'tip.pasteImagesMac': 'Paste images into ZY Code using control+v (not cmd+v!)',
  'tip.permissions': 'Use /permissions to pre-approve and pre-deny bash, edit, and MCP tools',
  'tip.planModeForComplexTasks':
    'Use Plan Mode to prepare for a complex request before making changes. Press {shortcut} twice to enable.',
  'tip.powershellToolEnv':
    'PowerShell is selected automatically on Windows without Bash; set ZY_CODE_USE_POWERSHELL_TOOL=1 or 0 to override.',
  'tip.promptQueue': 'Hit Enter to queue up additional messages while ZY Code is working.',
  'tip.renameConversation':
    'Name your conversations with /rename to find them easily in /resume later',
  'tip.shiftEnterApple': 'Press Option+Enter to send a multi-line message',
  'tip.shiftEnterOther': 'Press Shift+Enter to send a multi-line message',
  'tip.shiftEnterSetupApple': 'Run /terminal-setup to enable Option+Enter for new lines',
  'tip.shiftEnterSetupOther': 'Run /terminal-setup to enable Shift+Enter for new lines',
  'tip.shiftTab':
    'Hit {shortcut} to cycle between modes (default, auto-accept edit, and plan mode)',
  'tip.subagentFanoutA':
    'Say {cmd} and ZY Code sends a team. Each one digs deep so nothing gets missed.',
  'tip.subagentFanoutB':
    'For big tasks, tell ZY Code to {cmd}. They work in parallel and keep your main thread clean.',
  'tip.terminalSetupApple':
    'Run /terminal-setup to enable convenient terminal integration like Option + Enter for new line and more',
  'tip.terminalSetupOther':
    'Run /terminal-setup to enable convenient terminal integration like Shift + Enter for new line and more',
  'tip.themeCommand': 'Use /theme to change the color theme',
  'tip.statusLine':
    'Use /statusline to toggle the built-in status bar showing effort, context usage, model, tokens, and git branch',
  'tip.todoList':
    'Ask ZY Code to create a todo list when working on complex tasks to track progress and remain on track',
  'tip.vercelPlugin': 'Working with Vercel? Install the vercel plugin:\n{command}',
  'tip.vscodeCommandInstall':
    'Open the Command Palette (Cmd+Shift+P) and run "Shell Command: Install \'{command}\' command in PATH" to enable IDE integration',
  'tip.webApp': 'Run tasks in the cloud while you keep coding locally',
}
