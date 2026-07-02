/**
 * 货币类型定义及符号映射。
 * 基于 Unicode Currency Symbols 区块（U+20A0–U+20CF）及常用货币符号。
 */

/** 支持的货币种类 */
export type Currency =
  | 'CNY' // 人民币
  | 'USD' // 美元
  | 'EUR' // 欧元
  | 'GBP' // 英镑
  | 'JPY' // 日元
  | 'KRW' // 韩元
  | 'INR' // 印度卢比
  | 'RUB' // 俄罗斯卢布
  | 'BTC' // 比特币

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
