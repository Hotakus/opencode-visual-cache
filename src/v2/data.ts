import type { Context, MessageInfo } from "./types"
import { num } from "../core"

/** 汇总一个会话的 token 用量与费用（V2 adapter → 同构模型）。 */
export interface SessionStats {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  cost: number
  hasData: boolean
}

/** 从 messages 汇总 token：统计全部 assistant 消息的 API 精确值。 */
export function collectSessionStats(context: Context, sessionID: string): SessionStats {
  const msgs = context.data.session.message.list(sessionID) ?? []
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let reasoning = 0
  let cost = 0
  let hasData = false

  for (const m of msgs) {
    if (m.type !== "assistant") continue
    const t = m.tokens
    if (!t) continue
    input += num(t.input)
    output += num(t.output)
    reasoning += num(t.reasoning)
    cacheRead += num(t.cache?.read)
    cacheWrite += num(t.cache?.write)
    hasData = true
  }
  // 会话级费用优先（V2 提供 cost()），消息级 cost 兜底（结构未知，宽松读取）
  const sessionCost = context.data.session.cost(sessionID)
  if (Number.isFinite(sessionCost) && sessionCost > 0) cost = sessionCost
  else {
    for (const m of msgs) {
      if (m.type !== "assistant" || m.cost == null) continue
      const c = m.cost as { amount?: unknown; total?: unknown } | { amount?: unknown } | number
      if (typeof c === "number" && Number.isFinite(c)) cost += c
      else {
        const amt = (c as { amount?: unknown }).amount
        if (typeof amt === "number" && Number.isFinite(amt)) cost += amt
        else if (typeof amt === "string") {
          const n = parseFloat(amt)
          if (Number.isFinite(n)) cost += n
        }
      }
    }
  }
  return { input, output, cacheRead, cacheWrite, reasoning, cost, hasData }
}

/** 缓存命中率（0–100）：缓存读 /（新鲜输入 + 缓存读 + 缓存写），与 V1 口径一致。 */
export function hitRate(stats: SessionStats): number {
  const denom = stats.input + stats.cacheRead + stats.cacheWrite
  if (denom <= 0) return 0
  return (stats.cacheRead / denom) * 100
}

/** 输入侧总量（底部栏口径，不含输出）。 */
export function inputTotal(stats: SessionStats): number {
  return stats.input + stats.cacheRead + stats.cacheWrite
}

/** 单条命中率（V1 底部栏口径）：最后一条有 token 的 assistant 消息，
 *  分母含缓存写 read/(input+read+write)；prevHitRate 为上一条（趋势用）。 */
export function collectLastHitRate(context: Context, sessionID: string): {
  hitRate: number
  prevHitRate: number
  input: number
  read: number
  write: number
} {
  const msgs = context.data.session.message.list(sessionID) ?? []
  const session = context.data.session.get(sessionID) as { tokens?: { input?: number; cache?: { read?: number; write?: number } } } | undefined
  let input = num(session?.tokens?.input)
  let read = num(session?.tokens?.cache?.read)
  let write = num(session?.tokens?.cache?.write)
  // 无 session 聚合字段 → 遍历消息累加（与 V1 fallback 一致）
  if (session?.tokens == null) {
    for (const m of msgs) {
      if (m.type !== "assistant") continue
      const t = m.tokens
      if (!t) continue
      input += num(t.input)
      read += num(t.cache?.read)
      write += num(t.cache?.write)
    }
  }
  let hitRate = -1, prevHitRate = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.type !== "assistant") continue
    const tk = m.tokens
    if (!tk) continue
    const mit = num(tk.input) + num(tk.cache?.read) + num(tk.cache?.write)
    const mrt = num(tk.cache?.read)
    if (mit <= 0) continue
    const rate = (mrt / mit) * 100
    if (hitRate < 0) { hitRate = rate; continue }
    prevHitRate = rate
    break
  }
  return { hitRate, prevHitRate, input, read, write }
}

export type { MessageInfo }
