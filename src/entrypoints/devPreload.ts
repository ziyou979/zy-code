// Dev-mode preload: mirrors the build-time MACRO injections that Bun.build()
// bakes into dist/ (see build.ts), while keeping the source runtime in dev mode.
// Loaded via `bun --preload` before cli.tsx — never shipped in production builds.
// 注意：feature() 是 bun:bundle 的编译期宏，dev 下只能通过 `bun --feature=NAME`
// 命令行标志注入（见 package.json 的 dev 脚本），设置 Bun.features 无效。
// dev 脚本与 build.ts 的 feature 清单一致性由
// tests/scripts/devBuildFeatureParity.test.ts 守门。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 源码入口必须使用 React development runtime。Bun 直接执行 TSX 时若在 preload
// 中切到 production，react-reconciler 不会提交 Ink 首帧，终端只完成清屏而没有
// 欢迎页。dist 仍由 build 脚本在 NODE_ENV=production 下生成，两条路径各自使用
// 与其执行方式匹配的 React 变体。
process.env.NODE_ENV = 'development'

process.env.USER_TYPE = 'external'

// 版本号 = package.json 真实版本 + `-dev` 后缀：
// 1. release-notes / 自动更新等链路按 semver 比较，之前的硬编码 'dev' 会被
//    coerce() 判为 null，导致"已读"判断失效（每次启动都渲染完整 Logo +
//    release notes，且与 dist 交叉启动时互相覆盖 lastReleaseNotesSeen）；
// 2. `-dev` 是合法 prerelease（0.0.1-dev < 0.0.1），比较语义与 dist 自洽，
//    同时 UI 上的 v0.0.1-dev 可与 dist 的 v0.0.1 区分。
const packageJson = JSON.parse(
  readFileSync(join(import.meta.dir, '../../package.json'), 'utf-8'),
) as { version: string }

Object.assign(globalThis, {
  MACRO: {
    VERSION: `${packageJson.version}-dev`,
    BUILD_TIME: new Date().toISOString(),
    PACKAGE_URL: '@zy-ai/zy-code',
    NATIVE_PACKAGE_URL: null,
    FEEDBACK_CHANNEL: 'https://github.com/ziyou979/zy-code/issues',
    ISSUES_EXPLAINER: 'report the issue at https://github.com/ziyou979/zy-code/issues',
    VERSION_CHANGELOG: '',
  },
})
