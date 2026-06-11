// Dev-mode preload: defines build-time macros that Bun.build() normally injects.
// Loaded via `bun --preload` before cli.tsx — never shipped in production builds.

process.env.USER_TYPE = 'external'

// 注入 build features，使 true 等在 dev 下为 true
if (typeof Bun !== 'undefined') {
  // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
  ;(Bun as any).features = [
    // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
    ...((Bun as any).features || []),
    'FORK_SUBAGENT',
    'REACTIVE_COMPACT',
    'TOKEN_BUDGET',
    'CONTEXT_COLLAPSE',
    'KAIROS',
  ]
}

// dev 下启用 auto mode（绕过 GrowthBook 远程配置默认 disabled）
process.env.ZY_CODE_DEV_AUTO_MODE = '1'

// dev 下启用全屏渲染器（alt-screen + 虚拟滚动）
process.env.ZY_CODE_NO_FLICKER = '1'

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
