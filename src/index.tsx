/** @jsxImportSource @opentui/solid */

import type { JSX } from "@opentui/solid"
import { Plugin } from "@opencode/plugin/tui"
import type { Context as TuiPluginContext } from "@opencode/plugin/tui/context"
import type {
  SessionMessageInfo,
  SessionMessageUser,
  SessionMessageAssistant,
  SessionMessageAssistantText,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantTool,
  TokenUsageInfo,
} from "@opencode/client"
import { createMemo, createSignal, createEffect, onMount, onCleanup, Show, For, untrack } from "solid-js"
import { PLUGIN_VERSION } from "./_version"
import { balanceProviders, getBalanceProvider, maskKey, matchBalanceProvider, type BalanceDetail, type BalanceDetailKey, type BalanceEntry, type BalanceProvider } from "./balance-providers"
import { LANG_META, createT, detectLang, type LangCode, type Translation } from "./i18n"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Bun / Node globals — available at runtime in the OpenCode TUI process
declare const process: {
  env: Record<string, string | undefined>
  getBuiltinModule?: (id: string) => unknown
} | undefined

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
 * OpenAI 优先读取 auth.json OAuth；其他 provider 读取 provider.key / provider.options.apiKey。
 * 读取失败或未匹配返回空串。
 */
function readOpenAIOAuthToken(): string {
  try {
    // OpenAI OAuth credentials are stored separately from provider.key.
    const loader = typeof process !== "undefined" ? process?.getBuiltinModule : undefined
    const fs = loader?.("node:fs") as { readFileSync(path: string, encoding: "utf8"): string } | undefined
    if (!fs) return ""
    const home = typeof process !== "undefined" ? (process?.env.HOME || process?.env.USERPROFILE || "") : ""
    const dataHome = typeof process !== "undefined" ? process?.env.XDG_DATA_HOME : undefined
    const appData = typeof process !== "undefined" ? process?.env.APPDATA : undefined
    const paths = [
      appData ? `${appData}/opencode/auth.json` : "",
      dataHome ? `${dataHome}/opencode/auth.json` : "",
      home ? `${home}/.local/share/opencode/auth.json` : "",
      home ? `${home}/Library/Application Support/opencode/auth.json` : "",
    ]
    for (const path of paths) {
      if (!path) continue
      try {
        const auth = JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, unknown>
        const openai = auth.openai
        if (openai && typeof openai === "object") {
          const record = openai as Record<string, unknown>
          if (record.type === "oauth" && typeof record.access === "string") return record.access
        }
      } catch { /* try the next known auth path */ }
    }
    return ""
  } catch {
    return ""
  }
}

