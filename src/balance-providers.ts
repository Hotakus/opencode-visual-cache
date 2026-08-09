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

const siliconflowProvider: BalanceProvider = {
  id: "siliconflow",
  name: "SiliconFlow",
  keyPlaceholder: "sk-...",
  async fetchBalance(apiKey, signal) {
    // 国内站 api.siliconflow.cn（CNY）；国际站为 api.siliconflow.com（USD）
    const res = await fetch("https://api.siliconflow.cn/v1/user/info", {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal,
    })
    if (!res.ok) {
      if (res.status === 401) throw new BalanceError("401")
      if (res.status === 403) throw new BalanceError("403")
      throw new BalanceError(String(res.status))
    }
    const json = await res.json() as {
      status?: boolean
      data?: {
        balance?: string | number
        chargeBalance?: string | number
        totalBalance?: string | number
      }
    }
    // totalBalance 为总余额（含充值+赠送），缺失时回退 balance
    const total = json.data?.totalBalance ?? json.data?.balance
    if (typeof total === "undefined" || total === null) throw new BalanceError("EMPTY")
    return [{ currency: "CNY", total: String(total) }]
  },
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

const openrouterProvider: BalanceProvider = {
  id: "openrouter",
  name: "OpenRouter",
  keyPlaceholder: "sk-or-...",
  async fetchBalance(apiKey, signal) {
    // 官方文档标注需 Management key，实测普通 API key 亦可查询账户余额
    const res = await fetch("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal,
    })
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new BalanceError("403")
      throw new BalanceError(String(res.status))
    }
    const json = await res.json() as {
      data?: { total_credits?: number; total_usage?: number }
    }
    const credits = json.data?.total_credits
    const usage = json.data?.total_usage
    if (typeof credits !== "number" || typeof usage !== "number") throw new BalanceError("EMPTY")
    // 剩余额度 = 充值总额 - 已用
    return [{ currency: "USD", total: (credits - usage).toFixed(2) }]
  },
}

const moonshotProvider: BalanceProvider = {
  id: "moonshot",
  name: "Moonshot",
  keyPlaceholder: "sk-...",
  async fetchBalance(apiKey, signal) {
    // 国内站 api.moonshot.cn（CNY）；国际站 api.moonshot.ai（USD）
    const res = await fetch("https://api.moonshot.cn/v1/users/me/balance", {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal,
    })
    if (!res.ok) {
      if (res.status === 401) throw new BalanceError("401")
      if (res.status === 403) throw new BalanceError("403")
      throw new BalanceError(String(res.status))
    }
    const json = await res.json() as {
      data?: { available_balance?: string | number }
    }
    const balance = json.data?.available_balance
    if (typeof balance === "undefined" || balance === null) throw new BalanceError("EMPTY")
    return [{ currency: "CNY", total: String(balance) }]
  },
}

/** 已注册的 provider 列表（按需追加新适配器）。 */
export const balanceProviders: BalanceProvider[] = [deepseekProvider, siliconflowProvider, openrouterProvider, moonshotProvider]

/** 按 id 取 provider；未知 id 回退到第一个。 */
export function getBalanceProvider(id: string): BalanceProvider {
  return balanceProviders.find((p) => p.id === id) ?? balanceProviders[0] ?? deepseekProvider
}

/**
 * 按 OpenCode providerID 匹配余额 provider。
 * 先精确匹配，再按前缀匹配（如 moonshotai-cn → moonshot）；未命中返回 undefined。
 */
export function matchBalanceProvider(providerId: string): BalanceProvider | undefined {
  const exact = balanceProviders.find((p) => p.id === providerId)
  if (exact) return exact
  return balanceProviders.find((p) => providerId.startsWith(p.id))
}

/** key 脱敏：保留头 5 尾 5 字符，中间用 * 填充。 */
export function maskKey(k: string): string {
  if (!k) return ""
  if (k.length <= 10) return k.slice(0, 5) + "*".repeat(Math.max(3, k.length - 5))
  return k.slice(0, 5) + "*".repeat(Math.max(3, k.length - 10)) + k.slice(-5)
}
