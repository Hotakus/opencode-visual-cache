import type { Message, Part, Session } from "@opencode-ai/sdk"
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { BalanceEntry } from "../balance-providers"
import type { LangCode } from "../i18n"

/** 会话信息（面板消费的字段；SDK Session 类型过严，用宽松接口） */
export interface PanelSession {
  id: string
  title?: string
  agent?: string
  model?: { providerID?: string; id?: string }
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  cost?: number
  [key: string]: unknown
}

/**
 * Panel API 契约：TokenCachePanel 消费的宿主 API 子集。
 * V1（TuiPluginApi）天然满足；V2（opencode2 context）由 v2-panel-api 适配实现。
 */
export interface PanelApi {
  kv: {
    ready: boolean
    get<T>(key: string, fallback?: T): T | undefined
    set(key: string, value: unknown): void | Promise<void>
  }
  state: {
    session: {
      get(id: string): PanelSession | undefined
      /** V1 返回 sdk/v2 的 Message、V2 返回 SessionMessageInfo——统一放宽 */
      messages(id: string): readonly any[]
    }
    provider: readonly Record<string, any>[]
    config: any
    part(messageID: string): readonly any[]
    path: { directory: string }
  }
  event: {
    on(type: string, handler: (event: unknown) => void): () => void
  }
  renderer: { terminalWidth: number }
  keys: { formatBindings(binding: unknown): string | undefined }
  tuiConfig: { keybinds: { get(command: string): unknown } }
}

export interface BalanceState {
  status: "idle" | "loading" | "ok" | "error"
  data: BalanceEntry[] | null
  lastFetch: number
  error?: string
  key?: string // 上次成功/尝试查询所用的 key，用于检测 key 是否更换
}

/** Signals shared between the TUI component and slash commands.
 *  Created in the `tui` function scope so they do not survive module reload —
 *  the component re-creates them on mount and restores user config from kv. */
export interface PanelSignals {
  currencySymbol: () => string
  setCurrencySymbol: (v: string) => void
  exchangeRate: () => number
  setExchangeRate: (v: number) => void
  langCode: () => LangCode
  setLangCode: (v: LangCode) => void
  sectionDetail: () => boolean
  setSectionDetail: (v: boolean) => void
  sectionModel: () => boolean
  setSectionModel: (v: boolean) => void
  sectionDist: () => boolean
  setSectionDist: (v: boolean) => void
  sectionSkills: () => boolean
  setSectionSkills: (v: boolean) => void
  sectionBalance: () => boolean
  setSectionBalance: (v: boolean) => void
  /** Bottom status bar (prompt hint line) visibility. */
  sectionBottom: () => boolean
  setSectionBottom: (v: boolean) => void
  /** Increment to force a balance re-fetch. */
  balanceRefresh: () => number
  setBalanceRefresh: (v: number) => void
  /** Currently selected balance provider id (e.g. "deepseek"). */
  balanceProviderId: () => string
  setBalanceProviderId: (v: string) => void
  /** Auto-switch to the session's provider for balance display. Manual switch disables it. */
  autoBalance: () => boolean
  setAutoBalance: (v: boolean) => void
  /** True when the session's provider has no balance adapter (auto mode). Suppresses balance polling. */
  balanceUnsupported: () => boolean
  setBalanceUnsupported: (v: boolean) => void
  /** Shared balance query state — single source of truth for sidebar and bottom bar. */
  balanceState: () => BalanceState
  /** Preferred currency code for balance display (CNY / USD / …). Empty = first entry. */
  balanceCurrency: () => string
  setBalanceCurrency: (v: string) => void
  borderVisible: () => boolean
  setBorderVisible: (v: boolean) => void
  /** When set, the panel renders stats for this session instead of the main one. */
  overrideSessionId: () => string | undefined
  setOverrideSessionId: (v: string | undefined) => void
  /** True while our sidebar panel is mounted — host sidebar is visible (occupies 42 cols). */
  sidebarVisible: () => boolean
  setSidebarVisible: (v: boolean) => void
}

export type { TuiThemeCurrent }
