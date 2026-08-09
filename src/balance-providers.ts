// ---------------------------------------------------------------------------
// Balance providers — pluggable account-balance query adapters.
// ---------------------------------------------------------------------------

/** 归一化后的余额条目——显示层与具体 provider 解耦。 */
export interface BalanceEntry {
  currency: string   // 原生币种（CNY/USD…），复用现有汇率换算
  total: string      // 余额字符串
}

/** provider 统一错误：message 即错误码（401/403/EMPTY/…），显示层直接展示。 */
export class BalanceError extends Error {}

/** 可插拔的余额 provider 适配器。 */
export interface BalanceProvider {
  id: string                    // 唯一标识，同时用作 KV key 命名空间
  name: string                  // 显示名（专有名词，无需 i18n）
  keyPlaceholder?: string       // key 输入框占位（如 "sk-..."）
  fetchBalance(apiKey: string, signal?: AbortSignal): Promise<BalanceEntry[]>
}

const deepseekProvider: BalanceProvider = {
  id: "deepseek",
  name: "DeepSeek",
  keyPlaceholder: "sk-...",
  async fetchBalance(apiKey, signal) {
    const res = await fetch("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal,
    })
    if (!res.ok) {
      if (res.status === 401) throw new BalanceError("401")
      if (res.status === 402 || res.status === 403) throw new BalanceError("403")
      throw new BalanceError(String(res.status))
    }
    const json = await res.json() as {
      is_available?: boolean
      balance_infos?: { currency: string; total_balance: string; granted_balance: string; topped_up_balance: string }[]
    }
    const infos = json.balance_infos ?? []
    if (infos.length === 0) throw new BalanceError("EMPTY")
    return infos.map((info) => ({
      currency: info.currency ?? "CNY",
      total: info.total_balance ?? "0",
    }))
  },
}

/** 已注册的 provider 列表（按需追加新适配器）。 */
export const balanceProviders: BalanceProvider[] = [deepseekProvider]

/** 按 id 取 provider；未知 id 回退到第一个。 */
export function getBalanceProvider(id: string): BalanceProvider {
  return balanceProviders.find((p) => p.id === id) ?? balanceProviders[0] ?? deepseekProvider
}

/** key 脱敏：保留头 5 尾 5 字符，中间用 * 填充。 */
export function maskKey(k: string): string {
  if (!k) return ""
  if (k.length <= 10) return k.slice(0, 5) + "*".repeat(Math.max(3, k.length - 5))
  return k.slice(0, 5) + "*".repeat(Math.max(3, k.length - 10)) + k.slice(-5)
}
