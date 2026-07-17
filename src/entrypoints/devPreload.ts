// Dev-mode preload: defines build-time macros that Bun.build() normally injects.
// Loaded via `bun --preload` before cli.tsx — never shipped in production builds.

process.env.USER_TYPE = 'external'

// 注入 build features，使 true 等在 dev 下为 true
if (typeof Bun !== 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Bun type may not have features
  interface BunWithFeatures {
    features: string[]
  }
  ;(Bun as unknown as BunWithFeatures).features = [
    ...((Bun as unknown as BunWithFeatures).features || []),
    'FORK_SUBAGENT',
    'REACTIVE_COMPACT',
    'TOKEN_BUDGET',
    'CONTEXT_COLLAPSE',
    'KAIROS',
  ]
}

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
