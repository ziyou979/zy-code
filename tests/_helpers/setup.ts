/**
 * bun test 进程预加载（由 bunfig.toml 的 [test] preload 注入）。
 *
 * 部分开发 shell 全局导出了 NODE_ENV（如 development），会覆盖 bun 为
 * 测试进程注入 'test' 的默认值，令 src 中两处依赖 NODE_ENV==='test' 的
 * 测试契约同时失效：
 *   1) src/services/config/config.ts 守卫的豁免分支——读盘前未显式
 *      enableConfigs 的路径会抛 "Config accessed before allowed"；
 *   2) src/ink/reconciler.ts 提交后立即 onImmediateRender 的同步渲染分支——
 *      Ink 渲染类测试在 render() 后读首帧会拿到 null/空帧。
 * 在此统一强制 'test'，使 AGENTS.md 规定的裸 `bun test` 与 package.json
 * 的 `bun run test`（脚本内也显式 NODE_ENV=test）行为一致。
 *
 * 另外把用户数据目录（ZY_CONFIG_DIR，src/services/infra/envUtils.ts 的
 * 用户目录解析入口）指向进程专属空目录：bun test 文件并发共享进程级
 * 单例（languageStore），若放行本机 ~/.zy/settings.json，任何真实读盘
 * 都会经 settings.ts 的 setLanguage 推送个人语言偏好，与其他文件的
 * 显式 setLanguage('en') 用例产生竞态。外部显式设置的 ZY_CONFIG_DIR
 * 优先保留（如 testDataDirectory helper 在用例内自行接管与恢复）。
 */
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'

if (!process.env.ZY_CONFIG_DIR) {
  const testConfigDir = join(tmpdir(), `zy-code-test-home-${process.pid}`)
  mkdirSync(testConfigDir, { recursive: true })
  process.env.ZY_CONFIG_DIR = testConfigDir
}
