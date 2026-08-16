import type { BalanceEntry } from "../balance-providers"
import { formatBalanceAmount } from "./format"

export const CURRENCIES: Record<string, string> = {
  USD: "$", CNY: "¥", EUR: "€", JPY: "JP¥", GBP: "£", KRW: "₩",
}
/** Approximate USD exchange rates — used as defaults when switching currency.
 *  Users can override via /cache-rate.  Last updated 2026-05. */
export const DEFAULT_RATES: Record<string, number> = {
  USD: 1, CNY: 7.2, EUR: 0.92, JPY: 150, GBP: 0.79, KRW: 1350,
}

/**
 * 将余额从来源币种换算为目标币种。
 * DEFAULT_RATES 以 USD=1 为基准：先折算为 USD，再换算到目标币种。
 */
export function convertBalance(target: string, targetRate: number, amount: number, from: string): number {
  if (from === target) return amount
  const fromRate = DEFAULT_RATES[from] ?? 1
  const usd = from === "USD" ? amount : amount / fromRate
  return target === "USD" ? usd : usd * targetRate
}

/** 货币符号：优先取 /cache-currency 内置映射，未知币种回退为代码。 */
export function balanceSymbol(currency: string): string {
  const sym = CURRENCIES[currency]
  return sym ?? currency + " "
}

/**
 * 将余额列表格式化为单行文本。
 * 优先直接显示偏好币种（CNY/USD…）；偏好币种为换算币种时按汇率折算第一条余额。
 */
export function formatBalanceText(list: BalanceEntry[], pref: string, rate: number): string {
  const native = pref ? list.find((x) => x.currency === pref) : undefined
  if (native) return balanceSymbol(native.currency) + formatBalanceAmount(native.total)
  const base = list[0]
  const baseAmt = parseFloat(base.total)
  const converted = Number.isFinite(baseAmt)
    ? convertBalance(pref || base.currency, rate, baseAmt, base.currency)
    : baseAmt
  const shown = pref && base.currency !== pref
    ? converted.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : formatBalanceAmount(base.total)
  return balanceSymbol(pref || base.currency) + shown
}
