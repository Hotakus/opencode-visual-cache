/** @jsxImportSource @opentui/solid */

import type { JSX } from "@opentui/solid"
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiSlotContext,
  TuiSlotPlugin,
  TuiPluginModule,
  TuiThemeCurrent,
  TuiDialogStack,
  TuiPromptRef,
} from "@opencode-ai/plugin/tui"
import type { UserMessage, AssistantMessage, Message } from "@opencode-ai/sdk"
import type {
  Part,
  TextPart,
  ToolPart,
  FilePart,
  ReasoningPart,
} from "@opencode-ai/sdk/v2"
import { createMemo, createSignal, createEffect, onMount, onCleanup, Show, untrack } from "solid-js"
import { PLUGIN_VERSION } from "./_version"
import { balanceProviders, getBalanceProvider, maskKey, matchBalanceProvider, type BalanceEntry, type BalanceProvider } from "./balance-providers"
import { LANG_META, createT, detectLang, type LangCode } from "./i18n"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Bun / Node globals — available at runtime in the OpenCode TUI process
declare const process: { env: Record<string, string | undefined> } | undefined

// ── terminal-width helpers ────────────────────────────────────────
// CJK characters occupy 2 terminal columns; padEnd/padStart count
// string length (=1 per char), which breaks alignment with mixed text.

function charColumns(c: string): number {
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

function visualWidth(s: string): number {
  let w = 0; for (const c of s) w += charColumns(c); return w
}

function visualPadEnd(s: string, cols: number): string {
  const pad = cols - visualWidth(s)
  return pad > 0 ? s + " ".repeat(pad) : s
}

/** Truncate `s` to fit within `maxCols` visual columns, appending "…" when cut. */
function truncateVisual(s: string, maxCols: number): string {
  if (visualWidth(s) <= maxCols) return s
  let result = "", w = 0
  for (const c of s) {
    const cw = charColumns(c)
    if (w + cw > maxCols - 1) { result += "\u2026"; break }
    result += c; w += cw
  }
  return result
}

// ── language ──────────────────────────────────────────────────────
// 语言初始化：环境变量 CACHE_TUI_LANG 覆盖 → 否则按系统 locale 自动检测。
// 用户通过 /cache-lang 设置的偏好会在 KV 就绪后优先覆盖（见 tui() 内恢复逻辑）。

const DEBUG_LANG = typeof process !== "undefined" ? process.env?.CACHE_TUI_LANG : undefined
const INIT_LANG: LangCode = DEBUG_LANG !== undefined && LANG_META.some((m) => m.code === DEBUG_LANG)
  ? (DEBUG_LANG as LangCode)
  : detectLang()

// ── color helpers ────────────────────────────────────────────────

/** Extract { r, g, b } (0–255) from a hex string or RGBA-like object. */
function rgb(raw: unknown): { r: number; g: number; b: number } | null {
  if (typeof raw === "string" && raw.startsWith("#")) {
    const h = raw.slice(1)
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    }
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>
    if (typeof o.r === "number" && typeof o.g === "number" && typeof o.b === "number") {
      // RGBA channels may be 0-1 floats; detect and upscale.
      const scale = o.r > 1 || o.g > 1 || o.b > 1 ? 1 : 255
      return {
        r: Math.round(o.r * scale),
        g: Math.round(o.g * scale),
        b: Math.round(o.b * scale),
      }
    }
  }
  return null
}

/** HSL saturation of an RGB color (0–1). */
function saturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b) / 255
  const min = Math.min(r, g, b) / 255
  const delta = max - min
  if (delta === 0) return 0
  const L = (max + min) / 2
  return L <= 0.5 ? delta / (max + min) : delta / (2 - max - min)
}

/**
 * If the colour's saturation exceeds `maxSat`, pull it toward grey
 * until saturation drops to maxSat.  Returns a hex string.
 */
function desaturateTo(raw: unknown, maxSat: number, fallback: string): string {
  const c = rgb(raw)
  if (!c) return fallback
  const sat = saturation(c.r, c.g, c.b)
  if (sat <= maxSat) {
    // already muted — return as hex
    return "#" + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")
  }
  /**
   * Binary search for the optimal grey-mix ratio α (0…1).
   *
   * 12 iterations → 1/2^12 ≈ 1/4096 resolution.  The downstream RGB
   * channels are only 0–255 (8 bit), so 8 iterations (1/256) would
   * technically suffice; 12 is intentionally over-budget — the extra
   * precision costs almost nothing and guarantees the saturation probe
   * converges to within a fraction of an 8‑bit step, eliminating
   * colour banding in edge cases.
   */
  // Bt.601 luma (perceptual brightness used as the grey anchor)
  const luma = c.r * 0.299 + c.g * 0.587 + c.b * 0.114
  let lo = 0, hi = 1
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2
    const nr = Math.round(c.r + (luma - c.r) * mid)
    const ng = Math.round(c.g + (luma - c.g) * mid)
    const nb = Math.round(c.b + (luma - c.b) * mid)
    if (saturation(nr, ng, nb) > maxSat) lo = mid
    else hi = mid
  }
  const nr = Math.round(c.r + (luma - c.r) * hi)
  const ng = Math.round(c.g + (luma - c.g) * hi)
  const nb = Math.round(c.b + (luma - c.b) * hi)
  return "#" + [nr, ng, nb].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")
}

/** Darken a hex colour by multiplying each channel by `factor` (0–1). */
function dimColor(hex: string, factor = 0.5): string {
  const c = rgb(hex)
  if (!c) return hex
  const r = Math.round(c.r * factor)
  const g = Math.round(c.g * factor)
  const b = Math.round(c.b * factor)
  return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")
}

// Morandi fallbacks — used when a theme colour cannot be resolved
const FALLBACK = {
  primary: "#8B9DAF",
  text:    "#C5C5BB",
  muted:   "#7A7A72",
  success: "#9CAF8B",
  warning: "#C5B88D",
  error:   "#B08A8A",
  border:  "#6B6B63",
} as const

/**
 * Desaturation ceiling for the Morandi-style palette.
 *
 * Morandi colours float around 0.15–0.30 saturation in HSL space.
 * 0.28 sits near the upper end of that range: it strips the aggressive
 * punch from high-saturation themes (Dracula, Solarized …) while
 * preserving enough colour identity that green / orange / red hit-rate
 * coding stays distinguishable.
 *
 * Lower → more grey, harder to tell colours apart.
 * Higher → bright themes bleed through and defeat the muted look.
 */
const MAX_SAT = 0.28

function progressBar(percent: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, percent))
  const filled = Math.round((clamped / 100) * width)
  const empty = Math.max(0, width - filled)
  return "\u2588".repeat(filled) + "\u2591".repeat(empty)
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 10_000) return (n / 1_000).toFixed(1) + "K"
  return n.toLocaleString("en-US")
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

function fmtCost(n: number, symbol = "$", rate = 1): string {
  const v = n * rate
  if (v >= 1) return symbol + v.toFixed(2)
  if (v >= 0.01) return symbol + v.toFixed(3)
  return symbol + v.toFixed(4)
}

// ── token estimation ──
// Character-based BPE approximation.  Default ratios (~4 ASCII or ~1.5 CJK
// chars per token) work well for natural language but systematically
// under-count tokens in JSON and source code where every punctuation mark
// tends to be its own token.  Detect these cases and tighten the ratio.
// See: GPT-4 / Claude tokenizer behaviour with structured text.

