import type { Context } from "./types"
import type { PanelApi, PanelSession } from "../panel/panel-api"
import { createSignal, getOwner, onCleanup, untrack } from "solid-js"
import { discoverDescendantSessions, num, readSingleSessionTotals, throttle } from "../core"
import { credentialsDbReady, readSessionSubtree } from "./credentials"

/**
 * V2 (opencode2) context → PanelApi 适配实现。
 * 核心能力（session/messages/tokens/storage/event/renderer/part）完整映射；
 * 无 V2 对应的能力（config）以空值兜底。
 */
export function createPanelApi(context: Context, db = { ready: credentialsDbReady, read: readSessionSubtree }): PanelApi {
  // storage.store 持久化 → PanelApi.kv 语义
  const kvStore = new Map<string, [Record<string, any>, (fn: (d: Record<string, any>) => void) => Promise<void>]>()

  // 消息索引：messages() 填充，part() 按 messageID 查（V2 无全局 message.get）
  const messageIndex = new Map<string, Record<string, any>>()
  const deleted = new Set<string>()
  const syncInFlight = new Map<string, Promise<void>>()
  const pagedMessages = new Map<string, Record<string, any>[]>()
  // Sub-agent totals: one read of the host database per refresh, shared by the panel and the footer (PB2-26).
  // Only when that database cannot be read are the records fetched from the server instead; a message history never is.
  const [subtreeVersion, setSubtreeVersion] = createSignal(0)
  let snapshots = new Map<string, readonly PanelSession[] | undefined>()
  let previous = snapshots
  const interest = new Map<string, number>()
  const walked = new Set<string>()
  const walking = new Set<string>()
  let source: "db" | "records" | undefined
  let ready = false
  let disposed = false
  const bumpSubtree = throttle(() => { if (disposed) return; previous = snapshots; snapshots = new Map(); setSubtreeVersion((v) => v + 1) })
  // nothing is read before the database has opened or failed; the first read of a session then chooses the source
  void db.ready().then(() => { if (disposed) return; ready = true; setSubtreeVersion((v) => v + 1) })
  // the numbers come from the database only. An event can arrive before its commit, so one more read follows 1 s after the last event
  // shortcut: a commit later than that shows at the next event, upgrade when the host offers a notification after its commit
  let late: ReturnType<typeof setTimeout> | undefined
  const changed = () => { bumpSubtree(); clearTimeout(late); late = setTimeout(bumpSubtree, 1000) }
  const rowToSession = (r: Record<string, any>): PanelSession => {
    let model: PanelSession["model"]
    try { const m = JSON.parse(r.model); model = { providerID: m?.providerID, id: m?.id } } catch {}
    return { id: String(r.id), parentID: r.parent_id ?? undefined, title: r.title ?? undefined, agent: r.agent ?? undefined, model, cost: num(r.cost), tokens: { input: num(r.tokens_input), output: num(r.tokens_output), reasoning: num(r.tokens_reasoning), cache: { read: num(r.tokens_cache_read), write: num(r.tokens_cache_write) } } }
  }
  // records fallback: the tree as the store knows it; one round per tree level, one session at a time, one publication per round
  const tree = (rootId: string) => [rootId, ...discoverDescendantSessions(rootId, { getMessages: () => [], getToolParts: () => [], listSessions: () => context.data.session.list(), isDeleted: (id) => deleted.has(id) }).map((s) => s.id)]
  const walkRecords = async (rootId: string, retry = true) => {
    const sessApi = context.data.session as Record<string, any>
    if (walking.has(rootId) || typeof sessApi.sync !== "function") return
    walking.add(rootId)
    // no consumer asks for this root any more (session switch) or the plugin is gone: nothing new is started or published
    const stale = () => disposed || !interest.get(rootId)
    const tried = new Set<string>() // a failed sync is tried again by the next walk, not by this one
    const todo = () => tree(rootId).filter((id) => !walked.has(id) && !tried.has(id))
    for (let ids: string[]; !stale() && (ids = todo()).length > 0; ) {
      for (const id of ids) { if (stale()) break; tried.add(id); try { await sessApi.sync(id, { children: true }); walked.add(id) } catch {} }
      if (!stale() && ids.some((id) => walked.has(id))) bumpSubtree()
    }
    if (stale()) { walking.delete(rootId); snapshots.delete(rootId) } // asked for again, the walk starts again
    // a walk in which a sync failed may have published nothing, so one more walk follows a second later. The guard stays set until then: a consumer that asks meanwhile starts no second walk
    else if (retry && [...tried].some((id) => !walked.has(id))) setTimeout(() => { walking.delete(rootId); if (stale()) snapshots.delete(rootId); else void walkRecords(rootId, false) }, 1000)
    else walking.delete(rootId)
  }
  const eventId = (e: any) => e?.properties?.sessionID ?? e?.properties?.info?.id ?? e?.sessionID ?? e?.info?.id ?? e?.data?.sessionID ?? e?.data?.info?.id ?? e?.id
  const unsubCreated = context.data.on("session.created", (e) => {
    const id = eventId(e)
    if (typeof id === "string") { deleted.delete(id); pagedMessages.delete(id) }
    changed()
  })
  const unsubDeleted = context.data.on("session.deleted", (e) => {
    const id = eventId(e)
    if (typeof id === "string") { deleted.add(id); pagedMessages.delete(id) }
    changed()
  })
  const unsubUsage = context.data.on("session.usage.updated", changed)
  const listRawMessages = (id: string): readonly Record<string, any>[] => {
    const live = (context.data.session.message.list(id) ?? []) as unknown as Record<string, any>[]
    const paged = pagedMessages.get(id)
    if (!paged || paged.length === 0) return live
    const liveById = new Map(live.filter((m) => m?.id).map((m) => [m.id, m] as const))
    const merged = paged.map((m) => liveById.get(m?.id) ?? m)
    const seen = new Set(paged.filter((m) => m?.id).map((m) => m.id))
    const tail = live.filter((m) => !m?.id || !seen.has(m.id))
    return tail.length > 0 ? [...merged, ...tail] : merged
  }

  /** V2 content part → V1 Part 形状（TokenCachePanel 分布/技能区块消费）。
   *  V2 tool 输出在 state.content[]（Content = TextContent | FileContent），
   *  归一化为 V1 的 state.output 字符串；input 为字符串时保持（Streaming 态）。 */
  const toV1Part = (p: Record<string, any>): Record<string, any> => {
    if (p.type === "tool") {
      const st = { ...(p.state ?? {}) }
      if (st.output === undefined && Array.isArray(st.content)) {
        st.output = (st.content as Array<Record<string, any>>)
          .map((c) => c.type === "text" ? c.text : c.type === "file" ? String(c.path ?? c.filename ?? "") : JSON.stringify(c))
          .filter((t): t is string => typeof t === "string" && t.length > 0)
          .join("\n")
      }
      return { type: "tool", tool: p.tool ?? p.name, state: st, subagent_type: p.subagent_type, metadata: p.metadata }
    }
    if (p.type === "text") {
      return { type: "text", text: String(p.text ?? ""), synthetic: p.synthetic, ignored: p.ignored }
    }
    if (p.type === "file") {
      return { type: "file", source: p.source ?? {} }
    }
    if (p.type === "reasoning") {
      return { type: "reasoning", text: String(p.text ?? "") }
    }
    return p
  }

  const kvGet = <T>(key: string, fallback?: T): T | undefined => {
    let entry = kvStore.get(key)
    if (!entry) {
      // 首次访问：创建 storage.store（V2 恢复磁盘持久化值），避免设置重启丢失
      const created = context.storage.store<Record<string, any>>(`opencode-visual-cache.${key}`, {
        initial: { value: fallback },
      })
      entry = created as [Record<string, any>, (fn: (d: Record<string, any>) => void) => Promise<void>]
      kvStore.set(key, entry)
    }
    const v = entry[0].value
    return v === undefined ? fallback : (v as T)
  }
  const kvSet = (key: string, value: unknown): Promise<void> => {
    let entry = kvStore.get(key)
    if (!entry) {
      const created = context.storage.store<Record<string, any>>(`opencode-visual-cache.${key}`, {
        initial: { value },
      })
      entry = created as [Record<string, any>, (fn: (d: Record<string, any>) => void) => Promise<void>]
      kvStore.set(key, entry)
    }
    const [, mutate] = entry
    return mutate((d) => { d.value = value })
  }

  return {
    kv: {
      ready: true,
      get: kvGet,
      set: kvSet,
    },
    state: {
      session: {
        get(id: string): PanelSession | undefined {
          const s = context.data.session.get(id)
          if (!s) return undefined
          const rec = s as Record<string, any>
          const model = s.model as { providerID?: string; id?: string } | undefined
          const msgTotals = readSingleSessionTotals(s.id, { getMessages: listRawMessages, getToolParts: () => [], getSession: () => undefined })
          const st = rec.tokens as PanelSession["tokens"] | undefined
          const sTokSum = st ? num(st.input) + num(st.output) + num(st.reasoning) + num(st.cache?.read) + num(st.cache?.write) : 0
          const mx = (a: unknown, b: number) => Math.max(num(a), b)
          const sc = typeof rec.cost === "number" && Number.isFinite(rec.cost) ? rec.cost : 0
          return {
            id: s.id,
            title: s.title,
            agent: s.agent,
            tokens: st != null && (sTokSum > 0 || msgTotals.hasData) ? {
              input: mx(st.input, msgTotals.input),
              output: mx(st.output, msgTotals.output),
              reasoning: mx(st.reasoning, msgTotals.reasoning),
              cache: { read: mx(st.cache?.read, msgTotals.read), write: mx(st.cache?.write, msgTotals.write) },
            } : undefined,
            cost: Math.max(sc, msgTotals.cost),
            model: model ? { providerID: model.providerID, id: model.id } : undefined,
          }
        },
        isDeleted: (id: string) => deleted.has(id) || context.data.session.missing?.(id) === true,
        subtree(rootId: string): readonly PanelSession[] | undefined {
          void subtreeVersion()
          if (!rootId || !ready || disposed) return undefined
          // who asks for which root: the memo that calls this registers, and leaves when it reruns or is disposed
          if (getOwner()) { interest.set(rootId, (interest.get(rootId) ?? 0) + 1); onCleanup(() => { const n = interest.get(rootId)! - 1; if (n) interest.set(rootId, n); else interest.delete(rootId) }) }
          if (!snapshots.has(rootId)) {
            // the first read chooses the source; its rows are shown as read. A read that fails after that keeps the last good rows, less the sessions deleted since, and is not repeated in the same refresh
            const raw = source === "records" ? undefined : db.read(rootId)
            source ??= raw ? "db" : "records"
            // no local database, or a session it does not hold (another host's): the records in the store, which the walk fills
            if (source === "records" || raw?.length === 0) snapshots.set(rootId, untrack(() => { void walkRecords(rootId); return tree(rootId).map((id) => context.data.session.get(id) as unknown as PanelSession).filter(Boolean) }))
            else snapshots.set(rootId, raw ? raw.map(rowToSession) : previous.get(rootId)?.filter((s) => !deleted.has(s.id)))
          }
          return snapshots.get(rootId)
        },
        syncMessages: (id: string) => {
          const inflight = syncInFlight.get(id)
          if (inflight) return inflight
          const p = (async () => {
            const sessApi = context.data.session as Record<string, any>
            const msgApi = context.data.session.message as Record<string, any>
            if (!context.data.session.get(id) && typeof sessApi.sync === "function") {
              try { await sessApi.sync(id) } catch {}
            }
            // reload only an empty store: sync() replaces the loaded history with the newest page
            if (listRawMessages(id).length === 0) {
              if (typeof msgApi.invalidate === "function") msgApi.invalidate(id)
              if (typeof msgApi.sync === "function") await msgApi.sync(id)
            }
            if (typeof msgApi.loadMore === "function") {
              if (typeof msgApi.more !== "function" || msgApi.more(id) === true) await msgApi.loadMore(id, { all: true })
            } else {
              const clientList = (context as Record<string, any>).client?.message?.list
              if (typeof clientList === "function" && (context.data.session.message.list(id)?.length ?? 0) >= 20) {
                let cursor: string | undefined
                const pages: Record<string, any>[] = []
                do {
                  const res = await clientList.call((context as Record<string, any>).client.message, cursor ? { sessionID: id, limit: 200, cursor } : { sessionID: id, limit: 200, order: "desc" })
                  if (!Array.isArray(res?.data)) break
                  pages.push(...res.data)
                  cursor = res.cursor?.next ?? undefined
                } while (cursor)
                if (pages.length > 0) pagedMessages.set(id, pages.reverse())
              }
            }
          })().finally(() => { syncInFlight.delete(id) })
          syncInFlight.set(id, p)
          return p
        },
        list(): readonly PanelSession[] { return context.data.session.list().map((s) => ({ id: s.id, title: s.title, agent: s.agent, parentID: s.parentID })) },
        messages(id: string): readonly any[] {
          // 归一化为 V1 消息形状（role/providerID/tokens/cost），组件体零改动；
          // 同时建立 messageID → 消息索引供 part() 使用。
          // 回合边界用 V2 官方规则（rows.ts reduceSessionRows）：assistant 消息
          // 的 finish 非 tool-calls/unknown 或 error 即回合终点；同回合消息注入
          // 相同合成 parentID（V2 消息无 parentID），使 V1 组件按 parentID 链
          // 聚合"本回合调用次数/末次成本"的逻辑成立。
          const raw = listRawMessages(id)
          let turnId: string | undefined
          const normalized = raw.map((m) => {
            const record = m as Record<string, any>
            messageIndex.set(String(m.id), record)
            let parentID: string | undefined
            if (record.type === "assistant") {
              if (!turnId) turnId = String(m.id)
              parentID = turnId
              const finish = record.finish
              const terminal = (typeof finish === "string" && !["tool-calls", "unknown"].includes(finish)) || Boolean(record.error)
              if (terminal) turnId = undefined
            }
            const model = m.model as { providerID?: string; id?: string } | undefined
            return {
              ...m,
              parentID,
              role: m.type === "assistant" ? "assistant" : m.type === "user" ? "user" : m.type,
              providerID: model?.providerID,
              modelID: model?.id,
            }
          })
          return normalized
        },
      },
      // V2 Provider.Info 无 models——从独立模型列表组装 V1 形状（{ id, models: { [modelID]: { cost } } }）。
      // Model.Info.cost 是数组（tier 分段定价），取第一档近似（无 tier 匹配信息）。
      // 响应式 getter：每次访问实时组装（对齐官方 dialog-model 的 data.location.model.list(location.ref) 用法，
      // location 数据为 Solid store——组件 effect 中读取自动建立依赖，数据同步后重算）。
      get provider() {
        const models = (context.data.location.model?.list(context.location) ?? []) as Array<Record<string, any>>
        const byProvider = new Map<string, { id: string; models: Record<string, { cost: Record<string, any> }> }>()
        for (const m of models) {
          const pid = String(m.providerID ?? "")
          if (!pid) continue
          const costArr = Array.isArray(m.cost) ? m.cost : []
          const cost = costArr[0]
          if (!cost) continue
          const entry = byProvider.get(pid) ?? { id: pid, models: {} }
          // session.model.id 可能是 modelID 纯名 / 完整引用（provider/model）/ 短名——多 key 注册保证命中
          const modelID = String(m.modelID ?? "")
          const fullId = m.id !== undefined ? String(m.id) : ""
          const shortId = fullId.split("/").pop() ?? ""
          for (const k of new Set([modelID, fullId, shortId].filter((x) => x.length > 0))) {
            entry.models[k] = { cost }
          }
          byProvider.set(pid, entry)
        }
        return [...byProvider.values()]
      },
      config: {} as any, // V2 插件 API 无 config 读取；实验兜底
      part(messageID: string): readonly any[] {
        // V2 无 part API：从消息 content 构造 V1 Part 形状（token 分布/技能区块依赖）。
        // user/synthetic/system 消息无 content——文本在顶层 text，构造 text part。
        const msg = messageIndex.get(String(messageID))
        if (!msg) return []
        if (!Array.isArray(msg.content) || msg.content.length === 0) {
          if (typeof msg.text === "string" && msg.text.length > 0) {
            return [{ type: "text", text: msg.text }]
          }
          return []
        }
        const parts = msg.content.map((p) => toV1Part(p as Record<string, any>))
        // V2 无 step-finish part：assistant 消息的顶层 cost 合成一个（V1 每条消息一个 step-finish，
        // 组件按 parentID 链聚合统计本回合调用次数与末次成本）
        if (msg.type === "assistant" && typeof msg.cost === "number" && Number.isFinite(msg.cost)) {
          parts.push({ type: "step-finish", cost: msg.cost })
        }
        return parts
      },
      path: { directory: String((context.location as { directory?: string } | undefined)?.directory ?? "") },
    },
    event: {
      on: (type: string, handler: (event: unknown) => void) => context.data.on(type, handler),
    },
    dispose: () => { disposed = true; clearTimeout(late); unsubCreated(); unsubDeleted(); unsubUsage() },
    renderer: { terminalWidth: context.renderer.terminalWidth },
    keys: { formatBindings: () => undefined },
    tuiConfig: {
      keybinds: {
        get: (command: string) => context.keymap.shortcuts(command),
      },
    },
  }
}
