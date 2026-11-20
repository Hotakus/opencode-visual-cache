import type { Context, MessageInfo } from "./types"
import { num, aggregateSubtreeTotals, withSnapshot, type AggregateOpts } from "../core"

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

function subtreeOpts(context: Context, isDeleted?: (id: string) => boolean): AggregateOpts { return { getMessages: (id) => context.data.session.message.list(id) ?? [], getToolParts: (m) => (Array.isArray(m?.content) ? m.content : []), getSession: (id) => context.data.session.get(id), listSessions: () => context.data.session.list(), isDeleted } }

/** 从 messages 汇总 token：统计全部 assistant 消息的 API 精确值。 */
export function collectSessionStats(context: Context, sessionID: string): SessionStats {
  const t = aggregateSubtreeTotals(sessionID, subtreeOpts(context))
  return { input: t.input, output: t.output, cacheRead: t.read, cacheWrite: t.write, reasoning: t.reasoning, cost: t.cost, hasData: t.hasData }
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
} {
  const msgs = context.data.session.message.list(sessionID) ?? []
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
  return { hitRate, prevHitRate }
}

/** Token total of a session and all its sub-agents; with `rows` (the adapter's snapshot) no descendant history is read. */
export function collectSubtreeTokens(context: Context, sessionID: string, isDeleted?: (id: string) => boolean, rows?: Parameters<typeof withSnapshot>[2]): number {
  const t = aggregateSubtreeTotals(sessionID, withSnapshot(subtreeOpts(context, isDeleted), sessionID, rows))
  return t.input + t.read + t.write + t.output + t.reasoning
}

export type { MessageInfo }
