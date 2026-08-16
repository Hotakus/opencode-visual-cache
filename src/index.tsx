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
  SequenceBindingLike,
} from "@opencode-ai/plugin/tui"
import type { UserMessage, AssistantMessage, Message } from "@opencode-ai/sdk"
import type {
  Part,
  TextPart,
  ToolPart,
  FilePart,
  ReasoningPart,
} from "@opencode-ai/sdk/v2"
import { createMemo, createSignal, createEffect, onMount, onCleanup, Show, For, untrack } from "solid-js"
import { PLUGIN_VERSION } from "./_version"
import { balanceProviders, getBalanceProvider, maskKey, matchBalanceProvider, type BalanceEntry, type BalanceProvider } from "./balance-providers"
import { LANG_META, createT, detectLang, type LangCode } from "./i18n"
import {
  MAX_SAT, FALLBACK, CURRENCIES, DEFAULT_RATES,
  charColumns, visualWidth, visualPadEnd, truncateVisual, progressBar,
  fmt, num, fmtCost, fmtCompact, formatBalanceAmount, formatBalanceText,
  balanceSymbol, convertBalance, estimateTokens,
  rgb, saturation, desaturateTo, dimColor,
  type TokenDist,
} from "./core"
import { TokenCachePanel } from "./panel/TokenCachePanel"
import type { PanelSignals, BalanceState } from "./panel/panel-api"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Bun / Node globals — available at runtime in the OpenCode TUI process
declare const process: { env: Record<string, string | undefined> } | undefined
// ── language ──────────────────────────────────────────────────────
// 语言初始化：环境变量 CACHE_TUI_LANG 覆盖 → 否则按系统 locale 自动检测。
// 用户通过 /cache-lang 设置的偏好会在 KV 就绪后优先覆盖（见 tui() 内恢复逻辑）。

const DEBUG_LANG = typeof process !== "undefined" ? process.env?.CACHE_TUI_LANG : undefined
const INIT_LANG: LangCode = DEBUG_LANG !== undefined && LANG_META.some((m) => m.code === DEBUG_LANG)
  ? (DEBUG_LANG as LangCode)
  : detectLang()

// ---------------------------------------------------------------------------
// Balance state
// ---------------------------------------------------------------------------


const BALANCE_POLL_MS = 5 * 60 * 1000 // 5 minutes

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

// ---------------------------------------------------------------------------
// Sidebar component
// ---------------------------------------------------------------------------

/** Signals shared between the TUI component and slash commands.
 *  Created in the `tui` function scope so they do not survive module reload —
 *  the component re-creates them on mount and restores user config from kv. */

const MIN_PANEL_WIDTH = 20
const DEFAULT_PANEL_WIDTH = 26

/** ── layout measurement constants (visual columns) ── */
const LABEL_GAP = 1        // label（如 "Hit"）后面的空格
const BAR_BRACKETS = 2     // "[" + "]" 包围进度条
const BAR_GAP = 1          // "]" 后面的空格
const PCT_FIXED_WIDTH = 5  // "XX.X%" 固定 5 字符宽度
const HEADER_PREFIX = 2    // 折叠态标题行：▶/▼ 图标 + 后面的空格
const UNIT_GAP = 1         // 计量单位前的空格（如 "tok"）




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
 * 从宿主 keymap 动态读取命令的快捷键显示文本（与宿主 Prompt 同源），
 * 取不到时回退到传入的默认文本。
 */
