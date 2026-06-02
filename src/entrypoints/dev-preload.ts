// Dev-mode preload: defines build-time macros that Bun.build() normally injects.
// Loaded via `bun --preload` before cli.tsx — never shipped in production builds.

process.env.USER_TYPE = 'external'
process.env.ZY_DEV_TRANSCRIPT_CLASSIFIER = '1'

// 注入 build features，使 true 等在 dev 下为 true
if (typeof Bun !== 'undefined') {
  ;(Bun as any).features = [
    ...((Bun as any).features || []),
    'TRANSCRIPT_CLASSIFIER',
    'FORK_SUBAGENT',
    'REACTIVE_COMPACT',
    'TOKEN_BUDGET',
    'CONTEXT_COLLAPSE',
    'KAIROS',
  ]
}

// dev 下启用 auto mode（绕过 GrowthBook 远程配置默认 disabled）
process.env.ZY_CODE_DEV_AUTO_MODE = '1'

Object.assign(globalThis, {
  MACRO: {
    VERSION: 'dev',
    BUILD_TIME: new Date().toISOString(),
    PACKAGE_URL: '@zy-ai/zy-code',
    NATIVE_PACKAGE_URL: null,
    FEEDBACK_CHANNEL: 'https://github.com/ziyou979/zy-code/issues',
    ISSUES_EXPLAINER: 'report the issue at https://github.com/ziyou979/zy-code/issues',
    VERSION_CHANGELOG: '',
  },
})
