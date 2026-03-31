// Dev-mode preload: defines build-time macros that Bun.build() normally injects.
// Loaded via `bun --preload` before cli.tsx — never shipped in production builds.

process.env.USER_TYPE = 'external'

Object.assign(globalThis, {
  MACRO: {
    VERSION: 'dev',
    BUILD_TIME: new Date().toISOString(),
    PACKAGE_URL: '@anthropic-ai/claude-code',
    NATIVE_PACKAGE_URL: null,
    FEEDBACK_CHANNEL: 'https://github.com/anthropics/claude-code/issues',
    ISSUES_EXPLAINER: 'report the issue at https://github.com/anthropics/claude-code/issues',
    VERSION_CHANGELOG: '',
  },
})