function keyShortcut(api: TuiPluginApi, command: string, fallback: string): string {
  try {
    const binds = api.tuiConfig.keybinds.get(command)
    const seq = binds?.map((b) => ({ key: b.key }))
    const s = api.keys.formatBindings(seq as unknown as SequenceBindingLike[])
    return s || fallback
  } catch {
    return fallback
  }
}

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

  // 终端宽度信号：初始读取渲染器，窗口 resize 时更新（宿主不约束 hint 行宽度，
  // 路径截断必须基于终端宽度手动计算）。
  // CliRenderer 继承的 EventEmitter 因项目未装 @types/node 类型不可见，
  // 用最小接口声明补齐 resize 事件的 on/off。
  interface ResizeEmitter {
    on(event: "resize", cb: () => void): unknown
    off(event: "resize", cb: () => void): unknown
  }
  const [termW, setTermW] = createSignal(props.api.renderer.terminalWidth)
  // resize 事件（主通道）；事件接口若在插件环境不可用则跳过，由轮询兜底
  createEffect(() => {
    const r = props.api.renderer as unknown as ResizeEmitter
    if (typeof r.on !== "function" || typeof r.off !== "function") return
    const onResize = () => setTermW(props.api.renderer.terminalWidth)
    r.on("resize", onResize)
    onCleanup(() => r.off("resize", onResize))
  })
  // 轮询兜底：事件通道若在插件环境不可用，定期同步终端宽度（值不变时不触发更新）
  createEffect(() => {
    const timer = setInterval(() => setTermW(props.api.renderer.terminalWidth), 500)
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

  // 宿主右侧 usage 文本复刻（1.18.16 Prompt 口径）：
  // 最后一条 output>0 的 assistant 消息 → tokens 合计格式化 + 模型 context limit 百分比 + session 累计费用
  const sessionCost = createMemo(() => {
    try { return num(props.api.state.session.get(sid)?.cost) } catch { return 0 }
  })
  const usageText = createMemo(() => {
    const id = sid
    if (!id) return ""
    const msgs = props.api.state.session.messages(id) as Message[]
    let last: AssistantMessage | undefined
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role !== "assistant") continue
      const tk = (m as AssistantMessage).tokens
      if (tk && num(tk.output) > 0) { last = m as AssistantMessage; break }
    }
    if (!last) return ""
    const tk = last.tokens
    if (!tk) return ""
    const tokens = num(tk.input) + num(tk.output) + num(tk.reasoning) + num(tk.cache?.read) + num(tk.cache?.write)
    if (tokens <= 0) return ""
    let pct = ""
    try {
      const p = props.api.state.provider.find((x) => x.id === last.providerID)
      const limit = p?.models?.[last.modelID]?.limit?.context
      if (typeof limit === "number" && limit > 0) pct = ` (${Math.round((tokens / limit) * 100)}%)`
    } catch {}
    const context = fmtCompact(tokens) + pct
    const cost = sessionCost()
    return cost > 0 ? context + " \u00b7 " + fmtCost(cost) : context
  })

  // 宿主 1513 行右侧文本：usage（有数据）或 "快捷键 agents"（无数据）+ commands，
  // 快捷键从宿主 keymap 动态读取
  const rightText = createMemo(() => {
    const cmds = keyShortcut(props.api, "command.palette.show", "ctrl+p") + " commands"
    const u = usageText()
    if (u) return u + " " + cmds
    return keyShortcut(props.api, "agent.cycle", "") + " agents " + cmds
  })
  const rightW = createMemo(() => visualWidth(rightText()))

  // 输入框实际宽度 = 终端宽度 - 侧边栏(可见时 42) - 边距 4
  // （与宿主 session 布局 contentWidth 口径一致；侧边栏可见性由本面板挂载状态驱动）
  const inputW = createMemo(() => termW() - (props.signals.sidebarVisible() ? 42 : 0) - 4)

  // 路径可用宽度 = 输入框宽度 - 统计宽度(精确) - 宿主右侧宽度(动态) - 布局开销；
  // 低于 HIDE_PATH_BELOW 时整体隐藏路径（宽度归零），把空间让给统计与 commands
  const dirDisplay = createMemo(() => {
    const avail = inputW() - statsW() - rightW() - PATH_CHROME
    if (avail < HIDE_PATH_BELOW) return ""
    return truncateVisual(directory(), avail)
  })
  // 状态栏关闭（仅路径）时同样在极窄条件下隐藏路径
  const dirFallback = createMemo(() => {
    const avail = inputW() - rightW() - PATH_CHROME
    if (avail < HIDE_PATH_BELOW) return ""
    return truncateVisual(directory(), avail)
  })

  // 恢复显隐偏好（默认显示）；关闭时回退为仅显示路径，与宿主默认 hint 行一致
  onMount(() => {
    try {
      const v = props.api.kv.get<boolean>(`${KV_PREFIX}.section.bottom`, true)
      props.signals.setSectionBottom(v !== false)
    } catch {}
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
  // 侧边栏可见性（由 TokenCachePanel 挂载状态驱动）：可见时宿主输入框宽度 = 终端宽 - 42 - 4
  const [sidebarVisible, setSidebarVisible] = createSignal(false)

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