function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0
  let ascii = 0
  let cjk = 0
  for (const c of text) {
    const code = c.codePointAt(0) ?? 0
    if (code >= 0x4E00 && code <= 0x9FFF) cjk++       // CJK Unified
    else if (code >= 0x3040 && code <= 0x30FF) cjk++   // Hiragana/Katakana
    else if (code >= 0xAC00 && code <= 0xD7A3) cjk++   // Hangul
    else if (code >= 0x1100 && code <= 0x11FF) cjk++   // Hangul Jamo
    else if (code >= 0x2E80 && code <= 0x2EFF) cjk++   // CJK Radicals
    else ascii++
  }

  // Real BPE tokenizers (cl100k_base, o200k_base) average ~3.5-4.0
  // ASCII chars/token for both JSON and source code — close to prose.
  // The old 2.0 / 2.5 ratios matched minified-JS extremes, not typical
  // payloads, and systematically over-estimated token counts.
  const trimmed = text.trimStart()
  // Strip markdown code-fence prefix so that ```json … is detected as JSON
  const strippedFence = trimmed.replace(/^\x60{3}\w*\s*\n?/, "")
  const jsonLike = (strippedFence.startsWith("{") || strippedFence.startsWith("["))
    && /"[^"]+"\s*:/.test(text)
  const codeLike = !jsonLike
    && /```|^import |^export |^function |^const |^let |^var |^class |^interface |^type |^def |^fn |^pub |^use |^mod |^package /m.test(text)

  const asciiPerToken = jsonLike ? 3.5 : codeLike ? 3.5 : 4
  return Math.max(1, Math.ceil(ascii / asciiPerToken + cjk / 1.0))
}

interface TokenDist {
  system: number   // UserMessage.system
  user: number     // user message text/file parts
  agent: number    // task tool input prompt/description (sub-agent delegation)
  toolCall: number // ToolPart.input (actual tool params)
  toolResult: number // ToolPart completed output / error
  output: number   // AssistantMessage.tokens.output (API exact, reasoning excluded)
  reasoning: number // AssistantMessage.tokens.reasoning (API exact)
  apiOutput: number // StepFinishPart.tokens.output (API exact, preferred)
  apiInput: number  // API exact total input context (input + cache read + cache write)
  stepCost: number  // last step-finish part cost (USD) in the current round
  stepCount: number // step-finish parts count across the current round (parentID chain)
}

// ---------------------------------------------------------------------------
// Balance state
// ---------------------------------------------------------------------------

interface BalanceState {
  status: "idle" | "loading" | "ok" | "error"
  data: BalanceEntry[] | null
  lastFetch: number
  error?: string
  key?: string           // 上次成功/尝试查询所用的 key，用于检测 key 是否更换
}

const BALANCE_POLL_MS = 5 * 60 * 1000 // 5 minutes

/**
 * 将余额从来源币种换算为目标币种。
 * DEFAULT_RATES 以 USD=1 为基准：先折算为 USD，再换算到目标币种。
 */
function convertBalance(target: string, targetRate: number, amount: number, from: string): number {
  if (from === target) return amount
  const fromRate = DEFAULT_RATES[from] ?? 1
  const usd = from === "USD" ? amount : amount / fromRate
  return target === "USD" ? usd : usd * targetRate
}

/**
 * 从 OpenCode 已认证的 provider 读取 API key 作为余额查询的自动兜底。
 * 匹配复用前缀逻辑：先精确匹配 id，再前缀匹配（如 moonshotai-cn → moonshot）。
 * key 来源：auth.json（provider.key）或配置（provider.options.apiKey）。
 * 仅当手动配置的 key 缺失时使用；读取失败或未匹配返回空串。
 */
function findOpencodeKey(api: TuiPluginApi, provider: BalanceProvider): string {
  try {
    const provs = api.state.provider as unknown as Array<{ id: string; key?: string; options?: { apiKey?: string } }>
    // 大小写不敏感：精确匹配 id，否则前缀匹配（如 moonshotai-cn → moonshot）
    const id = provider.id.toLowerCase()
    const hit = provs.find((p) => p.id.toLowerCase() === id) ?? provs.find((p) => p.id.toLowerCase().startsWith(id))
    if (!hit) return ""
    const k = typeof hit.key === "string" ? hit.key : ""
    if (k) return k
    return typeof hit.options?.apiKey === "string" ? hit.options.apiKey : ""
  } catch {
    return ""
  }
}

/** 货币符号：优先取 /cache-currency 内置映射，未知币种回退为代码。 */
function balanceSymbol(currency: string): string {
  const sym = CURRENCIES[currency]
  return sym ?? currency + " "
}

/** 紧凑数字缩写（底部状态栏用）：1234 → "1.2K"，1234567 → "1.2M"。 */
function fmtCompact(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M"
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K"
  return String(Math.round(n))
}

/** 余额数值格式化：≥1 或 0 显示固定 2 位小数；小额（<1）保留精度（最多 6 位），避免抹成 0.00。 */
function formatBalanceAmount(total: string): string {
  const n = parseFloat(total)
  if (!Number.isFinite(n)) return total
  if (n === 0 || n >= 1) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 })
}

/**
 * 将余额列表格式化为单行文本。
 * 优先直接显示偏好币种（CNY/USD…）；偏好币种为换算币种时按汇率折算第一条余额。
 */
function formatBalanceText(list: BalanceEntry[], pref: string, rate: number): string {
  const native = pref ? list.find((x) => x.currency === pref) : undefined
  if (native) return balanceSymbol(native.currency) + formatBalanceAmount(native.total)
  const base = list[0]
  const baseAmt = parseFloat(base.total)
  const converted = Number.isFinite(baseAmt)
    ? convertBalance(pref || base.currency, rate, baseAmt, base.currency)
    : baseAmt
  const shown = pref && base.currency !== pref
    ? converted.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : formatBalanceAmount(base.total)
  return balanceSymbol(pref || base.currency) + shown
}

// ---------------------------------------------------------------------------
// Sidebar component
// ---------------------------------------------------------------------------

/** Signals shared between the TUI component and slash commands.
 *  Created in the `tui` function scope so they do not survive module reload —
 *  the component re-creates them on mount and restores user config from kv. */
interface PanelSignals {
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
}

const CURRENCIES: Record<string, string> = {
  USD: "$", CNY: "¥", EUR: "€", JPY: "JP¥", GBP: "£", KRW: "₩",
}
/** Approximate USD exchange rates — used as defaults when switching currency.
 *  Users can override via /cache-rate.  Last updated 2026-05. */
const DEFAULT_RATES: Record<string, number> = {
  USD: 1, CNY: 7.2, EUR: 0.92, JPY: 150, GBP: 0.79, KRW: 1350,
}

const MIN_PANEL_WIDTH = 20
const DEFAULT_PANEL_WIDTH = 26

/** ── layout measurement constants (visual columns) ── */
const LABEL_GAP = 1        // label（如 "Hit"）后面的空格
const BAR_BRACKETS = 2     // "[" + "]" 包围进度条
const BAR_GAP = 1          // "]" 后面的空格
const PCT_FIXED_WIDTH = 5  // "XX.X%" 固定 5 字符宽度
const HEADER_PREFIX = 2    // 折叠态标题行：▶/▼ 图标 + 后面的空格
const UNIT_GAP = 1         // 计量单位前的空格（如 "tok"）


function TokenCachePanel(props: {
  theme: TuiThemeCurrent
  api: TuiPluginApi
  sessionId: string
  signals: PanelSignals
}): JSX.Element {
  const [panelWidth, setPanelWidth] = createSignal(DEFAULT_PANEL_WIDTH)
  const [open, setOpen] = createSignal(true)
  const [detailOpen, setDetailOpen] = createSignal(true)
  const [modelOpen, setModelOpen] = createSignal(true)
  const [distOpen, setDistOpen] = createSignal(false)
  const [skillsOpen, setSkillsOpen] = createSignal(true)
  let boxEl: any

  // ── shared signals (de-structured so internal code is unchanged) ──
  const {
    currencySymbol, setCurrencySymbol,
    exchangeRate, setExchangeRate,
    langCode,
    sectionDetail, setSectionDetail,
    sectionModel, setSectionModel,
    sectionDist, setSectionDist,
    sectionSkills, setSectionSkills,
    sectionBalance, setSectionBalance,
    balanceRefresh,
    balanceProviderId, setBalanceProviderId,
    autoBalance, setAutoBalance,
    balanceUnsupported, setBalanceUnsupported,
    balanceState,
    balanceCurrency, setBalanceCurrency,
    borderVisible, setBorderVisible,
  } = props.signals

  // ── reactive translation (follows langCode signal) ──
  const t = createT(() => langCode())

  // ── scan session messages reactively ──
  // SolidJS createMemo re-evaluates whenever the underlying
  // api.state.session state changes — no event listener needed.

  // ── distribution cache ────────────────────────────────────────
  // When data() re-computes before api.state.part() is warm (e.g. after
  // a view switch), hasDistData flips to false and the distribution
  // block disappears.  Keep the last valid snapshot so the UI stays
  // stable until the next successful computation arrives.
  const [lastDist, setLastDist] = createSignal<TokenDist>({
    system: 0, user: 0, agent: 0, toolCall: 0, toolResult: 0,
    output: 0, reasoning: 0, apiOutput: 0, apiInput: 0, stepCost: 0, stepCount: 0,
  })
  const [lastHasDist, setLastHasDist] = createSignal(false)

  const [dataSignal, setDataSignal] = createSignal<any>({
    hitRate: 0, read: 0, write: 0, freshInput: 0, output: 0,
    cost: 0, saved: 0, model: "", inputRate: 0, cacheReadRate: 0, cacheWriteRate: 0,
    hasPricing: false, hasData: false, trend: 0, hasTrendData: false,
    providerName: "", sessionHitRate: 0,
    dist: { system: 0, user: 0, agent: 0, toolCall: 0, toolResult: 0, output: 0, reasoning: 0, apiOutput: 0, apiInput: 0, stepCost: 0, stepCount: 0 },
    hasDistData: false,
    skills: [] as { name: string; tokens: number }[],
    hasSkills: false,
  })
  const [refreshTick, setRefreshTick] = createSignal(0)

  // 当前 provider 显示名（余额查询状态为共享信号，见 PanelSignals.balanceState）
  const providerName = createMemo(() => getBalanceProvider(balanceProviderId()).name)

  // 自动切换当前会话的 provider（前缀匹配）。手动切换会关闭此行为。
  // 直接追踪 messages 取最后一条 assistant 消息的 providerID——
  // 不依赖 session.model 的响应式更新（模型切换时该链路可能不触发重算）。
  createEffect(() => {
    if (!autoBalance()) return
    const sid = props.signals.overrideSessionId() ?? props.sessionId
    const msgs = props.api.state.session.messages(sid) as Message[]
    let pid = ""
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role === "assistant" && (m as AssistantMessage).providerID) {
        pid = (m as AssistantMessage).providerID
        break
      }
    }
    // 会话尚无 assistant 消息（新会话 / 刚切换模型未对话 / 消息未加载）
    // → 回退到会话级模型元数据，反映当前正在使用的 provider
    if (!pid) {
      try {
        const session = props.api.state.session.get(sid)
        pid = session?.model?.providerID ?? ""
      } catch { /* ignore */ }
    }
    if (!pid) return
    const hit = matchBalanceProvider(pid)
    if (hit) {
      setBalanceUnsupported(false)
      if (hit.id !== balanceProviderId()) {
        setBalanceProviderId(hit.id)
        props.signals.setBalanceRefresh(props.signals.balanceRefresh() + 1)
      }
    } else {
      // 当前提供商没有余额适配器 → 标记不支持，余额显示 N/A 并停止轮询
      setBalanceUnsupported(true)
    }
  })

  // ── auto-clear override when the user navigates to a different main session ──
  let lastMainSid = props.sessionId
  createEffect(() => {
    const sid = props.sessionId
    if (sid !== lastMainSid) {
      lastMainSid = sid
      if (props.signals.overrideSessionId()) {
        props.signals.setOverrideSessionId(undefined)
        props.api.kv.set(`${KV_PREFIX}.session`, "")
      }
    }
  })

  createEffect(() => {
    const sid = props.signals.overrideSessionId() ?? props.sessionId
    void refreshTick()
    void partVersion()

    // 自然追踪 messages 和 provider（SDK 数据就绪时自动重新执行）
    const msgs = props.api.state.session.messages(sid) as Message[]
    const session = typeof props.api.state.session.get === "function"
      ? props.api.state.session.get(sid)
      : undefined

    // 累计值优先使用 Session 聚合字段（数据库级，不受 sync 层 limit:100 截断）
    // 若字段不存在（旧版本 SDK），降级到消息遍历累加
    let input  = session?.tokens?.input ?? 0
    let read   = session?.tokens?.cache?.read ?? 0
    let write  = session?.tokens?.cache?.write ?? 0
    let output = session?.tokens?.output ?? 0
    let cost   = session?.cost ?? 0
    let pid    = session?.model?.providerID ?? ""
    let mid    = session?.model?.id ?? ""

    const fallbackTokens = session?.tokens == null
    const fallbackCost   = session?.cost == null
    const fallbackModel  = !pid || !mid

    let prevMsgHitRate = -1, lastMsgHitRate = -1
    for (const msg of msgs) {
      if (msg.role !== "assistant") continue
      const tok = (msg as AssistantMessage).tokens; if (!tok) continue
      const mit = num(tok.input) + num(tok.cache?.read) + num(tok.cache?.write), mrt = num(tok.cache?.read)
      if (mit > 0) { prevMsgHitRate = lastMsgHitRate; lastMsgHitRate = (mrt / mit) * 100 }
      if (fallbackTokens) {
        input += num(tok.input); read += num(tok.cache?.read); write += num(tok.cache?.write); output += num(tok.output)
      }
      if (fallbackCost) {
        cost += num((msg as AssistantMessage).cost)
      }
      if (fallbackModel && (msg as AssistantMessage).providerID && (msg as AssistantMessage).modelID) {
        pid = (msg as AssistantMessage).providerID; mid = (msg as AssistantMessage).modelID
      }
    }
    let saved = 0, inputRate = 0, cacheReadRate = 0, cacheWriteRate = 0
    if (read > 0 && pid && mid && Array.isArray(props.api.state.provider)) for (const provider of props.api.state.provider) {
      if (provider.id !== pid) continue
      const model = provider.models[mid]; if (!model?.cost) continue
      inputRate = num(model.cost.input); cacheReadRate = num(model.cost.cache?.read); cacheWriteRate = num(model.cost.cache?.write)
      if (inputRate > cacheReadRate) saved = (read * (inputRate - cacheReadRate)) / 1_000_000
      break
    }
    const hitRate = lastMsgHitRate >= 0 ? lastMsgHitRate : 0
    // 总命中率分母含缓存写（业界口径：read / (input+read+write)）
    const freshTotal = input + read + write, sessionHitRate = freshTotal > 0 ? (read / freshTotal) * 100 : 0
    const model = mid.split("/").pop() ?? mid, hasPricing = inputRate > 0 || cacheReadRate > 0 || cacheWriteRate > 0
    const hasTrendData = prevMsgHitRate >= 0 && lastMsgHitRate >= 0
    const trend = hasTrendData ? lastMsgHitRate - prevMsgHitRate : 0, providerName = pid || ""

    // untrack 只包裹已知触发死锁的 API
    const distData = untrack(() => {
      let dist: TokenDist = { system: 0, user: 0, agent: 0, toolCall: 0, toolResult: 0, output: 0, reasoning: 0, apiOutput: 0, apiInput: 0, stepCost: 0, stepCount: 0 }
      let hasDistData = false
      const loadedSkills = new Map<string, { name: string; tokens: number }>()
      try {
        const cfg = props.api.state.config as Record<string, unknown>
        const agentName = String(session?.agent ?? (cfg as any)?.default_agent ?? "build")
        const agents = cfg?.agent as Record<string, unknown> | undefined
        const agentCfg = agents?.[agentName] as Record<string, unknown> | undefined
        const sysPrompt = typeof agentCfg?.prompt === "string" ? agentCfg.prompt : ""
        if (sysPrompt) dist.system = estimateTokens(sysPrompt)
        let lastAssMsg: AssistantMessage | undefined
        for (const msg of msgs) {
          if (msg.role === "user") {
            const um = msg as UserMessage; if (um.system) dist.system += estimateTokens(um.system)
            let parts: readonly Part[] = []; try { parts = props.api.state.part(msg.id) } catch {}
            for (const p of parts) {
              if (p.type === "text" && !(p as any).synthetic && !(p as any).ignored) dist.user += estimateTokens((p as any).text)
              else if (p.type === "file") { const fp = p as any; if (fp.source?.text?.value) dist.user += estimateTokens(fp.source.text.value) }
            }
          } else if (msg.role === "assistant") {
            const am = msg as AssistantMessage
            dist.output += num(am.tokens?.output)
            dist.reasoning += num(am.tokens?.reasoning)
            let parts: readonly Part[] = []; try { parts = props.api.state.part(msg.id) } catch {}
            for (const p of parts) {
              if (p.type === "tool") {
                const tp = p as any; let rawInput = ""
                try { rawInput = tp.state.raw ?? (tp.state.input != null ? JSON.stringify(tp.state.input) : "") } catch {}
                if (rawInput) dist.toolCall += estimateTokens(rawInput)
                // 子代理委托（task 工具）：任务描述计入子代理指令（1.15.x 无 subtask part）
                if (tp.tool === "task" && tp.state?.input) {
                  const ti = tp.state.input
                  const prompt = typeof ti.prompt === "string" ? ti.prompt : ""
                  const desc = typeof ti.description === "string" ? ti.description : ""
                  dist.agent += estimateTokens(prompt || desc)
                }
                if (tp.state.status === "completed") { const c = tp.state; if (c.output) dist.toolResult += estimateTokens(c.output) }
                else if (tp.state.status === "error") { const e = tp.state; if (e.error) dist.toolResult += estimateTokens(e.error) }
                if (tp.tool === "skill" && tp.state.status === "completed") {
                  // TUI SDK strips tool metadata — extract skill name from well-known output format.
                  // Cross-validated against api.client.app.skills() when available.
                  let name: string | undefined = tp.state.metadata?.name
                  if (typeof name !== "string") {
                    const m = typeof tp.state.output === "string"
                      ? tp.state.output.match(/^#{1,2}\s*Skill:\s*(.+)/m)
                      : null
                    if (m) name = m[1].trim()
                  }
                  if (typeof name === "string") {
                    const tokens = typeof tp.state.output === "string" ? estimateTokens(tp.state.output) : 0
                    const existing = loadedSkills.get(name)
                    if (!existing || existing.tokens < tokens) {
                      loadedSkills.set(name, { name, tokens })
                    }
                  }
                }
              } else if (p.type === "subtask") { const sub = p as any; dist.agent += estimateTokens(sub.prompt || sub.description || "") }
            }
          }
        }
        // 从后往前找最后一条有 token 数据的 assistant 消息（避免取到 streaming 中未填充的消息）
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role !== "assistant") continue
          const tok = (msgs[i] as AssistantMessage).tokens
          if (tok && ((tok.input ?? 0) > 0 || (tok.cache?.read ?? 0) > 0 || (tok.cache?.write ?? 0) > 0)) { lastAssMsg = msgs[i] as AssistantMessage; break }
        }
        // 取最后一条有数据消息的总输入（含缓存读/写）作为当前 context 大小
        dist.apiInput = num(lastAssMsg?.tokens?.input) + num(lastAssMsg?.tokens?.cache?.read) + num(lastAssMsg?.tokens?.cache?.write)
        dist.apiOutput = num(lastAssMsg?.tokens?.output)
        // 本回合（最后一条有数据消息所在的 parentID 链）的 API 调用次数与末次成本。
        // opencode 将回合内每次工具调用循环拆为独立 assistant 消息（各含 1 个 step-finish），
        // 故按 parentID 链聚合统计，而非单条消息。
        if (lastAssMsg) {
          const roundParent = (lastAssMsg as AssistantMessage).parentID
          let lastCost: number | undefined
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i]
            if (m.role !== "assistant") continue
            if ((m as AssistantMessage).parentID !== roundParent) break
            let parts: readonly Part[] = []; try { parts = props.api.state.part(m.id) } catch {}
            for (const p of parts) {
              if (p.type !== "step-finish") continue
              dist.stepCount++
              const sc = (p as { cost?: unknown }).cost
              if (lastCost === undefined && typeof sc === "number" && Number.isFinite(sc)) lastCost = sc
            }
          }
          if (lastCost !== undefined) dist.stepCost = lastCost
        }
        hasDistData = dist.system + dist.user + dist.agent + dist.toolCall + dist.toolResult > 0 || dist.apiOutput > 0 || dist.apiInput > 0 || dist.reasoning > 0
      } catch {}
      const finalDist = hasDistData ? dist : lastDist(), finalHasDist = hasDistData || lastHasDist()
      const skills = [...loadedSkills.values()]
      return { finalDist, finalHasDist, skills }
    })

    setDataSignal({
      hitRate, read, write, freshInput: input, output, cost, saved, model,
      inputRate, cacheReadRate, cacheWriteRate, hasPricing,
      hasData: read > 0 || write > 0 || input > 0 || output > 0 || cost > 0,
      trend, hasTrendData, providerName, sessionHitRate,
      dist: distData.finalDist, hasDistData: distData.finalHasDist,
      skills: distData.skills, hasSkills: distData.skills.length > 0,
    })
  })

  const data = createMemo(() => {
    return dataSignal()
  })

  // Persist the last valid distribution so that data() can fall back
  // to it while api.state.part() is re-hydrating after a view switch.
  createEffect(() => {
    const d = data()
    if (d.hasDistData) {
      setLastDist({ ...d.dist })
      setLastHasDist(true)
      // Also persist across component remounts (view switches)
      try { props.api.kv.set(`${KV_PREFIX}.dist_snapshot`, { ...d.dist }) } catch {}
    }
  })

  // ── token distribution (in-process via api.state.part) ──
  const [partVersion, setPartVersion] = createSignal(0)

  // Persist fold state to api.kv
  const KV_PREFIX = "cache_panel"
  const persistFold = (key: string, val: boolean) => {
    try { props.api.kv.set(`${KV_PREFIX}.${key}`, val) } catch {}
  }

  onMount(() => {
    // Reset panelWidth on (re)mount so the layout uses a clean
    // default until onSizeChange measures the live box dimensions.
    setPanelWidth(DEFAULT_PANEL_WIDTH)

    // Restore fold state from persisted storage (non-critical — fire and forget)
    try {
      setOpen(Boolean(props.api.kv.get(`${KV_PREFIX}.open`, false)))
      setDetailOpen(Boolean(props.api.kv.get(`${KV_PREFIX}.detail`, true)))
      setModelOpen(Boolean(props.api.kv.get(`${KV_PREFIX}.model`, true)))
      setDistOpen(Boolean(props.api.kv.get(`${KV_PREFIX}.dist`, false)))
      setSkillsOpen(Boolean(props.api.kv.get(`${KV_PREFIX}.skills`, true)))
    } catch {}

    // Restore user config (currency, rate, section visibility).
    // Try synchronously first (kv is usually ready on mount), fall back to
    // polling if the module was reloaded and kv hasn't initialised yet.
    const doRestore = () => {
      try {
        const sym = props.api.kv.get<string>(`${KV_PREFIX}.currency`)
        const rate = props.api.kv.get<number>(`${KV_PREFIX}.rate`)
        if (typeof sym === "string") setCurrencySymbol(sym)
        if (typeof rate === "number" && rate > 0) setExchangeRate(rate)
        const balCur = props.api.kv.get<string>(`${KV_PREFIX}.balance_currency`)
        if (typeof balCur === "string") setBalanceCurrency(balCur)
        // Restore balance provider (fall back to default when unknown)
        const savedProvider = props.api.kv.get<string>(`${KV_PREFIX}.balance.provider`)
        if (typeof savedProvider === "string" && balanceProviders.some((p) => p.id === savedProvider)) {
          setBalanceProviderId(savedProvider)
          setBalanceUnsupported(false)
        }
        // Restore auto-switch (default on)
        const savedAuto = props.api.kv.get<boolean>(`${KV_PREFIX}.balance.auto`)
        if (typeof savedAuto === "boolean") setAutoBalance(savedAuto)
        // Migrate legacy DeepSeek key (cache_panel.ds_key → cache_panel.balance.deepseek.key)
        const legacyKey = props.api.kv.get<string>(`${KV_PREFIX}.ds_key`, "")
        if (legacyKey) {
          const dsKey = props.api.kv.get<string>(`${KV_PREFIX}.balance.deepseek.key`, "")
          if (!dsKey) props.api.kv.set(`${KV_PREFIX}.balance.deepseek.key`, legacyKey)
          props.api.kv.set(`${KV_PREFIX}.ds_key`, "")
        }
        // 恢复的 provider 可能与默认值不同，强制重新查询
        props.signals.setBalanceRefresh(props.signals.balanceRefresh() + 1)
        setSectionDetail(Boolean(props.api.kv.get(`${KV_PREFIX}.section.detail`, true)))
        setSectionModel(Boolean(props.api.kv.get(`${KV_PREFIX}.section.model`, true)))
        setSectionDist(Boolean(props.api.kv.get(`${KV_PREFIX}.section.dist`, true)))
        setSectionSkills(Boolean(props.api.kv.get(`${KV_PREFIX}.section.skills`, true)))
        setSectionBalance(Boolean(props.api.kv.get(`${KV_PREFIX}.section.balance`, true)))
        const bv = props.api.kv.get<boolean>(`${KV_PREFIX}.border`, true)
        setBorderVisible(bv !== false)
        // Restore distribution snapshot so the token distribution block
        // doesn't blank out while api.state.part() re-hydrates.
        const cachedDist = props.api.kv.get<TokenDist>(`${KV_PREFIX}.dist_snapshot`)
        if (cachedDist) {
          setLastDist(cachedDist)
          setLastHasDist(true)
        }
      } catch {
        // kv read failed — signals stay at defaults
      }
      // Re-measure panel width after config signals have settled
      if (boxEl && typeof boxEl.width === "number" && boxEl.width > 0) {
        setPanelWidth(Math.max(MIN_PANEL_WIDTH, boxEl.width))
      }
    }

    if (props.api.kv.ready) {
      doRestore()
    } else {
      // Poll kv.ready with a 1-second timeout to avoid infinite busy-wait
      // on platforms where kv initialisation may be delayed (Linux single-thread
      // mode, session switch storms, etc.).
      const MAX_POLL = 100
      let tries = 0
      const pollRestore = () => {
        if (!props.api.kv.ready) {
          if (++tries > MAX_POLL) { doRestore(); return }
          setTimeout(pollRestore, 10)
          return
        }
        doRestore()
      }
      pollRestore()
    }

    // Debounce partVersion updates so that event bursts during session
    // switching / streaming don't cause data() to re-compute on every
    // single event (up to hundreds per second on Linux single-thread).
    let partTimer: ReturnType<typeof setTimeout> | undefined
    const bumpPartVersion = () => {
      clearTimeout(partTimer)
      partTimer = setTimeout(() => setPartVersion((v) => v + 1), 100)
    }
    const unsubPart = props.api.event.on("message.part.updated", () => { bumpPartVersion(); setRefreshTick(v => v + 1) })
    const unsubMsg = props.api.event.on("message.updated", () => { bumpPartVersion(); setRefreshTick(v => v + 1) })
    const unsubSession = props.api.event.on("session.updated", () => { setRefreshTick(v => v + 1) })
    setRefreshTick(v => v + 1)
    onCleanup(() => { clearTimeout(partTimer); unsubPart(); unsubMsg(); unsubSession() })
  })

  // ── colours ──
  // Pull from the current theme, auto-desaturate if too punchy,
  // fall back to Morandi when a key is missing from the theme.
  const pal = createMemo(() => {
    const t = props.theme as Record<string, unknown>
    const sat = (k: string, fb: string) => desaturateTo(t[k], MAX_SAT, fb)
    return {
      primary:   sat("primary",   FALLBACK.primary),
      text:      sat("text",      FALLBACK.text),
      muted:     sat("textMuted", FALLBACK.muted),
      success:   sat("success",   FALLBACK.success),
      warning:   sat("warning",   FALLBACK.warning),
      error:     sat("error",     FALLBACK.error),
      border:    sat("border",    FALLBACK.border),
    }
  })

  const hitColor = createMemo(() => {
    const r = data().hitRate
    if (r >= 85) return pal().success
    if (r >= 70) return pal().warning
    return pal().error
  })

  /** Horizontal space eaten by border (1+1 when visible) + padding (2+2 when visible). */
  const gutter = createMemo(() => borderVisible() ? 6 : 0)

  const sep = createMemo(() => "\u2500".repeat(Math.max(1, panelWidth() - gutter())))
  function trendLabel(t: number): string {
    // |t| < 0.05 视为无变化：避免显示 "↑0.0%" 的矛盾（箭头存在但数值截断为零）
    if (Math.abs(t) < 0.05) return "-"
    return (t > 0 ? "\u2191" : "\u2193") + Math.abs(t).toFixed(1) + "%"
  }

  const barW = createMemo(() => {
    const trendSpace = data().hasTrendData ? LABEL_GAP + visualWidth(trendLabel(data().trend)) : 0
    const overhead = visualWidth(t("hit")) + LABEL_GAP + BAR_BRACKETS + BAR_GAP + PCT_FIXED_WIDTH + trendSpace + gutter()
    return Math.max(3, panelWidth() - overhead)
  })
  const bar = createMemo(() => progressBar(data().hitRate, barW()))
  const pct = createMemo(() => (Math.floor(data().hitRate * 10) / 10).toFixed(1) + "%")

  // When border visibility changes the box dimensions shift, which
  // may not reliably trigger onSizeChange across (re)mount cycles.
  // Force panelWidth to resync with the live box after every change.
  createEffect(() => {
    borderVisible()
    if (boxEl && typeof boxEl.width === "number" && boxEl.width > 0) {
      const w = Math.max(MIN_PANEL_WIDTH, boxEl.width)
      setPanelWidth((prev) => (prev === w ? prev : w))
    }
  })

  // left-align label, right-align value — auto-fill space between
  const justify = (label: string, value: string, unit = ""): string => {
    const gauge = panelWidth() - gutter()
    const used = visualWidth(label) + visualWidth(value) + (unit ? visualWidth(unit) + UNIT_GAP : 0)
    const gap = Math.max(1, gauge - used)
    return label + " ".repeat(gap) + value + (unit ? " " + unit : "")
  }

  return (
    <box
      border={borderVisible()}
      {...(borderVisible() ? { borderColor: pal().border } : {})}
      paddingTop={0}
      paddingBottom={0}
      paddingLeft={borderVisible() ? 2 : 0}
      paddingRight={borderVisible() ? 2 : 0}
      flexDirection="column"
      gap={0}
      ref={boxEl}
      onSizeChange={() => {
        // boxEl.width may be undefined before the first measurement — guard with 0
        const w = boxEl ? Math.max(MIN_PANEL_WIDTH, boxEl.width ?? 0) : DEFAULT_PANEL_WIDTH
        setPanelWidth((prev) => (prev === w ? prev : w))
      }}
    >
      {/* collapsible header */}
      <text onMouseUp={() => setOpen((o) => { const n = !o; persistFold("open", n); return n })}>
        <span style={{ fg: pal().muted }}>{open() ? "\u25bc " : "\u25b6 "}</span>
        <span style={{ fg: pal().primary }}>
            <b>{t("title")}</b>
            <Show when={open()}>
              <span style={{ fg: dimColor(pal().muted, 0.75) }}> v{PLUGIN_VERSION}</span>
            </Show>
          </span>
        <Show when={!open() && data().hasData}>
          <Show when={data().hasTrendData}>
            <span>
              {" ".repeat(Math.max(1, panelWidth() - gutter() - HEADER_PREFIX - visualWidth(t("title")) - visualWidth(pct() + " " + t("hitFolded") + " " + trendLabel(data().trend))))}
            </span>
            <span style={{ fg: hitColor() }}>{pct()} {t("hitFolded")}</span>
            <span style={{ fg: Math.abs(data().trend) >= 0.05 ? (data().trend > 0 ? pal().success : pal().error) : pal().text }}>
              {" "}{trendLabel(data().trend)}
            </span>
          </Show>
          <Show when={!data().hasTrendData}>
            <span>
              {" ".repeat(Math.max(1, panelWidth() - gutter() - HEADER_PREFIX - visualWidth(t("title")) - visualWidth(pct() + " " + t("hitFolded"))))}
            </span>
            <span style={{ fg: hitColor() }}>{pct()} {t("hitFolded")}</span>
          </Show>
        </Show>
      </text>

      <Show when={open()}>
        <Show when={props.signals.overrideSessionId()}>
          {(() => {
            const prefix = "  \u21b3 " + t("subPrefix")
            const maxSidW = Math.max(6, panelWidth() - visualWidth(prefix))
            return (
              <text>
                <span style={{ fg: pal().muted }}>{prefix}</span>
                <span style={{ fg: pal().text }}>{truncateVisual(props.signals.overrideSessionId()!, maxSidW)}</span>
              </text>
            )
          })()}
        </Show>
        <Show when={data().hasData} fallback={
          <>
            <text fg={pal().muted}>{sep()}</text>
            <text>
              <span style={{ fg: pal().muted }}>{"> "}</span>
              <span style={{ fg: pal().muted }}>{t("noData")}</span>
            </text>
          </>
        }>
          <text fg={pal().muted}>{sep()}</text>

          {/* hit rate + bar — inline to avoid box spacing */}
          <text>
            <span style={{ fg: pal().text }}>{t("hit")} </span>
            <span style={{ fg: hitColor() }}>[{bar()}] </span>
            <span style={{ fg: pal().text }}>{pct()}</span>
            <Show when={data().hasTrendData}>
              <span style={{ fg: Math.abs(data().trend) >= 0.05 ? (data().trend > 0 ? pal().success : pal().error) : pal().text }}>
                {" "}{trendLabel(data().trend)}
              </span>
            </Show>
          </text>

          {/* session cumulative hit rate */}
          <text fg={pal().muted}>
            {justify(t("totalHit"), (Math.floor(data().sessionHitRate * 10) / 10).toFixed(1) + "%")}
          </text>

          {/* ── detail section (collapsible, default open) ── */}
          <Show when={sectionDetail()}>
          <text onMouseUp={() => setDetailOpen((o) => { const n = !o; persistFold("detail", n); return n })}>
            <span style={{ fg: pal().muted }}>{detailOpen() ? "\u25bc " : "\u25b6 "}</span>
            <span style={{ fg: pal().primary }}><b>{t("secDetail")}</b></span>
            <span style={{ fg: pal().muted }}>{sep().slice(visualWidth((detailOpen() ? "\u25bc " : "\u25b6 ") + t("secDetail")))}</span>
          </text>

          <Show when={detailOpen()}>
            <Show when={data().read > 0}>
              <text fg={pal().muted}>
                {justify(t("read"),  fmt(data().read),         t("tok"))}
              </text>
            </Show>
            <Show when={data().write > 0}>
              <text fg={pal().muted}>
                {justify(t("write"), fmt(data().write),        t("tok"))}
              </text>
            </Show>
            {/* 未命中 = 新鲜输入 + 缓存写（两者都未从缓存命中） */}
            <text fg={pal().muted}>
              {justify(t("miss"),  fmt(data().freshInput + data().write), t("tok"))}
            </text>
            <text fg={pal().muted}>
              {justify(t("out"),   fmt(data().output),       t("tok"))}
            </text>
            {/* 本回合多次 API 调用时才显示调用次数与末次成本（单次调用不占行） */}
            <Show when={data().dist.stepCount >= 2}>
              <text fg={pal().muted}>
                {justify(t("stepsCount", { n: data().dist.stepCount }), fmtCost(data().dist.stepCost, currencySymbol(), exchangeRate()))}
              </text>
            </Show>
            <Show when={data().saved > 0}>
              <text>
                <span style={{ fg: pal().muted }}>{t("saved")}</span>
                <span>{" ".repeat(Math.max(1, panelWidth() - gutter() - visualWidth(t("saved")) - visualWidth("~" + fmtCost(data().saved, currencySymbol(), exchangeRate()))))}</span>
                <span style={{ fg: pal().success }}>~{fmtCost(data().saved, currencySymbol(), exchangeRate())}</span>
              </text>
            </Show>
          </Show>
          </Show>

          {/* ── model section (collapsible, default open) ── */}
          <Show when={sectionModel()}>
          {<text onMouseUp={() => setModelOpen((o) => { const n = !o; persistFold("model", n); return n })}>
            <span style={{ fg: pal().muted }}>{modelOpen() ? "\u25bc " : "\u25b6 "}</span>
            <span style={{ fg: pal().primary }}><b>{t("secModel")}</b></span>
            <span style={{ fg: pal().muted }}>{sep().slice(visualWidth((modelOpen() ? "\u25bc " : "\u25b6 ") + t("secModel")))}</span>
          </text>}

          <Show when={modelOpen()}>
            <text fg={pal().text}>
              {justify(t("cost"),  fmtCost(data().cost, currencySymbol(), exchangeRate()))}
            </text>
            <Show when={data().providerName}>
              <text fg={pal().muted}>
                {justify(t("provider"), data().providerName)}
              </text>
            </Show>
            <text fg={pal().muted}>
              {justify(t("model"), data().model)}
            </text>
            <Show when={data().hasPricing}>
              <text fg={pal().muted}>
                {justify(t("rate"), currencySymbol() + (data().inputRate * exchangeRate()).toFixed(2) + "/M " + t("inputRate"))}
              </text>
              <Show when={data().cacheReadRate > 0}>
                <text fg={pal().muted}>
                  {justify("", currencySymbol() + (data().cacheReadRate * exchangeRate()).toFixed(2) + "/M " + t("cacheRate"))}
                </text>
              </Show>
              <Show when={data().cacheWriteRate > 0}>
                <text fg={pal().muted}>
                  {justify("", currencySymbol() + (data().cacheWriteRate * exchangeRate()).toFixed(2) + "/M " + t("writeRate"))}
                </text>
            </Show>
          </Show>
          </Show>
        </Show>

          {/* ── token distribution (collapsible, default closed) ── */}
          <Show when={sectionDist()}>
          <Show when={data().hasDistData}>
            {<text onMouseUp={() => setDistOpen((o) => { const n = !o; persistFold("dist", n); return n })}>
              <span style={{ fg: pal().muted }}>{distOpen() ? "\u25bc " : "\u25b6 "}</span>
              <span style={{ fg: pal().primary }}><b>{t("distTitle")}</b></span>
              <span style={{ fg: pal().muted }}>{sep().slice(visualWidth((distOpen() ? "\u25bc " : "\u25b6 ") + t("distTitle")))}</span>
            </text>}
            <Show when={distOpen()}>
            <Show when={data().dist.system > 0}>
              <text fg={pal().muted}>
                {justify(t("distSys"), fmt(data().dist.system), t("tok"))}
              </text>
            </Show>
            <Show when={data().dist.user > 0}>
              <text fg={pal().muted}>
                {justify(t("distUser"), fmt(data().dist.user), t("tok"))}
              </text>
            </Show>
            <Show when={data().dist.agent > 0}>
              <text fg={pal().muted}>
                {justify(t("distAgent"), fmt(data().dist.agent), t("tok"))}
              </text>
            </Show>
            <Show when={data().dist.toolCall > 0}>
              <text fg={pal().muted}>
                {justify(t("distTool"), fmt(data().dist.toolCall), t("tok"))}
              </text>
            </Show>
            <Show when={data().dist.toolResult > 0}>
              <text fg={pal().muted}>
                {justify(t("distRes"), fmt(data().dist.toolResult), t("tok"))}
              </text>
            </Show>
            <Show when={data().dist.reasoning > 0}>
              <text fg={pal().muted}>
                {justify(t("distReason"), fmt(data().dist.reasoning), t("tok"))}
              </text>
            </Show>
            </Show>
          </Show>
          </Show>

          {/* ── loaded skills (collapsible, default open) ── */}
          <Show when={sectionSkills()}>
          <Show when={data().hasSkills}>
            {<text onMouseUp={() => setSkillsOpen((o) => { const n = !o; persistFold("skills", n); return n })}>
              <span style={{ fg: pal().muted }}>{skillsOpen() ? "\u25bc " : "\u25b6 "}</span>
              <span style={{ fg: pal().primary }}><b>{t("secSkills")}</b></span>
              <span style={{ fg: pal().muted }}> ({data().skills.length})</span>
              <span style={{ fg: pal().muted }}>{sep().slice(visualWidth((skillsOpen() ? "\u25bc " : "\u25b6 ") + t("secSkills") + ` (${data().skills.length})`))}</span>
            </text>}
            <Show when={skillsOpen()}>
                {data().skills.map((sk: { name: string; tokens: number }) => {
                  const rightW = visualWidth(fmt(sk.tokens)) + UNIT_GAP + visualWidth(t("tok"))
                  const maxLabel = Math.max(4, panelWidth() - gutter() - rightW - 1)
                  const label = truncateVisual(sk.name, maxLabel)
                  return (
                    <text fg={pal().muted}>
                      {justify(label, fmt(sk.tokens), t("tok"))}
                    </text>
                  )
                })}
            </Show>
          </Show>
          </Show>

          {/* ── provider balance (single line) ── */}
          <Show when={sectionBalance()}>
            <text fg={pal().muted}>{sep()}</text>
            <Show when={balanceUnsupported()}>
              <text fg={pal().muted}>
                <span style={{ fg: pal().muted }}>{"> "}</span>
                <span>{t("balUnsupported")}</span>
              </text>
            </Show>
            <Show when={!balanceUnsupported()}>
              <Show when={balanceState().status === "idle"}>
                <text fg={pal().muted}>
                  <span style={{ fg: pal().muted }}>{"> "}</span>
                  <span>{t("balNoKey", { p: providerName() })}</span>
                </text>
              </Show>
              <Show when={balanceState().status === "loading"}>
                <text fg={pal().muted}>
                  <span style={{ fg: pal().muted }}>{"> "}</span>
                  <span>{t("balLoading")}</span>
                </text>
              </Show>
              <Show when={balanceState().status === "error"}>
                <text fg={pal().error}>
                  <span style={{ fg: pal().muted }}>{"> "}</span>
                  <span>{(() => {
                    const code = balanceState().error
                    if (code === "401") return t("balErr401")
                    if (code === "403") return t("balErr403")
                    if (code === "EMPTY") return t("balErrEmpty")
                    if (code === "TIMEOUT") return t("balErrTimeout")
                    return t("balError") + (code ? ` (${code})` : "")
                  })()}</span>
                </text>
              </Show>
              <Show when={balanceState().status === "ok" && balanceState().data}>
                <text fg={pal().text}>
                  {justify(t("balTotal"), formatBalanceText(balanceState().data!, balanceCurrency(), exchangeRate()))}
                </text>
              </Show>
            </Show>
          </Show>
        </Show>
      </Show>
    </box>
  )
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/**
 * 输入框 hint 行（session_prompt slot 的 hint）：单行显示 路径 · 命中率 · 余额 · Tokens。
 * 通过 ui.Prompt 的 hint prop 注入——宿主右侧的 token/commands 提示自动保留，
 * 三合一信息与路径同行显示在中间位置。
 */
function BottomStatusBar(props: { api: TuiPluginApi; signals: PanelSignals; sessionId: string }): JSX.Element {
  const KV_PREFIX = "cache_panel"
  const t = createT(() => props.signals.langCode())

  const sid = props.sessionId

  // ── 命中率（单条口径：最后一条有 token 的 assistant 消息）+ token 汇总 ──
  const stats = createMemo(() => {
    const id = sid
    if (!id) return null
    const msgs = props.api.state.session.messages(id) as Message[]
    const session = typeof props.api.state.session.get === "function"
      ? props.api.state.session.get(id)
      : undefined
    let input = session?.tokens?.input ?? 0
    let read = session?.tokens?.cache?.read ?? 0
    let write = session?.tokens?.cache?.write ?? 0
    // 旧 SDK 无 session 聚合字段 → 遍历消息累加（与侧边栏 fallback 一致）
    if (session?.tokens == null) {
      for (const m of msgs) {
        if (m.role !== "assistant") continue
        const tk = (m as AssistantMessage).tokens
        if (!tk) continue
        input += num(tk.input)
        read += num(tk.cache?.read)
        write += num(tk.cache?.write)
      }
    }
    // 从后往前取最后两条有 token 数据的 assistant 消息 → 单条命中率 + 趋势
    // 分母含缓存写（业界口径：read / (input+read+write)）
    let hitRate = -1, prevHitRate = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role !== "assistant") continue
      const tk = (m as AssistantMessage).tokens
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
  })

  // 余额查询状态为共享信号（PanelSignals.balanceState），由 tui() 统一轮询

  // 自动切换 provider（跟随当前会话模型；幂等，与侧边栏共享信号）
  createEffect(() => {
    if (!props.signals.autoBalance()) return
    const id = sid
    if (!id) return
    const msgs = props.api.state.session.messages(id) as Message[]
    let pid = ""
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role === "assistant" && (m as AssistantMessage).providerID) { pid = (m as AssistantMessage).providerID; break }
    }
    if (!pid) {
      try { pid = props.api.state.session.get(id)?.model?.providerID ?? "" } catch {}
    }
    if (!pid) return
    const hit = matchBalanceProvider(pid)
    if (hit) {
      props.signals.setBalanceUnsupported(false)
      if (hit.id !== props.signals.balanceProviderId()) {
        props.signals.setBalanceProviderId(hit.id)
        props.signals.setBalanceRefresh(props.signals.balanceRefresh() + 1)
      }
    } else {
      // 当前提供商没有余额适配器 → 标记不支持，余额显示 N/A 并停止轮询
      props.signals.setBalanceUnsupported(true)
    }
  })

  // ── 主题色（与侧边栏同口径）──
  const pal = createMemo(() => {
    const th = props.api.theme.current as Record<string, unknown>
    const sat = (k: string, fb: string) => desaturateTo(th[k], MAX_SAT, fb)
    return {
      text:    sat("text",      FALLBACK.text),
      muted:   sat("textMuted", FALLBACK.muted),
      success: sat("success",   FALLBACK.success),
      warning: sat("warning",   FALLBACK.warning),
      error:   sat("error",     FALLBACK.error),
    }
  })

  const hitColor = createMemo(() => {
    const r = stats()?.hitRate ?? -1
    if (r >= 85) return pal().success
    if (r >= 70) return pal().warning
    return pal().error
  })

  // 命中率趋势：最后一条与上一条的差值；|Δ| < 0.05 视为无变化（null = 不显示）
  const trend = createMemo(() => {
    const s = stats()
    if (!s || s.prevHitRate < 0 || s.hitRate < 0) return null
    const d = s.hitRate - s.prevHitRate
    return Math.abs(d) < 0.05 ? null : d
  })

  const balanceText = createMemo(() => {
    const s = props.signals.balanceState()
    if (s.status === "ok" && s.data) return formatBalanceText(s.data, props.signals.balanceCurrency(), props.signals.exchangeRate())
    if (s.status === "loading") return "\u2026"
    if (s.status === "error") return "\u26a0"
    return "-"
  })

  // 路径显示（替换宿主默认 hint 左侧的 cwd 文本）
  const directory = createMemo(() => {
    try { return props.api.state.path.directory } catch { return "" }
  })

  // 恢复显隐偏好（默认显示）；关闭时回退为仅显示路径，与宿主默认 hint 行一致
  onMount(() => {
    try {
      const v = props.api.kv.get<boolean>(`${KV_PREFIX}.section.bottom`, true)
      props.signals.setSectionBottom(v !== false)
    } catch {}
  })

  return (
    <Show when={props.signals.sectionBottom()} fallback={<text fg={pal().muted}>{directory()}</text>}>
      <box marginLeft={1} flexGrow={1} flexShrink={0} flexDirection="row" justifyContent="space-between">
        <text fg={pal().muted}>{directory()}</text>
      <box flexDirection="row">
        <text>
          <span style={{ fg: pal().muted }}>{t("barHit")} </span>
          <span style={{ fg: hitColor() }}>{(stats()?.hitRate ?? -1) >= 0 ? (Math.floor(stats()!.hitRate * 10) / 10).toFixed(1) + "%" : "--"}</span>
          <Show when={trend() !== null}>
            <span style={{ fg: trend()! > 0 ? pal().success : pal().error }}>
              {" " + (trend()! > 0 ? "\u2191" : "\u2193") + Math.abs(trend()!).toFixed(1) + "%"}
            </span>
          </Show>
          <span style={{ fg: pal().muted }}>{" \u00b7 " + t("barTok") + " "}</span>
          <span style={{ fg: pal().text }}>
            {stats() ? fmtCompact(stats()!.input + stats()!.read + stats()!.write) : "--"}
          </span>
          <Show when={!props.signals.balanceUnsupported()}>
            <span style={{ fg: pal().muted }}>{" \u00b7 " + t("barBal") + " "}</span>
            <span style={{ fg: pal().text }}>{balanceText()}</span>
          </Show>
        </text>
        <text fg={pal().muted}>{" \u00b7 "}</text>
        </box>
      </box>
    </Show>
  )
}

function createSidebarSlot(api: TuiPluginApi, signals: PanelSignals): TuiSlotPlugin {
  let lastSlotSid = ""
  return {
    order: 55,
    slots: {
      sidebar_content(ctx: TuiSlotContext, input: { session_id: string }): JSX.Element {
        // ── auto-clear override when the user navigates to a different main session ──
        if (input.session_id !== lastSlotSid) {
          lastSlotSid = input.session_id
          if (signals.overrideSessionId()) {
            signals.setOverrideSessionId(undefined)
            api.kv.set("cache_panel.session", "")
          }
        }
        return (
          <TokenCachePanel
            theme={ctx.theme.current}
            api={api}
            sessionId={input.session_id}
            signals={signals}
          />
        )
      },
    },
  }
}

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  // ── shared panel signals ──────────────────────────────────────
  const [currencySymbol, setCurrencySymbol] = createSignal("$")
  const [exchangeRate, setExchangeRate] = createSignal(1)
  const [sectionDetail, setSectionDetail] = createSignal(true)
  const [sectionModel, setSectionModel] = createSignal(true)
  const [sectionDist, setSectionDist] = createSignal(true)
  const [sectionSkills, setSectionSkills] = createSignal(true)
  const [sectionBalance, setSectionBalance] = createSignal(true)
  const [sectionBottom, setSectionBottom] = createSignal(true)
  const [balanceRefresh, setBalanceRefresh] = createSignal(0)
  const [balanceProviderId, setBalanceProviderId] = createSignal("deepseek")
  const [autoBalance, setAutoBalance] = createSignal(true)
  const [balanceUnsupported, setBalanceUnsupported] = createSignal(false)
  const [balanceCurrency, setBalanceCurrency] = createSignal("")
  const [borderVisible, setBorderVisible] = createSignal(true)
  const [langCode, setLangCode] = createSignal<LangCode>(INIT_LANG)
  const [overrideSessionId, setOverrideSessionId] = createSignal<string | undefined>(undefined)

  // ── 余额查询状态（共享）：侧边栏与底部栏读同一份数据，
  //    避免重复请求导致两处余额不一致 ──
  const [balanceState, setBalanceState] = createSignal<BalanceState>({
    status: "idle", data: null, lastFetch: 0,
  })
  // 请求序号：防止定时轮询与手动刷新并发时，慢的旧请求覆盖新结果
  let balanceSeq = 0

  const signals: PanelSignals = {
    currencySymbol, setCurrencySymbol,
    exchangeRate, setExchangeRate,
    langCode, setLangCode,
    sectionDetail, setSectionDetail,
    sectionModel, setSectionModel,
    sectionDist, setSectionDist,
    sectionSkills, setSectionSkills,
    sectionBalance, setSectionBalance,
    sectionBottom, setSectionBottom,
    balanceRefresh, setBalanceRefresh,
    balanceProviderId, setBalanceProviderId,
    autoBalance, setAutoBalance,
    balanceUnsupported, setBalanceUnsupported,
    balanceState,
    balanceCurrency, setBalanceCurrency,
    borderVisible, setBorderVisible,
    overrideSessionId, setOverrideSessionId,
  }

  api.slots.register(createSidebarSlot(api, signals))

  // 输入框 hint 行（session_prompt slot，replace 模式）：
  // 用宿主同一 Prompt 组件重渲染输入框，仅替换 hint 行左侧——
  // 在路径与右侧 token/commands 提示之间插入 命中率 · 余额 · Tokens。
  api.slots.register({
    order: 55,
    slots: {
      session_prompt(
        _ctx: TuiSlotContext,
        input: {
          session_id: string
          visible?: boolean
          disabled?: boolean
          on_submit?: () => void
          ref?: (ref: TuiPromptRef | undefined) => void
        },
      ): JSX.Element {
        return (
          <api.ui.Prompt
            sessionID={input.session_id}
            visible={input.visible}
            disabled={input.disabled}
            onSubmit={input.on_submit}
            ref={input.ref}
            hint={<BottomStatusBar api={api} signals={signals} sessionId={input.session_id} />}
          />
        )
      },
    },
  })

  // ── slash commands for runtime config ──
  const KV_PREFIX = "cache_panel"

  // ── 语言偏好恢复：KV 就绪后优先用户设置（/cache-lang），覆盖自动识别 ──
  const restoreLang = () => {
    try {
      const saved = api.kv.get<string>(`${KV_PREFIX}.lang`)
      if (saved && LANG_META.some((m) => m.code === saved)) setLangCode(saved as LangCode)
    } catch {}
  }
  if (api.kv.ready) {
    restoreLang()
  } else {
    const langTimer = setInterval(() => {
      if (api.kv.ready) { clearInterval(langTimer); restoreLang() }
    }, 10)
    api.lifecycle.onDispose(() => clearInterval(langTimer))
  }

  const pollBalance = async () => {
    const provider = getBalanceProvider(balanceProviderId())
    // 手动配置的 key 优先；缺失时自动复用 OpenCode 已认证的 key（auth.json / config）
    const key = api.kv.get<string>(`${KV_PREFIX}.balance.${provider.id}.key`, "")
      || findOpencodeKey(api, provider)
    if (balanceUnsupported()) { setBalanceState({ status: "idle", data: null, lastFetch: 0, error: undefined, key: undefined }); return }
    if (!key) { setBalanceState({ status: "idle", data: null, lastFetch: 0, error: undefined, key: undefined }); return }
    const now = Date.now()
    const prev = balanceState()
    // key 已更换（重新输入）→ 强制重新查询，绕过缓存
    if (prev.status === "ok" && prev.key === key && now - prev.lastFetch < BALANCE_POLL_MS) return // cache still fresh
    const seq = ++balanceSeq
    setBalanceState({ ...prev, status: "loading", error: undefined, key })
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, 10_000)
    try {
      const data = await provider.fetchBalance(key, controller.signal)
      clearTimeout(timer)
      if (seq !== balanceSeq) return // 已被更新的请求取代，丢弃过期结果
      setBalanceState({ status: "ok", data, lastFetch: Date.now(), error: undefined, key })
    } catch (err) {
      clearTimeout(timer)
      if (seq !== balanceSeq) return
      const code = timedOut ? "TIMEOUT" : (err instanceof Error ? err.message : "")
      // 失败时清空旧数据，避免显示过期余额
      setBalanceState({ status: "error", data: null, lastFetch: 0, error: code, key })
    }
  }

  // Re-fetch when the API key is (re)configured via /cache-balance-key.
  // 注意：pollBalance 内部读写 balanceState 信号，若不做 untrack 包裹，
  // effect 会追踪 balanceState 的变化并与 pollBalance 的 setBalanceState
  // 形成无限循环（每次重跑都发起新的 fetch 请求）。
  createEffect(() => {
    void balanceRefresh()
    untrack(() => { void pollBalance() })
  })

  // 定时轮询（5 分钟）；随插件生命周期清理
  const balanceTimer = setInterval(pollBalance, BALANCE_POLL_MS)
  api.lifecycle.onDispose(() => clearInterval(balanceTimer))

  /** 菜单中 provider 选项标题：标注 key 来源（手动配置 / OpenCode 自动复用 / 未配置）。 */
  const providerOptionTitle = (p: BalanceProvider, current?: string) => {
    const t = createT(() => langCode())
    const hasManual = !!api.kv.get<string>(`${KV_PREFIX}.balance.${p.id}.key`, "")
    const hasAuto = !hasManual && !!findOpencodeKey(api, p)
    const mark = hasManual
      ? t("keyUser")
      : hasAuto
        ? t("keyOpenCode")
        : t("keyNotSet")
    return p.name + mark + (current && p.id === current ? " *" : "")
  }

  /** 弹出指定 provider 的 API Key 输入框（脱敏预填；空清除 / 含 * 保留原 key / 新 key 实时刷新）。 */
  const promptBalanceKey = (dialog: TuiDialogStack | undefined, provider: BalanceProvider) => {
    const t = createT(() => langCode())
    const current = api.kv.get<string>(`${KV_PREFIX}.balance.${provider.id}.key`, "")
    const masked = maskKey(current)
    dialog?.replace(() => (
      <api.ui.DialogPrompt
        title={provider.name}
        description={() => <text>{t("balKeyPrompt", { p: provider.name })}</text>}
        placeholder={provider.keyPlaceholder ?? "sk-..."}
        value={masked}
        onConfirm={(val) => {
          const input = val.trim()
          let key: string
          if (input === "") {
            key = ""
          } else if (input.includes("*")) {
            key = current
          } else {
            key = input
          }
          api.kv.set(`${KV_PREFIX}.balance.${provider.id}.key`, key)
          setBalanceRefresh(v => v + 1)
          if (key) {
            api.ui.toast({ message: t("keySaved") })
          } else {
            api.ui.toast({ message: t("keyCleared") })
          }
          dialog?.clear()
        }}
        onCancel={() => dialog?.clear()}
      />
    ))
  }

  api.command?.register(() => [
    {
      title: "Cache: Set Currency",
      value: "cache.currency",
      description: "Change the currency unit for cost display",
      slash: { name: "cache-currency" },
      onSelect: (dialog) => {
        dialog?.replace(() => (
          <api.ui.DialogSelect
            title="Select Currency"
            options={Object.entries(CURRENCIES).map(([code, sym]) => ({
              title: `${code}  (${sym})`,
              value: code,
            }))}
            onSelect={(opt) => {
              const t = createT(() => langCode())
              const sym = CURRENCIES[opt.value] ?? "$"
              const defRate = DEFAULT_RATES[opt.value] ?? 1
              api.kv.set(`${KV_PREFIX}.currency`, sym)
              api.kv.set(`${KV_PREFIX}.rate`, defRate)
              // 同步余额显示币种偏好：CNY/USD 原生直显，其余币种按汇率换算
              api.kv.set(`${KV_PREFIX}.balance_currency`, opt.value)
              signals.setBalanceCurrency(opt.value)
              signals.setCurrencySymbol(sym)
              signals.setExchangeRate(defRate)
              api.ui.toast({ message: t("currencySet", { v: opt.value, s: sym, r: defRate }) })
              dialog?.clear()
            }}
          />
        ))
      },
    },
    {
      title: "Cache: Set Exchange Rate",
      value: "cache.rate",
      description: "Set the exchange rate multiplier for the selected currency",
      slash: { name: "cache-rate" },
      onSelect: (dialog) => {
        dialog?.replace(() => (
          <api.ui.DialogPrompt
            title="Exchange Rate"
            description={() => <text>Enter the exchange rate from USD to your currency (e.g. 7.2 for CNY)</text>}
            placeholder="1.0"
            value={String(api.kv.get<number>(`${KV_PREFIX}.rate`, 1))}
            onConfirm={(val) => {
              const t = createT(() => langCode())
              const n = parseFloat(val)
              if (n > 0) {
                api.kv.set(`${KV_PREFIX}.rate`, n)
                signals.setExchangeRate(n)
                api.ui.toast({ message: t("rateSet", { r: n }) })
              }
              dialog?.clear()
            }}
          />
        ))
      },
    },
    {
      title: "Cache: Toggle Section",
      value: "cache.section",
      description: "Show or hide a sidebar section",
      slash: { name: "cache-section" },
      onSelect: (dialog) => {
        const t = createT(() => langCode())
        const detailOn = Boolean(api.kv.get(`${KV_PREFIX}.section.detail`, true))
        const modelOn  = Boolean(api.kv.get(`${KV_PREFIX}.section.model`, true))
        const distOn   = Boolean(api.kv.get(`${KV_PREFIX}.section.dist`, true))
        const skillsOn = Boolean(api.kv.get(`${KV_PREFIX}.section.skills`, true))
        const balanceOn = Boolean(api.kv.get(`${KV_PREFIX}.section.balance`, true))
        const bottomOn = Boolean(api.kv.get(`${KV_PREFIX}.section.bottom`, true))
        const borderOn = Boolean(api.kv.get(`${KV_PREFIX}.border`, true))
        const labels: Record<string, string> = {
          detail:  t("secDetail"),
          model:   t("secModel"),
          dist:    t("distTitle"),
          skills:  t("secSkills"),
          balance: t("secBalance"),
          bottom:  t("secBottom"),
          border:  t("secBorder"),
        }
        const optTitle = (label: string, on: boolean) => `${visualPadEnd(label, 15)}[${on ? "ON" : "OFF"}]`
        dialog?.replace(() => (
          <api.ui.DialogSelect
            title={t("secToggle")}
            options={[
              { title: optTitle(labels.detail, detailOn),   value: "detail" },
              { title: optTitle(labels.model, modelOn),     value: "model" },
              { title: optTitle(labels.dist, distOn),       value: "dist" },
              { title: optTitle(labels.skills, skillsOn),   value: "skills" },
              { title: optTitle(labels.balance, balanceOn), value: "balance" },
              { title: optTitle(labels.bottom, bottomOn),   value: "bottom" },
              { title: optTitle(labels.border, borderOn),   value: "border" },
            ]}
            onSelect={(opt) => {
              if (opt.value === "border") {
                const cur = Boolean(api.kv.get(`${KV_PREFIX}.border`, true))
                api.kv.set(`${KV_PREFIX}.border`, !cur)
                signals.setBorderVisible(!cur)
                api.ui.toast({ message: !cur ? t("borderShown") : t("borderHidden") })
              } else {
                const key = `${KV_PREFIX}.section.${opt.value}`
                const cur = Boolean(api.kv.get(key, true))
                api.kv.set(key, !cur)
                if (opt.value === "detail") signals.setSectionDetail(!cur)
                if (opt.value === "model")  signals.setSectionModel(!cur)
                if (opt.value === "dist")   signals.setSectionDist(!cur)
                if (opt.value === "skills") signals.setSectionSkills(!cur)
                if (opt.value === "balance") signals.setSectionBalance(!cur)
                if (opt.value === "bottom")  signals.setSectionBottom(!cur)
                const name = labels[opt.value] ?? opt.value
                api.ui.toast({ message: t(!cur ? "sectionShown" : "sectionHidden", { s: name }) })
              }
              dialog?.clear()
            }}
          />
        ))
      },
    },
    {
      title: "Cache: Show Config",
      value: "cache.config",
      description: "Display the current plugin configuration",
      slash: { name: "cache-config" },
      onSelect: (dialog) => {
        const t = createT(() => langCode())
        const sym = api.kv.get<string>(`${KV_PREFIX}.currency`) ?? "$"
        const rate = api.kv.get<number>(`${KV_PREFIX}.rate`) ?? 1
        const detail = Boolean(api.kv.get(`${KV_PREFIX}.section.detail`, true))
        const model = Boolean(api.kv.get(`${KV_PREFIX}.section.model`, true))
        const dist = Boolean(api.kv.get(`${KV_PREFIX}.section.dist`, true))
        const skills = Boolean(api.kv.get(`${KV_PREFIX}.section.skills`, true))
        const balance = Boolean(api.kv.get(`${KV_PREFIX}.section.balance`, true))
        const bottom = Boolean(api.kv.get(`${KV_PREFIX}.section.bottom`, true))
        const on = (v: boolean) => v ? "ON" : "OFF"
        api.ui.toast({
          title: t("panelConfigTitle"),
          message: t("panelConfigMsg", {
            c: sym, r: rate,
            d: on(detail), m: on(model),
            t: on(dist), k: on(skills),
            b: on(balance), f: on(bottom),
          }),
          duration: 8000,
        })
        dialog?.clear()
      },
    },
    {
      title: "Cache: Switch Language",
      value: "cache.lang",
      description: "Switch between Chinese and English display",
      slash: { name: "cache-lang" },
      onSelect: (dialog) => {
        const t = createT(() => langCode())
        const cur = langCode()
        dialog?.replace(() => (
          <api.ui.DialogSelect
            title={t("langTitle")}
            options={LANG_META.map((m) => ({
              title: `${visualPadEnd(m.label, 9)}${cur === m.code ? "\u2713" : ""}`,
              value: m.code,
            }))}
            onSelect={(opt) => {
              const code = opt.value as LangCode
              api.kv.set(`${KV_PREFIX}.lang`, code)
              setLangCode(code)
              api.ui.toast({ message: t("langSwitched") })
              dialog?.clear()
            }}
          />
        ))
      },
    },
    {
      title: "Cache: Switch Balance Provider",
      value: "cache.balance",
      description: "切换余额提供商 / 自动切换当前会话提供商 | Switch balance provider / auto-switch session provider",
      slash: { name: "cache-balance" },
      onSelect: (dialog) => {
        const t = createT(() => langCode())
        const current = signals.balanceProviderId()
        const auto = signals.autoBalance()
        const autoLabel = `${t("autoSwitchOpt")} [${auto ? "ON" : "OFF"}]`
        dialog?.replace(() => (
          <api.ui.DialogSelect
            title={t("balProvTitle")}
            options={[
              {
                title: autoLabel,
                value: "__auto__",
              },
              ...balanceProviders.map((p) => ({
                title: providerOptionTitle(p, current),
                value: p.id,
              })),
            ]}
            onSelect={(opt) => {
              if (opt.value === "__auto__") {
                const next = !auto
                api.kv.set(`${KV_PREFIX}.balance.auto`, next)
                signals.setAutoBalance(next)
                api.ui.toast({ message: next ? t("autoSwitchOn") : t("autoSwitchOff") })
                dialog?.clear()
              } else {
                const provider = getBalanceProvider(opt.value)
                // 手动切换会关闭自动切换
                api.kv.set(`${KV_PREFIX}.balance.provider`, provider.id)
                api.kv.set(`${KV_PREFIX}.balance.auto`, false)
                signals.setBalanceProviderId(provider.id)
                signals.setAutoBalance(false)
                signals.setBalanceUnsupported(false)
                // 切换后立即按新 provider 刷新显示（无 key 时显示 idle，避免残留上一 provider 余额）
                signals.setBalanceRefresh(signals.balanceRefresh() + 1)
                const hasKey = !!api.kv.get<string>(`${KV_PREFIX}.balance.${provider.id}.key`, "")
                if (!hasKey) {
                  // 未配置 key → 进入设置流程（对话框保持打开等待输入）
                  promptBalanceKey(dialog, provider)
                } else {
                  api.ui.toast({ message: t("providerManual", { p: provider.name }) })
                  dialog?.clear()
                }
              }
            }}
          />
        ))
      },
    },
    {
      title: "Cache: Set Balance API Key",
      value: "cache.balance.key",
      description: "Select a provider and set its API key for balance display",
      slash: { name: "cache-balance-key" },
      onSelect: (dialog) => {
        const t = createT(() => langCode())
        // 步骤 1：选择 provider
        dialog?.replace(() => (
          <api.ui.DialogSelect
            title={t("balSelectTitle")}
            options={balanceProviders.map((p) => ({
              title: providerOptionTitle(p),
              value: p.id,
            }))}
            onSelect={(opt) => {
              const provider = getBalanceProvider(opt.value)
              // 手动指定 provider 会关闭自动切换
              api.kv.set(`${KV_PREFIX}.balance.provider`, provider.id)
              api.kv.set(`${KV_PREFIX}.balance.auto`, false)
              signals.setBalanceProviderId(provider.id)
              signals.setAutoBalance(false)
              // 切换后立即刷新显示（防止取消输入时残留上一 provider 的余额）
              signals.setBalanceRefresh(signals.balanceRefresh() + 1)
              // 步骤 2：输入 key
              promptBalanceKey(dialog, provider)
            }}
          />
        ))
      },
    },
    {
      title: "Cache: Debug Skills Detection",
      value: "cache.debug-skills",
      description: "Dump all tool parts found in the current session for skill detection debugging",
      slash: { name: "cache-debug-skills" },
      onSelect: () => {
        const t = createT(() => langCode())
        const rt = api.route.current
        if (rt.name !== "session" || !rt.params) {
          api.ui.toast({ message: t("runInSession"), variant: "warning" })
          return
        }
        const sid = String(rt.params.sessionID)
        const msgs = api.state.session.messages(sid)
        const byTool: Record<string, number> = {}
        const skillParts: string[] = []
        for (const msg of msgs) {
          if (msg.role !== "assistant") continue
          let parts: readonly any[] = []
          try { parts = api.state.part(msg.id) } catch {}
          for (const p of parts) {
            if (p.type === "tool") {
              const t = String(p.tool ?? "?")
              byTool[t] = (byTool[t] ?? 0) + 1
              if (t === "skill") {
                const meta = p.state?.metadata
                const rootMeta = p.metadata
                skillParts.push(`state.metadata=${JSON.stringify(meta)} | root.metadata=${JSON.stringify(rootMeta)} | state.title="${p.state?.title}" | state.output[:80]="${String(p.state?.output ?? "").slice(0, 80)}"`)
              }
            }
          }
        }
        const summary = Object.entries(byTool).map(([k, v]) => `${k}: ${v}`).join(" | ")
        const extra = skillParts.length > 0 ? "\n\nSkill parts:\n" + skillParts.join("\n") : "\n\n⚠ No skill tool parts found — AI may be reading SKILL.md instead. Try: 'Use the skill tool to load karpathy-guidelines'"
        api.ui.toast({
          title: `Tool Summary (${Object.keys(byTool).length} types)`,
          message: summary + extra,
          duration: 15000,
        })
      },
    },
    {
      title: "Cache: Sub-Agent Stats",
      value: "cache.session",
      description: "View token cache statistics for a sub-agent by session ID",
      slash: { name: "cache-session" },
      onSelect: (dialog) => {
        // ── 扫描当前主 session 的子代理 session ID 列表 ──
        const rt = api.route.current
        const parentSid = rt.name === "session" && rt.params ? String(rt.params.sessionID) : ""
        const SUBAGENT_TOOLS = new Set(["task", "delegate", "call_omo_agent"])

        interface ChildEntry { title: string; value: string; description: string }
        const children: ChildEntry[] = []
        if (parentSid) {
          try {
            const msgs = api.state.session.messages(parentSid)
            for (const msg of msgs) {
              if (msg.role !== "assistant") continue
              let parts: readonly Part[] = []
              try { parts = api.state.part(msg.id) } catch {}
              for (const p of parts) {
                if (p.type !== "tool") continue
                const tool = String((p as ToolPart).tool ?? "")
                if (!SUBAGENT_TOOLS.has(tool)) continue
                const st = (p as any).state as Record<string, unknown> | undefined
                const stMeta = st?.metadata as Record<string, unknown> | undefined
                const subSid = stMeta?.session_id ?? stMeta?.sessionId
                if (!subSid) continue
                const sidStr = String(subSid)
                const input = st?.input as Record<string, unknown> | undefined
                const agent = String((p as any).subagent_type ?? input?.subagent_type ?? input?.category ?? tool)
                const prompt = String(input?.prompt ?? "")
                const desc = input?.description ? String(input.description) : ""
                const title = desc || prompt.replace(/\n/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || agent
                children.push({ title, value: sidStr, description: `${agent} · ${sidStr.slice(0, 24)}…` })
              }
            }
          } catch {}
        }

        // 去重
        const seen = new Set<string>()
        const unique = children.filter(c => { if (seen.has(c.value)) return false; seen.add(c.value); return true })

        if (unique.length > 0) {
          // ── 有子代理 → DialogSelect 列表选择 ──
          const t = createT(() => langCode())
          const currentSid = signals.overrideSessionId() ?? api.kv.get<string>(`${KV_PREFIX}.session`, "")
          const options = unique.map((c, i) => ({
            title: `${i + 1}. ${c.title}`,
            value: c.value,
            description: c.description,
          }))
          // 首尾各放一个"回到主会话"，长列表时顶部底部均可直达
          const backValue = "__main__"
          const backTitle = `\u2500 ${t("backToMainTitle")}`
          options.unshift({ title: backTitle, value: backValue, description: "" })
          options.push({ title: backTitle, value: backValue, description: "" })
          const currentIdx = currentSid ? options.findIndex(o => o.value === currentSid) : -1
          dialog?.replace(() => (
            <api.ui.DialogSelect
              title={t("subSelectTitle")}
              options={options}
              current={currentIdx >= 0 ? options[currentIdx].value : undefined}
              onSelect={(opt) => {
                if (opt.value === backValue) {
                  signals.setOverrideSessionId(undefined)
                  api.kv.set(`${KV_PREFIX}.session`, "")
                  api.ui.toast({ message: t("backToMain") })
                } else {
                  signals.setOverrideSessionId(opt.value)
                  api.kv.set(`${KV_PREFIX}.session`, opt.value)
                  api.ui.toast({ message: t("subAgentSwitched", { s: opt.value.slice(0, 24) + "\u2026" }) })
                }
                dialog?.clear()
              }}
            />
          ))
        } else {
          // ── 无子代理 → DialogPrompt 手动粘贴 ──
          const t = createT(() => langCode())
          dialog?.replace(() => (
            <api.ui.DialogPrompt
              title={signals.overrideSessionId() ? t("subSwitchTitle") : t("subViewTitle")}
              description={() => <text>{t("subNoFound")}</text>}
              placeholder="ses_..."
              value={signals.overrideSessionId() ?? api.kv.get<string>(`${KV_PREFIX}.session`, "") ?? ""}
              onConfirm={(val) => {
                const sid = val.trim()
                if (sid) {
                  signals.setOverrideSessionId(sid)
                  api.kv.set(`${KV_PREFIX}.session`, sid)
                  api.ui.toast({ message: t("subAgentSwitched", { s: sid.slice(0, 24) + "\u2026" }) })
                }
                dialog?.clear()
              }}
              onCancel={() => dialog?.clear()}
            />
          ))
        }
      },
    },
    {
      title: "Cache: Back to Main",
      value: "cache.session.back",
      description: "Return to main session stats",
      slash: { name: "cache-session-back" },
      onSelect: (dialog) => {
        const t = createT(() => langCode())
        signals.setOverrideSessionId(undefined)
        api.kv.set(`${KV_PREFIX}.session`, "")
        api.ui.toast({ message: t("backToMain") })
        dialog?.clear()
      },
    },
  ])
}

const mod: TuiPluginModule & { id: string } = {
  id: "opencode-visual-cache",
  tui,
}

export default mod
