/**
 * 货币类型定义及符号映射。
 * 基于 Unicode Currency Symbols 区块（U+20A0–U+20CF）及常用货币符号。
 */

/** 支持的货币种类列表（运行时值，可用于 zod enum） */
export const CURRENCIES = ['CNY', 'USD', 'EUR', 'GBP', 'JPY', 'KRW', 'INR', 'RUB', 'BTC'] as const

/** 支持的货币种类 */
export type Currency = (typeof CURRENCIES)[number]

/** 货币符号映射 */
export const CURRENCY_SYMBOLS: Record<Currency, string> = {
  CNY: '¥',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  KRW: '₩',
  INR: '₹',
  RUB: '₽',
  BTC: '₿',
}

/** 默认货币 */
export const DEFAULT_CURRENCY: Currency = 'CNY'

/**
 * 获取货币符号，未知货币回退到货币代码本身。
 * CNY 和 JPY 共用 ¥ 符号，JPY 前缀 JP 以区分。
 */
export function getCurrencySymbol(currency: Currency): string {
  if (currency === 'JPY') return 'JP¥'
  return CURRENCY_SYMBOLS[currency] ?? currency
}
