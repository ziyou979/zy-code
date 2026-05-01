// Dev-mode preload: defines build-time macros that Bun.build() normally injects.
// Loaded via `bun --preload` before cli.tsx — never shipped in production builds.

process.env.USER_TYPE = 'external'
process.env.ZY_CODE_NO_FLICKER = 'false'

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
