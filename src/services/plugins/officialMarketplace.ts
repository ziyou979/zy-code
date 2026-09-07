/**
 * Constants for the official plugins marketplace.
 *
 * The official marketplace is hosted on GitHub and provides official
 * plugins. This file defines the constants needed
 * to install and identify this marketplace.
 */

import type { MarketplaceSource } from './schemas.js'

// TODO: 目前没有自建 marketplace，临时指向 Claude 官方 marketplace
// （anthropics/claude-plugins-official，真实存在）。自建 marketplace
// 上线后，把 SOURCE.repo 和 NAME 换成自有仓库，并同步更新
// officialMarketplaceGcs.ts 的 GCS 发布路径与 installCounts.ts 的统计地址。
/**
 * Source configuration for the official plugins marketplace.
 * Used when auto-installing the marketplace on startup.
 */
export const OFFICIAL_MARKETPLACE_SOURCE = {
  source: 'github',
  repo: 'anthropics/claude-plugins-official',
} as const satisfies MarketplaceSource

/**
 * Display name for the official marketplace.
 * This is the name under which the marketplace will be registered
 * in the known_marketplaces.json file.
 * 必须与仓库内 .claude-plugin/marketplace.json 的 name 字段一致，
 * 否则注册名对不上，自动安装的幂等检查会失效。
 */
export const OFFICIAL_MARKETPLACE_NAME = 'claude-plugins-official'
