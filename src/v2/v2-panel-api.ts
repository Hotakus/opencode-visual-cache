import type { Context } from "./types"
import type { PanelApi, PanelSession } from "../panel/panel-api"

/**
 * V2 (opencode2) context → PanelApi 适配实现。
 * 核心能力（session/messages/tokens/storage/event/renderer/part）完整映射；
 * 无 V2 对应的能力（config）以空值兜底。
 */
export function createPanelApi(context: Context): PanelApi {
  // storage.store 持久化 → PanelApi.kv 语义
  const kvStore = new Map<string, [Record<string, any>, (fn: (d: Record<string, any>) => void) => Promise<void>]>()

  // 消息索引：messages() 填充，part() 按 messageID 查（V2 无全局 message.get）
  const messageIndex = new Map<string, Record<string, any>>()

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
          const model = s.model as { providerID?: string; id?: string } | undefined
          return {
            id: s.id,
            title: s.title,
            agent: s.agent,
            model: model ? { providerID: model.providerID, id: model.id } : undefined,
          }
        },
        messages(id: string): readonly any[] {
          // 归一化为 V1 消息形状（role/providerID/tokens/cost），组件体零改动；
          // 同时建立 messageID → 消息索引供 part() 使用。
          // 回合边界用 V2 官方规则（rows.ts reduceSessionRows）：assistant 消息
          // 的 finish 非 tool-calls/unknown 或 error 即回合终点；同回合消息注入
          // 相同合成 parentID（V2 消息无 parentID），使 V1 组件按 parentID 链
          // 聚合"本回合调用次数/末次成本"的逻辑成立。
          const raw = context.data.session.message.list(id) ?? []
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
      provider: (() => {
        const models = (context.data.location.model?.list() ?? []) as Array<Record<string, any>>
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
      })(),
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
    renderer: { terminalWidth: context.renderer.terminalWidth },
    keys: { formatBindings: () => undefined },
    tuiConfig: {
      keybinds: {
        get: (command: string) => context.keymap.shortcuts(command),
      },
    },
  }
}
