import type { Context } from "./types"
import type { PanelApi, PanelSession } from "../panel/panel-api"

/**
 * V2 (opencode2) context → PanelApi 适配实现。
 * 实验版：核心能力（session/messages/tokens/storage/event/renderer）完整映射；
 * 无 V2 对应的能力（part 分布、config）以空值兜底。
 */
export function createPanelApi(context: Context): PanelApi {
  // storage.store 持久化 → PanelApi.kv 语义
  const kvStore = new Map<string, [Record<string, any>, (fn: (d: Record<string, any>) => void) => Promise<void>]>()
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
          // 归一化为 V1 消息形状（role/providerID/tokens/cost），组件体零改动
          return (context.data.session.message.list(id) ?? []).map((m) => {
            const model = m.model as { providerID?: string; id?: string } | undefined
            return {
              ...m,
              role: m.type === "assistant" ? "assistant" : m.type === "user" ? "user" : m.type,
              providerID: model?.providerID,
              modelID: model?.id,
            }
          })
        },
      },
      provider: (context.data.location?.provider?.list() ?? []) as readonly Record<string, any>[],
      config: {} as any, // V2 插件 API 无 config 读取；实验兜底
      part: () => [], // V2 无 part API；token 分布区块暂缺
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
