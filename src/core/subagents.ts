import { estimateTokens } from "./estimate"
import { num } from "./format"

const SUBAGENT_TOOLS = new Set(["task", "subagent", "delegate", "call_omo_agent"])

interface DiscoveredChildSession {
  id: string
  agent: string
  title: string
  description: string
  prompt: string
}

interface SessionTotals {
  input: number
  read: number
  write: number
  output: number
  reasoning: number
  cost: number
  hasData: boolean
}

interface SubtreeTotals extends SessionTotals {
  subagentTokens: number
  descendants: DiscoveredChildSession[]
}

interface DiscoverOpts {
  getMessages: (sid: string) => readonly any[] | undefined
  getToolParts: (msg: any) => readonly any[]
  listSessions?: () => readonly { id: string; parentID?: string; title?: string; agent?: string }[]
  isDeleted?: (sid: string) => boolean
}

export interface AggregateOpts extends DiscoverOpts {
  getSession: (sid: string) => any
}

export function extractSubagentSessionId(part: Record<string, any> | undefined): string | undefined {
  for (const meta of [part?.state?.metadata, part?.metadata]) {
    const v = meta?.sessionID ?? meta?.session_id ?? meta?.sessionId
    if (v !== null && v !== undefined && v !== "") return String(v)
  }
  return undefined
}

export function discoverDescendantSessions(rootSid: string, opts: DiscoverOpts): DiscoveredChildSession[] {
  const out: DiscoveredChildSession[] = []
  const queue = [rootSid]
  const visited = new Set([rootSid])
  const all = opts.listSessions?.() ?? []
  // grouped by parent once: a scan of the whole list for every queued session froze large trees
  const byParent = new Map<string, (typeof all)[number][]>()
  for (const s of all) {
    const p = s.parentID
    if (p == null) continue
    const kids = byParent.get(p)
    if (kids) kids.push(s); else byParent.set(p, [s])
  }

  for (let i = 0; i < queue.length; i++) {
    const sid = queue[i]
    for (const m of opts.getMessages(sid) ?? []) {
      for (const p of opts.getToolParts(m)) {
        if (p?.type !== "tool" || !SUBAGENT_TOOLS.has(String(p.tool ?? p.name ?? ""))) continue
        const id = extractSubagentSessionId(p)
        if (id === undefined || visited.has(id) || opts.isDeleted?.(id)) continue
        visited.add(id)
        const input = p.state?.input
        const agent = String(p.subagent_type ?? input?.subagent_type ?? input?.category ?? p.tool ?? p.name)
        const prompt = String(input?.prompt ?? "")
        const description = input?.description ? String(input.description) : ""
        const title = description || prompt.replace(/\n/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || agent
        out.push({ id, agent, title, description, prompt })
        queue.push(id)
      }
    }
    for (const s of byParent.get(sid) ?? []) {
      if (visited.has(s.id) || opts.isDeleted?.(s.id)) continue
      visited.add(s.id)
      const agent = s.agent ?? "subagent"
      out.push({ id: s.id, agent, title: s.title ?? agent, description: "", prompt: "" })
      queue.push(s.id)
    }
  }
  return out
}

export function readSingleSessionTotals(sid: string, opts: AggregateOpts): SessionTotals {
  const s = opts.getSession(sid)
  const msgs = opts.getMessages(sid) ?? []
  const assistant = msgs.filter((m) => m?.role === "assistant" || m?.type === "assistant")
  const tokens = s?.tokens
  let input = 0
  let read = 0
  let write = 0
  let output = 0
  let reasoning = 0
  let hasData = tokens != null

  if (tokens != null) {
    input = num(tokens.input)
    read = num(tokens.cache?.read)
    write = num(tokens.cache?.write)
    output = num(tokens.output)
    reasoning = num(tokens.reasoning)
  } else {
    for (const m of assistant) {
      if (m?.tokens == null) continue
      hasData = true
      input += num(m.tokens.input)
      read += num(m.tokens.cache?.read)
      write += num(m.tokens.cache?.write)
      output += num(m.tokens.output)
      reasoning += num(m.tokens.reasoning)
    }
  }

  const sc = s?.cost
  let cost = 0
  if (typeof sc === "number" && Number.isFinite(sc) && sc > 0) {
    cost = sc
  } else {
    for (const m of assistant) {
      const value = m?.cost
      if (typeof value === "number") {
        if (Number.isFinite(value)) cost += value
      } else if (value && typeof value === "object" && (typeof value.amount === "number" || typeof value.amount === "string")) {
        const amount = parseFloat(String(value.amount))
        if (Number.isFinite(amount)) cost += amount
      }
    }
  }

  return { input, read, write, output, reasoning, cost, hasData }
}

export function aggregateSubtreeTotals(rootSid: string, opts: AggregateOpts): SubtreeTotals {
  const descendants = discoverDescendantSessions(rootSid, opts)
  const totals: SubtreeTotals = { ...readSingleSessionTotals(rootSid, opts), subagentTokens: 0, descendants }
  for (const d of descendants) {
    const child = readSingleSessionTotals(d.id, opts)
    totals.input += child.input
    totals.read += child.read
    totals.write += child.write
    totals.output += child.output
    totals.reasoning += child.reasoning
    totals.cost += child.cost
    const tokens = child.input + child.read + child.write + child.output + child.reasoning
    totals.subagentTokens += tokens > 0 ? tokens : estimateTokens(d.prompt || d.description)
  }
  return totals
}

/** With `rows` (the record of the root and of every descendant, read in one go) the totals come from those rows alone: a session outside `rows` is not counted and no descendant's message history is read. */
export function withSnapshot(opts: AggregateOpts, rootSid: string, rows: readonly { id: string; parentID?: string; title?: string; agent?: string }[] | undefined): AggregateOpts {
  if (!rows) return opts
  const byId = new Map(rows.map((s) => [s.id, s]))
  return { ...opts, listSessions: () => rows, isDeleted: (sid) => !byId.has(sid), getSession: (sid) => byId.get(sid) ?? opts.getSession(sid), getMessages: (sid) => (sid === rootSid ? opts.getMessages(sid) : []) }
}
