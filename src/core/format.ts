/** CJK characters occupy 2 terminal columns; padEnd/padStart count
 *  string length (=1 per char), which breaks alignment with mixed text. */

export function charColumns(c: string): number {
  const code = c.codePointAt(0) ?? 0
  if (code < 0x20) return 0                              // control
  if (code < 0x7F) return 1                              // ASCII
  if (code < 0xA0) return 0                              // C1 controls
  // East-Asian wide / fullwidth ranges
  if ((code >= 0x1100 && code <= 0x115F) ||              // Hangul Jamo
      (code >= 0x2E80 && code <= 0xA4CF) ||              // CJK Radicals … Yi
      (code >= 0xAC00 && code <= 0xD7A3) ||              // Hangul
      (code >= 0xF900 && code <= 0xFAFF) ||              // CJK Compat
      (code >= 0xFE10 && code <= 0xFE6F) ||              // Vertical / Compat
      (code >= 0xFF01 && code <= 0xFF60) ||              // Fullwidth
      (code >= 0xFFE0 && code <= 0xFFE6) ||              // Fullwidth signs
      (code >= 0x1F300 && code <= 0x1F64F) ||            // Misc Symbols (emoji)
      (code >= 0x20000 && code <= 0x3FFFD))              // SIP / TIP
    return 2
  return 1
}

export function visualWidth(s: string): number {
  let w = 0; for (const c of s) w += charColumns(c); return w
}

export function visualPadEnd(s: string, cols: number): string {
  const pad = cols - visualWidth(s)
  return pad > 0 ? s + " ".repeat(pad) : s
}

/** Truncate `s` to fit within `maxCols` visual columns, appending "…" when cut. */
export function truncateVisual(s: string, maxCols: number): string {
  if (visualWidth(s) <= maxCols) return s
  let result = "", w = 0
  for (const c of s) {
    const cw = charColumns(c)
    if (w + cw > maxCols - 1) { result += "\u2026"; break }
    result += c; w += cw
  }
  return result
}

export function progressBar(percent: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, percent))
  const filled = Math.round((clamped / 100) * width)
  const empty = Math.max(0, width - filled)
  return "\u2588".repeat(filled) + "\u2591".repeat(empty)
}

export function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 10_000) return (n / 1_000).toFixed(1) + "K"
  return n.toLocaleString("en-US")
}

export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

export function fmtCost(n: number, symbol = "$", rate = 1): string {
  const v = n * rate
  if (v >= 1) return symbol + v.toFixed(2)
  if (v >= 0.01) return symbol + v.toFixed(3)
  return symbol + v.toFixed(4)
}

/** 紧凑数字缩写（底部状态栏用）：1234 → "1.2K"，1234567 → "1.2M"。 */
export function fmtCompact(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M"
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K"
  return String(Math.round(n))
}

/** 余额数值格式化：≥1 或 0 显示固定 2 位小数；小额（<1）保留精度（最多 6 位），避免抹成 0.00。 */
export function formatBalanceAmount(total: string): string {
  const n = parseFloat(total)
  if (!Number.isFinite(n)) return total
  if (n === 0 || n >= 1) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 })
}
