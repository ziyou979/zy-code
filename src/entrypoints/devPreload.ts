// Dev-mode preload: defines build-time macros that Bun.build() normally injects.
// Loaded via `bun --preload` before cli.tsx — never shipped in production builds.
// 注意：feature() 是 bun:bundle 的编译期宏，dev 下只能通过 `bun --feature=NAME`
// 命令行标志注入（见 package.json 的 dev 脚本），设置 Bun.features 无效。

process.env.USER_TYPE = 'external'

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
