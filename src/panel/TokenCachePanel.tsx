/** @jsxImportSource @opentui/solid */

import type { JSX } from "@opentui/solid"
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { UserMessage, AssistantMessage, Message } from "@opencode-ai/sdk"
import type { Part, TextPart, ToolPart, FilePart, ReasoningPart } from "@opencode-ai/sdk/v2"
import { createMemo, createSignal, createEffect, onMount, onCleanup, Show, For, untrack } from "solid-js"
import { balanceProviders, getBalanceProvider, maskKey, matchBalanceProvider, type BalanceEntry, type BalanceProvider } from "../balance-providers"
import { createT, type LangCode } from "../i18n"
import { MAX_SAT, FALLBACK, desaturateTo, dimColor, fmt, fmtCost, num, estimateTokens, progressBar, visualWidth, visualPadEnd, truncateVisual, formatBalanceText, type TokenDist } from "../core"
import { PLUGIN_VERSION } from "../_version"
import type { PanelApi, PanelSignals } from "./panel-api"

const MIN_PANEL_WIDTH = 20
const DEFAULT_PANEL_WIDTH = 26

/** ── layout measurement constants (visual columns) ── */
const LABEL_GAP = 1        // label（如 "Hit"）后面的空格
const BAR_BRACKETS = 2     // "[" + "]" 包围进度条
const BAR_GAP = 1          // "]" 后面的空格
const PCT_FIXED_WIDTH = 5  // "XX.X%" 固定 5 字符宽度
const HEADER_PREFIX = 2    // 折叠态标题行：▼/▶ 图标 + 图标后空格
const UNIT_GAP = 1         // 数值与单位前的空格（如 " tok"）

export function TokenCachePanel(props: {
  theme: TuiThemeCurrent
  api: PanelApi
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