function findOpencodeKey(_context: TuiPluginContext, provider: BalanceProvider): string {
  try {
    // In V2 the provider catalog no longer exposes raw API keys directly;
    // we fall back to the auth.json OAuth token (OpenAI only).  Other
    // providers must supply an explicit key via /cache-balance-key.
    const id = provider.id.toLowerCase()
    const isOpenAI = id === "openai"
    if (isOpenAI) {
      const oauth = readOpenAIOAuthToken()
      if (oauth) return oauth
    }
    return ""
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
  const custom = list.find((x) => x.display)
  if (custom?.display) return custom.display
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

const BALANCE_DETAIL_LABELS: Record<BalanceDetailKey, keyof Translation> = {
  plan: "balDetailPlan",
  used: "balDetailUsed",
  remaining: "balDetailRemaining",
  window: "balDetailWindow",
  reset: "balDetailReset",
  codeReview: "balDetailCodeReview",
  credits: "balDetailCredits",
  resetCredits: "balDetailResetCredits",
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
  /** True while our sidebar panel is mounted — host sidebar is visible (occupies 42 cols). */
  sidebarVisible: () => boolean
  setSidebarVisible: (v: boolean) => void
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

/**
 * Reactive V2 storage shape — replaces all of the V1 `api.kv.get/set` calls.
 * Lives in a single `context.storage.store("settings", { initial })` pair.
 *
 * Fold state and section visibility keys are exposed directly so the
 * component can do `storage.foo` reads and `updateStorage(d => { d.foo = v })`
 * writes without a key prefix.
 */
export interface SettingsStore {
  // ── fold state ──
  open: boolean
  detail: boolean
  model: boolean
  dist: boolean
  skills: boolean
  balanceOpen: boolean
  // ── section visibility ──
  sectionDetail: boolean
  sectionModel: boolean
  sectionDist: boolean
  sectionSkills: boolean
  sectionBalance: boolean
  sectionBottom: boolean
  border: boolean
  // ── currency / rate ──
  currency: string
  rate: number
  balanceCurrency: string
  // ── balance provider ──
  balanceProvider: string
  balanceAuto: boolean
  /** Provider-specific API key (cached; indexed by provider id). */
  balanceKeys: Record<string, string>
  // ── override session id (sub-agent stats) ──
  session: string
  // ── language ──
  lang: LangCode
  // ── distribution snapshot (last valid TokenDist) ──
  distSnapshot: TokenDist | null
}

type FoldKey = "open" | "detail" | "model" | "dist" | "skills" | "balanceOpen"

/** Build a SettingsStore with sane defaults — used as the `initial` for storage.store. */
function makeDefaultSettings(): SettingsStore {
  return {
    open: false,
    detail: true,
    model: true,
    dist: false,
    skills: true,
    balanceOpen: false,
    sectionDetail: true,
    sectionModel: true,
    sectionDist: true,
    sectionSkills: true,
    sectionBalance: true,
    sectionBottom: true,
    border: true,
    currency: "",
    rate: 1,
    balanceCurrency: "",
    balanceProvider: "",
    balanceAuto: true,
    balanceKeys: {},
    session: "",
    lang: INIT_LANG,
    distSnapshot: null,
  }
}


function TokenCachePanel(props: {
  theme: TuiPluginContext["theme"]
  context: TuiPluginContext
  storage: SettingsStore
  updateStorage: (mut: (draft: SettingsStore) => void) => Promise<void>
  sessionId: string
  signals: PanelSignals
}): JSX.Element {
  const [panelWidth, setPanelWidth] = createSignal(DEFAULT_PANEL_WIDTH)
  const [open, setOpen] = createSignal(true)
  const [detailOpen, setDetailOpen] = createSignal(true)
  const [modelOpen, setModelOpen] = createSignal(true)
  const [distOpen, setDistOpen] = createSignal(false)
  const [skillsOpen, setSkillsOpen] = createSignal(true)
  const [balanceOpen, setBalanceOpen] = createSignal(false)
  let boxEl: any

  // 侧边栏可见性通知：本面板挂载 ⇒ 宿主侧边栏可见（固定占用 42 列输入框宽度）
  createEffect(() => {
    props.signals.setSidebarVisible(true)
    onCleanup(() => props.signals.setSidebarVisible(false))
  })

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

  const formatBalanceDuration = (seconds: number, fallback = ""): string => {
    if (!Number.isFinite(seconds)) return ""
    let remaining = Math.max(0, Math.round(seconds))
    const days = Math.floor(remaining / 86400)
    remaining %= 86400
    const hours = Math.floor(remaining / 3600)
    remaining %= 3600
    const minutes = Math.floor(remaining / 60)
    const parts: string[] = []
    if (days > 0) parts.push(`${days}${t("balDay")}`)
    if (hours > 0 && parts.length < 2) parts.push(`${hours}${t("balHour")}`)
    if (minutes > 0 && parts.length < 2) parts.push(`${minutes}${t("balMinute")}`)
    return parts.join(langCode() === "en" ? " " : "") || fallback
  }

  const formatBalanceDetailValue = (detail: BalanceDetail): string => {
    if (detail.value === "unlimited") return t("balUnlimited")
    if (detail.key !== "reset") return detail.value
    return formatBalanceDuration(Number(detail.value), t("balResetSoon")) || detail.value
  }

  const formatBalanceDetailLabel = (detail: BalanceDetail): string => {
    const label = t(BALANCE_DETAIL_LABELS[detail.key])
    if (detail.windowSeconds === undefined) return label
    const window = formatBalanceDuration(detail.windowSeconds)
    return window ? `${label} (${window})` : label
  }

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
    const msgs = props.context.data.session.message.list(sid) ?? []
    let pid = ""
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.type === "assistant" && (m as SessionMessageAssistant).model?.providerID) {
        pid = (m as SessionMessageAssistant).model!.providerID
        break
      }
    }
    // 会话尚无 assistant 消息（新会话 / 刚切换模型未对话 / 消息未加载）
    // → 回退到会话级模型元数据，反映当前正在使用的 provider
    if (!pid) {
      try {
        const session = props.context.data.session.get(sid)
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
        void props.updateStorage((d) => { d.session = "" })
      }
    }
  })

  createEffect(() => {
    const sid = props.signals.overrideSessionId() ?? props.sessionId
    void refreshTick()
    void partVersion()

    // 自然追踪 messages 和 provider（SDK 数据就绪时自动重新执行）
    const msgs = props.context.data.session.message.list(sid) ?? []
    const session = props.context.data.session.get(sid)

    // 累计值优先使用 Session 聚合字段（数据库级，不受 sync 层 limit:100 截断）
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
      if (msg.type !== "assistant") continue
      const tok = (msg as SessionMessageAssistant).tokens; if (!tok) continue
      const mit = num(tok.input) + num(tok.cache?.read) + num(tok.cache?.write), mrt = num(tok.cache?.read)
      if (mit > 0) { prevMsgHitRate = lastMsgHitRate; lastMsgHitRate = (mrt / mit) * 100 }
      if (fallbackTokens) {
        input += num(tok.input); read += num(tok.cache?.read); write += num(tok.cache?.write); output += num(tok.output)
      }
      if (fallbackCost) {
        cost += num((msg as SessionMessageAssistant).cost)
      }
      if (fallbackModel && (msg as SessionMessageAssistant).model?.providerID && (msg as SessionMessageAssistant).model?.id) {
        pid = (msg as SessionMessageAssistant).model!.providerID; mid = (msg as SessionMessageAssistant).model!.id
      }
    }
    // 价格从 catalog 获取（V2）：从客户端拉取一次并缓存到 ref 中；
    // 不引入 createResource 以避免阻塞 setup 但允许重复解析模型定价。
    let saved = 0, inputRate = 0, cacheReadRate = 0, cacheWriteRate = 0
    if (read > 0 && pid && mid) {
      try {
        const out = props.context.client.model.list()
        // The client returns a Promise; we need to handle it. Use a microtask that
        // doesn't block — best-effort pricing (only updates if the data is already
        // resolved). For now, capture model cost by iterating messages if model.list
        // is synchronously unavailable.
        if (out && typeof (out as any).then !== "function") {
          const data = (out as any).data as Array<{ providerID: string; modelID: string; cost: Array<{ input: number; output: number; cache: { read: number; write: number } }> }> | undefined
          const m = data?.find((x) => x.providerID === pid && x.modelID === mid)
          if (m?.cost?.length) {
            const c = m.cost[m.cost.length - 1]
            inputRate = num(c.input); cacheReadRate = num(c.cache?.read); cacheWriteRate = num(c.cache?.write)
            if (inputRate > cacheReadRate) saved = (read * (inputRate - cacheReadRate)) / 1_000_000
          }
        }
      } catch { /* ignore */ }
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
        // V2 没有直接的 state.config：system prompt 通过 agent metadata 估算很复杂，
        // 此处保留为占位估算（默认 0），详细 system prompt 大小由侧边栏 stat 块覆盖。
        let lastAssMsg: SessionMessageAssistant | undefined
        for (const msg of msgs) {
          if (msg.type === "user") {
            const um = msg as SessionMessageUser
            // V2 的 user 消息没有独立 system 字段；attachments 计入 user tokens
            if (um.text) dist.user += estimateTokens(um.text)
            if (um.files) for (const f of um.files) {
              // 没有 source.text 直接暴露，按文件名占位
              const meta = (f as unknown as { filename?: string }).filename ?? ""
              if (meta) dist.user += estimateTokens(meta)
            }
          } else if (msg.type === "assistant") {
            const am = msg as SessionMessageAssistant
            dist.output += num(am.tokens?.output)
            dist.reasoning += num(am.tokens?.reasoning)
            for (const part of am.content ?? []) {
              if (part.type === "tool") {
                const tp = part as SessionMessageAssistantTool
                let rawInput = ""
                try {
                  const st = tp.state as unknown as { input?: unknown }
                  rawInput = st.input != null ? JSON.stringify(st.input) : ""
                } catch {}
                if (rawInput) dist.toolCall += estimateTokens(rawInput)
                // 子代理委托（task 工具）：任务描述计入子代理指令
                if (tp.name === "task") {
                  const st = tp.state as unknown as { input?: { prompt?: string; description?: string } }
                  const prompt = typeof st.input?.prompt === "string" ? st.input.prompt : ""
                  const desc = typeof st.input?.description === "string" ? st.input.description : ""
                  dist.agent += estimateTokens(prompt || desc)
                }
                if (tp.state.status === "completed") {
                  const st = tp.state as unknown as { content?: ReadonlyArray<unknown> }
                  if (Array.isArray(st.content)) for (const c of st.content) {
                    if (typeof c === "string") dist.toolResult += estimateTokens(c)
                    else if (c && typeof c === "object") dist.toolResult += estimateTokens(JSON.stringify(c))
                  }
                } else if (tp.state.status === "error") {
                  const st = tp.state as unknown as { error?: { message?: string } }
                  const msg = st.error?.message ?? ""
                  if (msg) dist.toolResult += estimateTokens(msg)
                }
                if (tp.name === "skill" && tp.state.status === "completed") {
                  const st = tp.state as unknown as { metadata?: { name?: string }; content?: ReadonlyArray<unknown> }
                  let name: string | undefined = st.metadata?.name
                  if (typeof name !== "string") {
                    for (const c of st.content ?? []) {
                      const text = typeof c === "string" ? c : (c && typeof c === "object" && "text" in (c as any) && typeof (c as any).text === "string" ? (c as any).text : "")
                      const m = text.match(/^#{1,2}\s*Skill:\s*(.+)/m)
                      if (m) { name = m[1].trim(); break }
                    }
                  }
                  if (typeof name === "string") {
                    let tokens = 0
                    for (const c of st.content ?? []) {
                      if (typeof c === "string") tokens += estimateTokens(c)
                      else if (c && typeof c === "object") tokens += estimateTokens(JSON.stringify(c))
                    }
                    const existing = loadedSkills.get(name)
                    if (!existing || existing.tokens < tokens) {
                      loadedSkills.set(name, { name, tokens })
                    }
                  }
                }
              }
            }
          }
        }
        // 从后往前找最后一条有 token 数据的 assistant 消息（避免取到 streaming 中未填充的消息）
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].type !== "assistant") continue
          const tok = (msgs[i] as SessionMessageAssistant).tokens
          if (tok && ((tok.input ?? 0) > 0 || (tok.cache?.read ?? 0) > 0 || (tok.cache?.write ?? 0) > 0)) { lastAssMsg = msgs[i] as SessionMessageAssistant; break }
        }
        // 取最后一条有数据消息的总输入（含缓存读/写）作为当前 context 大小
        dist.apiInput = num(lastAssMsg?.tokens?.input) + num(lastAssMsg?.tokens?.cache?.read) + num(lastAssMsg?.tokens?.cache?.write)
        dist.apiOutput = num(lastAssMsg?.tokens?.output)
        // 本回合（最后一条有数据消息所在的 parentID 链）的 API 调用次数与末次成本。
        // V2 中 assistant 消息不再按独立 step-finish part 计费（cost 直接挂在 message 上），
        // 简化策略：每条 assistant 消息计 1 次 step（与 V1 估算对齐）。
        if (lastAssMsg) {
          const roundParent = (lastAssMsg as SessionMessageAssistant).id
          let lastCost: number | undefined
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i]
            if (m.type !== "assistant") continue
            if ((m as SessionMessageAssistant).id !== roundParent) {
              // V2 没有 parentID 概念；停止聚合第一条不匹配即终止（保守策略：每回合 1 个 step）
              break
            }
            dist.stepCount++
            const mc = (m as SessionMessageAssistant).cost
            if (lastCost === undefined && typeof mc === "number" && Number.isFinite(mc)) lastCost = mc
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

  const balanceDetails = createMemo(() => balanceState().data?.find((entry) => entry.details)?.details ?? [])

  // Persist the last valid distribution so that data() can fall back
  // to it while the V2 session data is re-hydrating after a view switch.
  createEffect(() => {
    const d = data()
    if (d.hasDistData) {
      setLastDist({ ...d.dist })
      setLastHasDist(true)
      // Also persist across component remounts (view switches)
      try { void props.updateStorage((s) => { s.distSnapshot = { ...d.dist } }) } catch {}
    }
  })

  // ── token distribution reactivity bump ──
  const [partVersion, setPartVersion] = createSignal(0)

  // Persist fold state to V2 storage store
  const persistFold = (key: FoldKey, val: boolean) => {
    try { void props.updateStorage((d) => { d[key] = val }) } catch {}
  }

  onMount(() => {
    // Reset panelWidth on (re)mount so the layout uses a clean
    // default until onSizeChange measures the live box dimensions.
    setPanelWidth(DEFAULT_PANEL_WIDTH)

    // Restore fold state and section visibility from the reactive store
    const s = props.storage
    setOpen(Boolean(s.open))
    setDetailOpen(s.detail !== false)
    setModelOpen(s.model !== false)
    setDistOpen(Boolean(s.dist))
    setSkillsOpen(s.skills !== false)
    setBalanceOpen(Boolean(s.balanceOpen))

    // Restore user config (currency, rate, balance provider, etc.)
    if (typeof s.currency === "string" && s.currency) setCurrencySymbol(s.currency)
    if (typeof s.rate === "number" && s.rate > 0) setExchangeRate(s.rate)
    if (typeof s.balanceCurrency === "string" && s.balanceCurrency) setBalanceCurrency(s.balanceCurrency)
    if (typeof s.balanceProvider === "string" && balanceProviders.some((p) => p.id === s.balanceProvider)) {
      setBalanceProviderId(s.balanceProvider)
      setBalanceUnsupported(false)
    }
    if (typeof s.balanceAuto === "boolean") setAutoBalance(s.balanceAuto)
    setSectionDetail(s.sectionDetail !== false)
    setSectionModel(s.sectionModel !== false)
    setSectionDist(s.sectionDist !== false)
    setSectionSkills(s.sectionSkills !== false)
    setSectionBalance(s.sectionBalance !== false)
    setBorderVisible(s.border !== false)

    // Restore distribution snapshot so the token distribution block
    // doesn't blank out while session data re-hydrates.
    if (s.distSnapshot) {
      setLastDist(s.distSnapshot)
      setLastHasDist(true)
    }

    // Re-measure panel width after config signals have settled
    if (boxEl && typeof boxEl.width === "number" && boxEl.width > 0) {
      setPanelWidth(Math.max(MIN_PANEL_WIDTH, boxEl.width))
    }

    // 恢复的 provider 可能与默认值不同，强制重新查询
    props.signals.setBalanceRefresh(props.signals.balanceRefresh() + 1)

    // Debounce partVersion updates so that event bursts during session
    // switching / streaming don't cause data() to re-compute on every
    // single event (up to hundreds per second on Linux single-thread).
    let partTimer: ReturnType<typeof setTimeout> | undefined
    const bumpPartVersion = () => {
      clearTimeout(partTimer)
      partTimer = setTimeout(() => setPartVersion((v) => v + 1), 100)
    }
    // V2 没有与 V1 `message.part.updated` 完全等价的事件（`session.message.content.updated`
    // 和 `session.usage.recorded` 属于 durable 事件流，不在 V2Event 运行时事件列表中）。
    // 用 `session.usage.updated` 触发即时刷新，`session.tool.success` / `session.tool.failed`
    // 触发分布刷新，`session.idle` 兜底完整重算。
    const unsubUsage = props.context.data.on("session.usage.updated", () => { bumpPartVersion(); setRefreshTick(v => v + 1) })
    const unsubTool  = props.context.data.on("session.tool.success", () => { bumpPartVersion(); setRefreshTick(v => v + 1) })
    const unsubErr   = props.context.data.on("session.tool.failed", () => { bumpPartVersion(); setRefreshTick(v => v + 1) })
    const unsubIdle  = props.context.data.on("session.idle", () => { setRefreshTick(v => v + 1) })
    setRefreshTick(v => v + 1)
    onCleanup(() => { clearTimeout(partTimer); unsubUsage(); unsubTool(); unsubErr(); unsubIdle() })
  })

  // ── colours ──
  // Pull from the V2 ResolvedTheme, auto-desaturate if too punchy,
  // fall back to Morandi when a key is missing from the theme.
  const pal = createMemo(() => {
    const t = props.theme
    // V2 theme tokens (RGBA objects {r, g, b, a}).  Some are nested deeper
    // than V1's flat layout — fall back through sensible chains and to
    // Morandi defaults when the theme omits a token.
    const primaryColor = t.hue?.accent?.[500] ?? t.hue?.blue?.[500]
    const sat = (raw: unknown, fb: string) => desaturateTo(raw, MAX_SAT, fb)
    return {
      primary:   sat(primaryColor,           FALLBACK.primary),
      text:      sat(t.text?.default,        FALLBACK.text),
      muted:     sat(t.text?.subdued,        FALLBACK.muted),
      success:   sat(t.text?.feedback?.success?.default, FALLBACK.success),
      warning:   sat(t.text?.feedback?.warning?.default, FALLBACK.warning),
      error:     sat(t.text?.feedback?.error?.default,   FALLBACK.error),
      border:    sat(t.border?.default,      FALLBACK.border),
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

  const balanceHeader = () => {
    const arrow = balanceDetails().length > 0 ? (balanceOpen() ? "\u25bc " : "\u25b6 ") : ""
    const title = t("secBalance")
    const summary = balanceState().data ? formatBalanceText(balanceState().data!, balanceCurrency(), exchangeRate()) : ""
    const gauge = panelWidth() - gutter()
    const dividerLength = Math.max(1, gauge - visualWidth(arrow + title) - visualWidth(summary) - 1)
    return { arrow, title, summary, divider: sep().slice(0, dividerLength) }
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
                <Show when={balanceDetails().length > 0}>
                  <text fg={pal().text} onMouseUp={() => {
                    const next = !balanceOpen()
                    setBalanceOpen(next)
                    persistFold("balanceOpen", next)
                  }}>
                    <span style={{ fg: pal().muted }}>{balanceHeader().arrow}</span>
                    <span style={{ fg: pal().primary }}><b>{balanceHeader().title}</b></span>
                    <span style={{ fg: pal().muted }}>{balanceHeader().divider}</span>
                    <span>{" " + balanceHeader().summary}</span>
                  </text>
                  <Show when={balanceOpen()}>
                    {balanceDetails().map((detail) => (
                      <text fg={pal().muted}>
                        {justify(formatBalanceDetailLabel(detail) + ":", formatBalanceDetailValue(detail))}
                      </text>
                    ))}
                  </Show>
                </Show>
                <Show when={balanceDetails().length === 0}>
                  <text fg={pal().muted}>{sep()}</text>
                  <text fg={pal().text}>
                    {justify(t("balTotal"), formatBalanceText(balanceState().data!, balanceCurrency(), exchangeRate()))}
                  </text>
                </Show>
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
 * 路径截断的固定开销（列数）：仅宿主布局常量，不含任何内容宽度——
 * 统计宽度、宿主 usage、commands 快捷键均为运行时动态计算。
 * - marginLeft=1 + space-between 余量 ≈ 2 列
 */
const PATH_CHROME = 2
/**
 * 路径可用宽度低于此列数时整体隐藏（极窄终端下路径信息价值太低，
 * 残留的 "E:\Work…" 反而挤压右侧统计与 commands，直接让位更干净）。
 */
const HIDE_PATH_BELOW = 14

/**
 * 从宿主 keymap 动态读取命令的快捷键显示文本（V2: context.keymap.shortcuts）。
 */
function keyShortcut(context: TuiPluginContext, command: string, fallback: string): string {
  try {
    const list = context.keymap.shortcuts(command)
    return list.length > 0 ? list.join(", ") : fallback
  } catch {
    return fallback
  }
}

/**
 * 输入框 hint 行（prompt.footer.status slot 的内容）：单行显示 路径 · 命中率 · 余额 · Tokens。
 * V2 中插件不再替换宿主 Prompt，而是注入到这个 footer 槽位。
 */
function BottomStatusBar(props: {
  context: TuiPluginContext
  signals: PanelSignals
  storage: SettingsStore
  sessionId: string
}): JSX.Element {
  const t = createT(() => props.signals.langCode())

  const sid = props.sessionId

  // ── 命中率（单条口径：最后一条有 token 的 assistant 消息）+ token 汇总 ──
  const stats = createMemo(() => {
    const id = sid
    if (!id) return null
    const msgs = props.context.data.session.message.list(id) ?? []
    const session = props.context.data.session.get(id)
    let input = session?.tokens?.input ?? 0
    let read = session?.tokens?.cache?.read ?? 0
    let write = session?.tokens?.cache?.write ?? 0
    // 旧 SDK 无 session 聚合字段 → 遍历消息累加（与侧边栏 fallback 一致）
    if (session?.tokens == null) {
      for (const m of msgs) {
        if (m.type !== "assistant") continue
        const tk = (m as SessionMessageAssistant).tokens
        if (!tk) continue
        input += num(tk.input)
        read += num(tk.cache?.read)
        write += num(tk.cache?.write)
      }
    }
    // 从后往前取最后两条有 token 数据的 assistant 消息 → 单条命中率 + 趋势
    let hitRate = -1, prevHitRate = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.type !== "assistant") continue
      const tk = (m as SessionMessageAssistant).tokens
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

  // 余额查询状态为共享信号（PanelSignals.balanceState），由 setup() 统一轮询

  // 自动切换 provider（跟随当前会话模型；幂等，与侧边栏共享信号）
  createEffect(() => {
    if (!props.signals.autoBalance()) return
    const id = sid
    if (!id) return
    const msgs = props.context.data.session.message.list(id) ?? []
    let pid = ""
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.type === "assistant" && (m as SessionMessageAssistant).model?.providerID) { pid = (m as SessionMessageAssistant).model!.providerID; break }
    }
    if (!pid) {
      try { pid = props.context.data.session.get(id)?.model?.providerID ?? "" } catch {}
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
    const t = props.context.theme
    const sat = (raw: unknown, fb: string) => desaturateTo(raw, MAX_SAT, fb)
    return {
      text:    sat(t.text?.default,                                 FALLBACK.text),
      muted:   sat(t.text?.subdued,                                 FALLBACK.muted),
      success: sat(t.text?.feedback?.success?.default,              FALLBACK.success),
      warning: sat(t.text?.feedback?.warning?.default,              FALLBACK.warning),
      error:   sat(t.text?.feedback?.error?.default,                FALLBACK.error),
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
    try { return props.context.location?.directory ?? "" } catch { return "" }
  })

  // 终端宽度信号：初始读取渲染器，窗口 resize 时更新（宿主不约束 hint 行宽度，
  // 路径截断必须基于终端宽度手动计算）。
  interface ResizeEmitter {
    on(event: "resize", cb: () => void): unknown
    off(event: "resize", cb: () => void): unknown
  }
  const [termW, setTermW] = createSignal((props.context.renderer as unknown as { terminalWidth?: number }).terminalWidth ?? 0)
  createEffect(() => {
    const r = props.context.renderer as unknown as ResizeEmitter
    if (typeof r.on !== "function" || typeof r.off !== "function") return
    const onResize = () => setTermW((props.context.renderer as unknown as { terminalWidth?: number }).terminalWidth ?? termW())
    r.on("resize", onResize)
    onCleanup(() => r.off("resize", onResize))
  })
  // 轮询兜底：事件通道若在插件环境不可用，定期同步终端宽度
  createEffect(() => {
    const timer = setInterval(() => setTermW((props.context.renderer as unknown as { terminalWidth?: number }).terminalWidth ?? termW()), 500)
    onCleanup(() => clearInterval(timer))
  })

  // 统计部分分段（单一数据源）：量宽拼接 text，渲染逐段着色，避免双源漂移
  const statsSegs = createMemo<{ text: string; color: string | undefined }[]>(() => {
    const s = stats()
    const hr = s && s.hitRate >= 0 ? (Math.floor(s.hitRate * 10) / 10).toFixed(1) + "%" : "--"
    const segs: { text: string; color: string | undefined }[] = [
      { text: t("barHit") + " ", color: pal().muted },
      { text: hr, color: hitColor() },
    ]
    const tr = trend()
    if (tr !== null) {
      segs.push({ text: " " + (tr > 0 ? "\u2191" : "\u2193") + Math.abs(tr).toFixed(1) + "%", color: tr > 0 ? pal().success : pal().error })
    }
    segs.push({ text: " \u00b7 " + t("barTok") + " ", color: pal().muted })
    segs.push({ text: s ? fmtCompact(s.input + s.read + s.write) : "--", color: pal().text })
    if (!props.signals.balanceUnsupported()) {
      segs.push({ text: " \u00b7 " + t("barBal") + " ", color: pal().muted })
      segs.push({ text: balanceText(), color: pal().text })
    }
    segs.push({ text: " \u00b7 ", color: pal().muted })
    return segs
  })
  const statsW = createMemo(() => {
    let w = 0
    for (const sg of statsSegs()) w += visualWidth(sg.text)
    return w
  })

  // 宿主右侧 usage 文本复刻：最后一条 output>0 的 assistant 消息 → tokens 合计 + context 百分比 + 累计费用
  const sessionCost = createMemo(() => {
    try { return num(props.context.data.session.get(sid)?.cost) } catch { return 0 }
  })
  const usageText = createMemo(() => {
    const id = sid
    if (!id) return ""
    const msgs = props.context.data.session.message.list(id) ?? []
    let last: SessionMessageAssistant | undefined
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.type !== "assistant") continue
      const tk = (m as SessionMessageAssistant).tokens
      if (tk && num(tk.output) > 0) { last = m as SessionMessageAssistant; break }
    }
    if (!last) return ""
    const tk = last.tokens
    if (!tk) return ""
    const tokens = num(tk.input) + num(tk.output) + num(tk.reasoning) + num(tk.cache?.read) + num(tk.cache?.write)
    if (tokens <= 0) return ""
    // V2 没有 state.provider 的便捷访问；context percentage 是 nice-to-have，
    // 暂时省略 pct 字段（context limit 信息属于 catalog，不在每个 message 上）
    const context = fmtCompact(tokens)
    const cost = sessionCost()
    return cost > 0 ? context + " \u00b7 " + fmtCost(cost) : context
  })

  // 宿主右侧文本：usage（有数据）或 "快捷键 agents"（无数据）+ commands
  const rightText = createMemo(() => {
    const cmds = keyShortcut(props.context, "command.palette.show", "ctrl+p") + " commands"
    const u = usageText()
    if (u) return u + " " + cmds
    return keyShortcut(props.context, "agent.cycle", "") + " agents " + cmds
  })
  const rightW = createMemo(() => visualWidth(rightText()))

  // 输入框实际宽度 = 终端宽度 - 侧边栏(可见时 42) - 边距 4
  const inputW = createMemo(() => termW() - (props.signals.sidebarVisible() ? 42 : 0) - 4)

  // 路径可用宽度 = 输入框宽度 - 统计宽度(精确) - 宿主右侧宽度(动态) - 布局开销
  const dirDisplay = createMemo(() => {
    const avail = inputW() - statsW() - rightW() - PATH_CHROME
    if (avail < HIDE_PATH_BELOW) return ""
    return truncateVisual(directory(), avail)
  })
  const dirFallback = createMemo(() => {
    const avail = inputW() - rightW() - PATH_CHROME
    if (avail < HIDE_PATH_BELOW) return ""
    return truncateVisual(directory(), avail)
  })

  // 恢复显隐偏好（默认显示）；关闭时回退为仅显示路径，与宿主默认 hint 行一致
  onMount(() => {
    props.signals.setSectionBottom(props.storage.sectionBottom !== false)
  })

  return (
    <Show
      when={props.signals.sectionBottom()}
      fallback={<text fg={pal().muted}>{dirFallback()}</text>}
    >
      <box marginLeft={1} flexGrow={1} flexShrink={0} flexDirection="row" justifyContent="space-between">
        <text fg={pal().muted}>{dirDisplay()}</text>
        <box flexDirection="row">
        <text>
          <For each={statsSegs()}>
            {(sg) => <span style={{ fg: sg.color }}>{sg.text}</span>}
          </For>
        </text>
        </box>
      </box>
    </Show>
  )
}

function createSidebarSlot(
  context: TuiPluginContext,
  storage: SettingsStore,
  updateStorage: (mut: (draft: SettingsStore) => void) => Promise<void>,
  signals: PanelSignals,
) {
  let lastSlotSid = ""
  return {
    append: "sidebar.content",
    render: (input: { sessionID: string }): JSX.Element => {
      // ── auto-clear override when the user navigates to a different main session ──
      if (input.sessionID !== lastSlotSid) {
        lastSlotSid = input.sessionID
        if (signals.overrideSessionId()) {
          signals.setOverrideSessionId(undefined)
          void updateStorage((d) => { d.session = "" })
        }
      }
      return (
        <TokenCachePanel
          theme={context.theme}
          context={context}
          storage={storage}
          updateStorage={updateStorage}
          sessionId={input.sessionID}
          signals={signals}
        />
      )
    },
  } as const
}

export default Plugin.define({
  id: "opencode-visual-cache",
  setup(context) {
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
    // 侧边栏可见性（由 TokenCachePanel 挂载状态驱动）：可见时宿主输入框宽度 = 终端宽 - 42 - 4
    const [sidebarVisible, setSidebarVisible] = createSignal(false)

    // ── V2 reactive settings store (replaces all api.kv.* calls) ──
    const [settings, updateSettings] = context.storage.store<SettingsStore>("settings", {
      initial: makeDefaultSettings(),
    })

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
      sidebarVisible, setSidebarVisible,
    }

    // ── 语言偏好恢复（V2 存储同步初始化，restore 在 setup 时直接读取）──
    const savedLang = settings.lang
    if (savedLang && LANG_META.some((m) => m.code === savedLang)) setLangCode(savedLang)
    // 镜像初始值到 React 式的 signals，让面板立即响应
    if (typeof settings.currency === "string" && settings.currency) setCurrencySymbol(settings.currency)
    if (typeof settings.rate === "number" && settings.rate > 0) setExchangeRate(settings.rate)
    if (typeof settings.balanceCurrency === "string" && settings.balanceCurrency) setBalanceCurrency(settings.balanceCurrency)
    if (typeof settings.balanceProvider === "string" && settings.balanceProvider && balanceProviders.some((p) => p.id === settings.balanceProvider)) {
      setBalanceProviderId(settings.balanceProvider)
      setBalanceUnsupported(false)
    }
    if (typeof settings.balanceAuto === "boolean") setAutoBalance(settings.balanceAuto)
    if (typeof settings.session === "string" && settings.session) setOverrideSessionId(settings.session)
    setBorderVisible(settings.border !== false)

    // ── 注册侧边栏 slot ──
    context.ui.slot(createSidebarSlot(context, settings, updateSettings, signals))

    // ── 输入框 hint 行（prompt.footer.status slot）：仅注入底部栏内容。
    //    V2 不允许插件替换整个 Prompt——宿主保持原样，我们仅追加到 footer.status。 ──
    context.ui.slot({
      append: "prompt.footer.status",
      render: (input: { sessionID?: string }): JSX.Element => (
        <BottomStatusBar
          context={context}
          signals={signals}
          storage={settings}
          sessionId={input.sessionID ?? ""}
        />
      ),
    })

    const pollBalance = async () => {
      const provider = getBalanceProvider(balanceProviderId())
      // 手动配置的 key 优先；缺失时自动复用 OpenCode 已认证的 key（仅 OpenAI OAuth）
      const key = settings.balanceKeys[provider.id] || findOpencodeKey(context, provider)
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

    // 定时轮询（5 分钟）
    const balanceTimer = setInterval(pollBalance, BALANCE_POLL_MS)

    /** 菜单中 provider 选项标题：标注 key 来源（手动配置 / OpenCode 自动复用 / 未配置）。 */
    const providerOptionTitle = (p: BalanceProvider, current?: string) => {
      const t = createT(() => langCode())
      const hasManual = !!settings.balanceKeys[p.id]
      const hasAuto = !hasManual && !!findOpencodeKey(context, p)
      const mark = hasManual
        ? t("keyUser")
        : hasAuto
          ? t("keyOpenCode")
          : t("keyNotSet")
      return p.name + mark + (current && p.id === current ? " *" : "")
    }

    /** 弹出指定 provider 的 API Key 输入框（脱敏预填；空清除 / 含 * 保留原 key / 新 key 实时刷新）。 */
    const promptBalanceKey = async (provider: BalanceProvider) => {
      const t = createT(() => langCode())
      const current = settings.balanceKeys[provider.id] ?? ""
      const masked = maskKey(current)
      const val = await context.ui.dialog.prompt({
        title: provider.name,
        description: t("balKeyPrompt", { p: provider.name }),
        placeholder: provider.keyPlaceholder ?? "sk-...",
        value: masked,
      })
      if (val === undefined || val === null) return // user cancelled
      const input = val.trim()
      let key: string
      if (input === "") {
        key = ""
      } else if (input.includes("*")) {
        key = current
      } else {
        key = input
      }
      await updateSettings((d) => { d.balanceKeys[provider.id] = key })
      setBalanceRefresh(v => v + 1)
      if (key) {
        context.ui.toast.show({ message: t("keySaved") })
      } else {
        context.ui.toast.show({ message: t("keyCleared") })
      }
    }

    // ── 注册 slash 命令（V2 TUI 插件 API：context.keymap.layer + commands[]） ──
    // 每个 slash command 也是一个 KeymapCommand，通过 layer 注册。
    // layer 是响应式的；返回的清理函数用于卸载插件时注销所有命令。
    context.keymap.layer(() => {
      const commands: Array<{
        id: string
        title: string
        description?: string
        group?: string
        slash: { name: string; aliases?: string[] }
        run: (input?: string) => Promise<void> | void
      }> = [
        {
          id: "cache-currency",
          title: "Cache: Set Currency",
          description: "Change the currency unit for cost display",
          group: "Cache",
          slash: { name: "cache-currency" },
          run: async () => {
            const opt = await context.ui.dialog.select<string>({
              title: "Select Currency",
              options: Object.entries(CURRENCIES).map(([code, sym]) => ({
                title: `${code}  (${sym})`,
                value: code,
              })),
            })
            if (opt === undefined || opt === null) return
            const t = createT(() => langCode())
            const sym = CURRENCIES[opt] ?? "$"
            const defRate = DEFAULT_RATES[opt] ?? 1
            await updateSettings((d) => {
              d.currency = sym
              d.rate = defRate
              d.balanceCurrency = opt
            })
            signals.setBalanceCurrency(opt)
            signals.setCurrencySymbol(sym)
            signals.setExchangeRate(defRate)
            context.ui.toast.show({ message: t("currencySet", { v: opt, s: sym, r: defRate }) })
          },
        },
        {
          id: "cache-rate",
          title: "Cache: Set Exchange Rate",
          description: "Set the exchange rate multiplier for the selected currency",
          group: "Cache",
          slash: { name: "cache-rate" },
          run: async () => {
            const val = await context.ui.dialog.prompt({
              title: "Exchange Rate",
              description: "Enter the exchange rate from USD to your currency (e.g. 7.2 for CNY)",
              placeholder: "1.0",
              value: String(settings.rate),
            })
            if (val === undefined || val === null) return
            const t = createT(() => langCode())
            const n = parseFloat(val)
            if (n > 0) {
              await updateSettings((d) => { d.rate = n })
              signals.setExchangeRate(n)
              context.ui.toast.show({ message: t("rateSet", { r: n }) })
            }
          },
        },
        {
          id: "cache-section",
          title: "Cache: Toggle Section",
          description: "Show or hide a sidebar section",
          group: "Cache",
          slash: { name: "cache-section" },
          run: async () => {
            const t = createT(() => langCode())
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
            const opt = await context.ui.dialog.select<string>({
              title: t("secToggle"),
              options: [
                { title: optTitle(labels.detail,  settings.sectionDetail !== false),  value: "detail" },
                { title: optTitle(labels.model,   settings.sectionModel !== false),   value: "model" },
                { title: optTitle(labels.dist,    settings.sectionDist !== false),    value: "dist" },
                { title: optTitle(labels.skills,  settings.sectionSkills !== false),  value: "skills" },
                { title: optTitle(labels.balance, settings.sectionBalance !== false), value: "balance" },
                { title: optTitle(labels.bottom,  settings.sectionBottom !== false),  value: "bottom" },
                { title: optTitle(labels.border,  settings.border !== false),         value: "border" },
              ],
            })
            if (opt === undefined || opt === null) return
            if (opt === "border") {
              const cur = settings.border !== false
              await updateSettings((d) => { d.border = !cur })
              signals.setBorderVisible(!cur)
              context.ui.toast.show({ message: !cur ? t("borderShown") : t("borderHidden") })
            } else {
              const sectionKey = `section${opt.charAt(0).toUpperCase()}${opt.slice(1)}` as keyof SettingsStore
              const cur = settings[sectionKey] !== false
              await updateSettings((d) => { (d[sectionKey] as unknown as boolean) = !cur })
              if (opt === "detail")  signals.setSectionDetail(!cur)
              if (opt === "model")   signals.setSectionModel(!cur)
              if (opt === "dist")    signals.setSectionDist(!cur)
              if (opt === "skills")  signals.setSectionSkills(!cur)
              if (opt === "balance") signals.setSectionBalance(!cur)
              if (opt === "bottom")  signals.setSectionBottom(!cur)
              const name = labels[opt] ?? opt
              context.ui.toast.show({ message: t(!cur ? "sectionShown" : "sectionHidden", { s: name }) })
            }
          },
        },
        {
          id: "cache-config",
          title: "Cache: Show Config",
          description: "Display the current plugin configuration",
          group: "Cache",
          slash: { name: "cache-config" },
          run: async () => {
            const t = createT(() => langCode())
            const on = (v: boolean) => v ? "ON" : "OFF"
            context.ui.toast.show({
              title: t("panelConfigTitle"),
              message: t("panelConfigMsg", {
                c: settings.currency, r: settings.rate,
                d: on(settings.sectionDetail !== false), m: on(settings.sectionModel !== false),
                t: on(settings.sectionDist !== false), k: on(settings.sectionSkills !== false),
                b: on(settings.sectionBalance !== false), f: on(settings.sectionBottom !== false),
              }),
              duration: 8000,
            })
          },
        },
        {
          id: "cache-lang",
          title: "Cache: Switch Language",
          description: "Switch between Chinese and English display",
          group: "Cache",
          slash: { name: "cache-lang" },
          run: async () => {
            const t = createT(() => langCode())
            const cur = langCode()
            const opt = await context.ui.dialog.select<LangCode>({
              title: t("langTitle"),
              options: LANG_META.map((m) => ({
                title: `${visualPadEnd(m.label, 9)}${cur === m.code ? "\u2713" : ""}`,
                value: m.code,
              })),
            })
            if (opt === undefined || opt === null) return
            await updateSettings((d) => { d.lang = opt })
            setLangCode(opt)
            context.ui.toast.show({ message: t("langSwitched") })
          },
        },
        {
          id: "cache-balance",
          title: "Cache: Switch Balance Provider",
          description: "切换余额提供商 / 自动切换当前会话提供商 | Switch balance provider / auto-switch session provider",
          group: "Cache",
          slash: { name: "cache-balance" },
          run: async () => {
            const t = createT(() => langCode())
            const current = signals.balanceProviderId()
            const auto = signals.autoBalance()
            const autoLabel = `${t("autoSwitchOpt")} [${auto ? "ON" : "OFF"}]`
            const opt = await context.ui.dialog.select<string>({
              title: t("balProvTitle"),
              options: [
                { title: autoLabel, value: "__auto__" },
                ...balanceProviders.map((p) => ({
                  title: providerOptionTitle(p, current),
                  value: p.id,
                })),
              ],
            })
            if (opt === undefined || opt === null) return
            if (opt === "__auto__") {
              const next = !auto
              await updateSettings((d) => { d.balanceAuto = next })
              signals.setAutoBalance(next)
              context.ui.toast.show({ message: next ? t("autoSwitchOn") : t("autoSwitchOff") })
            } else {
              const provider = getBalanceProvider(opt)
              await updateSettings((d) => {
                d.balanceProvider = provider.id
                d.balanceAuto = false
              })
              signals.setBalanceProviderId(provider.id)
              signals.setAutoBalance(false)
              signals.setBalanceUnsupported(false)
              signals.setBalanceRefresh(signals.balanceRefresh() + 1)
              const hasKey = !!settings.balanceKeys[provider.id]
              if (!hasKey) {
                await promptBalanceKey(provider)
              } else {
                context.ui.toast.show({ message: t("providerManual", { p: provider.name }) })
              }
            }
          },
        },
        {
          id: "cache-balance-key",
          title: "Cache: Set Balance API Key",
          description: "Select a provider and set its API key for balance display",
          group: "Cache",
          slash: { name: "cache-balance-key" },
          run: async () => {
            const t = createT(() => langCode())
            const opt = await context.ui.dialog.select<string>({
              title: t("balSelectTitle"),
              options: balanceProviders.map((p) => ({
                title: providerOptionTitle(p),
                value: p.id,
              })),
            })
            if (opt === undefined || opt === null) return
            const provider = getBalanceProvider(opt)
            await updateSettings((d) => {
              d.balanceProvider = provider.id
              d.balanceAuto = false
            })
            signals.setBalanceProviderId(provider.id)
            signals.setAutoBalance(false)
            signals.setBalanceRefresh(signals.balanceRefresh() + 1)
            await promptBalanceKey(provider)
          },
        },
        {
          id: "cache-debug-skills",
          title: "Cache: Debug Skills Detection",
          description: "Dump all tool parts found in the current session for skill detection debugging",
          group: "Cache",
          slash: { name: "cache-debug-skills" },
          run: async () => {
            const t = createT(() => langCode())
            const route = context.ui.router.current()
            const sid = route.type === "session" ? route.sessionID : undefined
            if (!sid) {
              context.ui.toast.show({ message: t("runInSession"), variant: "warning" })
              return
            }
            const msgs = context.data.session.message.list(sid) ?? []
            const byTool: Record<string, number> = {}
            const skillParts: string[] = []
            for (const msg of msgs) {
              if (msg.type !== "assistant") continue
              const am = msg as SessionMessageAssistant
              for (const p of am.content ?? []) {
                if (p.type === "tool") {
                  const tp = p as SessionMessageAssistantTool
                  const toolName = String(tp.name ?? "?")
                  byTool[toolName] = (byTool[toolName] ?? 0) + 1
                  if (toolName === "skill") {
                    const st = tp.state as unknown as Record<string, unknown>
                    const meta = st?.metadata
                    skillParts.push(`state.metadata=${JSON.stringify(meta)} | state.title="${st?.title ?? ""}"`)
                  }
                }
              }
            }
            const summary = Object.entries(byTool).map(([k, v]) => `${k}: ${v}`).join(" | ")
            const extra = skillParts.length > 0
              ? "\n\nSkill parts:\n" + skillParts.join("\n")
              : "\n\n⚠ No skill tool parts found — AI may be reading SKILL.md instead. Try: 'Use the skill tool to load karpathy-guidelines'"
            context.ui.toast.show({
              title: `Tool Summary (${Object.keys(byTool).length} types)`,
              message: summary + extra,
              duration: 15000,
            })
          },
        },
        {
          id: "cache-session",
          title: "Cache: Sub-Agent Stats",
          description: "View token cache statistics for a sub-agent by session ID",
          group: "Cache",
          slash: { name: "cache-session" },
          run: async () => {
            const route = context.ui.router.current()
            const parentSid = route.type === "session" ? route.sessionID : ""
            const SUBAGENT_TOOLS = new Set(["task", "delegate", "call_omo_agent"])

            interface ChildEntry { title: string; value: string; description: string }
            const children: ChildEntry[] = []
            if (parentSid) {
              try {
                const msgs = context.data.session.message.list(parentSid) ?? []
                for (const msg of msgs) {
                  if (msg.type !== "assistant") continue
                  const am = msg as SessionMessageAssistant
                  for (const p of am.content ?? []) {
                    if (p.type !== "tool") continue
                    const tp = p as SessionMessageAssistantTool
                    const tool = String(tp.name ?? "")
                    if (!SUBAGENT_TOOLS.has(tool)) continue
                    const st = tp.state as unknown as Record<string, unknown> | undefined
                    const stMeta = st?.metadata as Record<string, unknown> | undefined
                    const subSid = stMeta?.session_id ?? stMeta?.sessionId
                    if (!subSid) continue
                    const sidStr = String(subSid)
                    const input = st?.input as Record<string, unknown> | undefined
                    const agent = String((tp as unknown as { subagent_type?: string }).subagent_type ?? input?.subagent_type ?? input?.category ?? tool)
                    const prompt = String(input?.prompt ?? "")
                    const desc = input?.description ? String(input.description) : ""
                    const title = desc || prompt.replace(/\n/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || agent
                    children.push({ title, value: sidStr, description: `${agent} · ${sidStr.slice(0, 24)}…` })
                  }
                }
              } catch { /* ignore */ }
            }

            // 去重
            const seen = new Set<string>()
            const unique = children.filter(c => { if (seen.has(c.value)) return false; seen.add(c.value); return true })

            const t = createT(() => langCode())
            if (unique.length > 0) {
              const currentSid = signals.overrideSessionId() ?? settings.session
              const options = unique.map((c, i) => ({
                title: `${i + 1}. ${c.title}`,
                value: c.value,
                description: c.description,
              }))
              const backValue = "__main__"
              const backTitle = `\u2500 ${t("backToMainTitle")}`
              options.unshift({ title: backTitle, value: backValue, description: "" })
              options.push({ title: backTitle, value: backValue, description: "" })
              const currentIdx = currentSid ? options.findIndex(o => o.value === currentSid) : -1
              const opt = await context.ui.dialog.select<string>({
                title: t("subSelectTitle"),
                options,
                current: currentIdx >= 0 ? options[currentIdx].value : undefined,
              })
              if (opt === undefined || opt === null) return
              if (opt === backValue) {
                signals.setOverrideSessionId(undefined)
                await updateSettings((d) => { d.session = "" })
                context.ui.toast.show({ message: t("backToMain") })
              } else {
                signals.setOverrideSessionId(opt)
                await updateSettings((d) => { d.session = opt })
                context.ui.toast.show({ message: t("subAgentSwitched", { s: opt.slice(0, 24) + "\u2026" }) })
              }
            } else {
              const val = await context.ui.dialog.prompt({
                title: signals.overrideSessionId() ? t("subSwitchTitle") : t("subViewTitle"),
                description: t("subNoFound"),
                placeholder: "ses_...",
                value: signals.overrideSessionId() ?? settings.session,
              })
              if (val === undefined || val === null) return
              const s = val.trim()
              if (s) {
                signals.setOverrideSessionId(s)
                await updateSettings((d) => { d.session = s })
                context.ui.toast.show({ message: t("subAgentSwitched", { s: s.slice(0, 24) + "\u2026" }) })
              }
            }
          },
        },
        {
          id: "cache-session-back",
          title: "Cache: Back to Main",
          description: "Return to main session stats",
          group: "Cache",
          slash: { name: "cache-session-back" },
          run: async () => {
            const t = createT(() => langCode())
            signals.setOverrideSessionId(undefined)
            await updateSettings((d) => { d.session = "" })
            context.ui.toast.show({ message: t("backToMain") })
          },
        },
      ]
      return {
        mode: "global",
        commands,
      }
    })

    // ── cleanup：返回的函数在插件卸载时由 OpenCode 调用 ──
    return () => {
      clearInterval(balanceTimer)
    }
  },
})
