/** @jsxImportSource @opentui/solid */

import { createSignal, createEffect, onMount, onCleanup, untrack } from "solid-js"
import type { Context, PluginModule } from "./types"
import { createPanelApi } from "./v2-panel-api"
import { TokenCachePanel } from "../panel/TokenCachePanel"
import type { BalanceState, PanelApi, PanelSignals } from "../panel/panel-api"
import { StatusView } from "./status"
import { mapTheme } from "./theme"
import { makeCommands, findOpencodeKeyV2 } from "./commands"
import { getBalanceProvider } from "../balance-providers"
import { LANG_META, detectLang, type LangCode } from "../i18n"

const KV_PREFIX = "cache_panel"
const BALANCE_POLL_MS = 5 * 60 * 1000 // 5 minutes（对齐 V1）

// 环境变量覆盖 + 自动检测（对齐 V1：CACHE_TUI_LANG 优先，其次系统 locale）
declare const process: { env: Record<string, string | undefined> } | undefined
const DEBUG_LANG = typeof process !== "undefined" ? process.env?.CACHE_TUI_LANG : undefined
const INIT_LANG: LangCode = DEBUG_LANG !== undefined && LANG_META.some((m) => m.code === DEBUG_LANG)
  ? (DEBUG_LANG as LangCode)
  : detectLang()

/** V2 侧创建面板信号（实验：默认值；偏好持久化经 PanelApi.kv → storage.store）。
 *  返回 PanelSignals + setBalanceState：余额轮询由 PluginRoot 驱动（V1 同构）。 */
function createPanelSignals(): PanelSignals & { setBalanceState: (v: BalanceState) => void } {
  const [currencySymbol, setCurrencySymbol] = createSignal("$")
  const [exchangeRate, setExchangeRate] = createSignal(1)
  const [langCode, setLangCode] = createSignal(INIT_LANG)
  const [sectionDetail, setSectionDetail] = createSignal(true)
  const [sectionModel, setSectionModel] = createSignal(true)
  const [sectionDist, setSectionDist] = createSignal(true)
  const [sectionSkills, setSectionSkills] = createSignal(true)
  const [sectionBalance, setSectionBalance] = createSignal(true)
  const [sectionBottom, setSectionBottom] = createSignal(true)
  const [balanceRefresh, setBalanceRefresh] = createSignal(0)
  const [balanceProviderId, setBalanceProviderId] = createSignal("")
  const [autoBalance, setAutoBalance] = createSignal(true)
  const [balanceUnsupported, setBalanceUnsupported] = createSignal(false)
  const [balanceState, setBalanceState] = createSignal<BalanceState>({ status: "idle", data: null, lastFetch: 0 })
  const [balanceCurrency, setBalanceCurrency] = createSignal("")
  const [borderVisible, setBorderVisible] = createSignal(true)
  const [overrideSessionId, setOverrideSessionId] = createSignal<string | undefined>(undefined)
  const [sidebarVisible, setSidebarVisible] = createSignal(true)
  return {
    currencySymbol, setCurrencySymbol,
    exchangeRate, setExchangeRate,
    langCode: langCode as PanelSignals["langCode"], setLangCode: setLangCode as PanelSignals["setLangCode"],
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
    setBalanceState,
    balanceCurrency, setBalanceCurrency,
    borderVisible, setBorderVisible,
    overrideSessionId, setOverrideSessionId,
    sidebarVisible, setSidebarVisible,
  }
}

/** 面板根组件：在组件渲染上下文注册命令 layer（keymap.layer 必须由组件调用），
 *  再渲染共享 TokenCachePanel；同时驱动余额轮询（对齐 V1 tui() 的 pollBalance）。 */
function PluginRoot(props: {
  context: Context
  api: PanelApi
  signals: PanelSignals & { setBalanceState: (v: BalanceState) => void }
  sessionID: string
}) {
  // 请求序号：防止定时轮询与手动刷新并发时，慢的旧请求覆盖新结果（对齐 V1）
  let balanceSeq = 0
  // 对齐官方内置插件示例（feature-plugins/system/plugins.tsx）：mode 用 global
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: makeCommands(props.context, props.api, props.signals),
  }))
  // 语言偏好恢复（对齐 V1 tui() restoreLang：优先用户 /cache-lang 设置，覆盖自动检测）
  onMount(() => {
    try {
      const saved = props.api.kv.get<string>(`${KV_PREFIX}.lang`)
      if (saved && LANG_META.some((m) => m.code === saved)) {
        props.signals.setLangCode(saved as LangCode)
      }
    } catch {}
  })

  // ── 余额轮询（对齐 V1 tui() pollBalance）：手动 key 优先，缺失时自动复用 OpenCode 已认证 key ──
  const pollBalance = async () => {
    const provider = getBalanceProvider(props.signals.balanceProviderId())
    const key = props.api.kv.get<string>(`${KV_PREFIX}.balance.${provider.id}.key`, "")
      || findOpencodeKeyV2(props.context, provider)
    const set = props.signals.setBalanceState
    if (props.signals.balanceUnsupported()) { set({ status: "idle", data: null, lastFetch: 0, error: undefined, key: undefined }); return }
    if (!key) { set({ status: "idle", data: null, lastFetch: 0, error: undefined, key: undefined }); return }
    const now = Date.now()
    const prev = props.signals.balanceState()
    // key 已更换（重新输入）→ 强制重新查询，绕过缓存
    if (prev.status === "ok" && prev.key === key && now - prev.lastFetch < BALANCE_POLL_MS) return
    const seq = ++balanceSeq
    set({ ...prev, status: "loading", error: undefined, key })
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, 10_000)
    try {
      const data = await provider.fetchBalance(key, controller.signal)
      clearTimeout(timer)
      if (seq !== balanceSeq) return // 已被更新的请求取代，丢弃过期结果
      set({ status: "ok", data, lastFetch: Date.now(), error: undefined, key })
    } catch (err) {
      clearTimeout(timer)
      if (seq !== balanceSeq) return
      const code = timedOut ? "TIMEOUT" : (err instanceof Error ? err.message : "")
      set({ status: "error", data: null, lastFetch: 0, error: code, key })
    }
  }
  // Re-fetch when the API key is (re)configured via /cache-balance-key。
  // 注意：pollBalance 内部读写 balanceState 信号，若不做 untrack 包裹，
  // effect 会追踪 balanceState 的变化并与 setBalanceState 形成无限循环。
  createEffect(() => {
    void props.signals.balanceRefresh()
    untrack(() => { void pollBalance() })
  })
  // 定时轮询（5 分钟）；随插件生命周期清理
  const balanceTimer = setInterval(pollBalance, BALANCE_POLL_MS)
  onCleanup(() => clearInterval(balanceTimer))

  // auto-clear override：用户导航到不同主会话时清除子代理视图（对齐 V1 createSidebarSlot）
  let lastSlotSid = props.sessionID
  createEffect(() => {
    const sid = props.sessionID
    if (sid !== lastSlotSid) {
      lastSlotSid = sid
      if (props.signals.overrideSessionId()) {
        props.signals.setOverrideSessionId(undefined)
        void props.api.kv.set(`${KV_PREFIX}.session`, "")
      }
    }
  })

  return (
    <TokenCachePanel
      theme={mapTheme(props.context.theme)}
      api={props.api}
      sessionId={props.sessionID}
      signals={props.signals}
    />
  )
}

const mod: PluginModule & { server: () => Promise<Record<string, never>> } = {
  id: "opencode-visual-cache",
  setup(context: Context) {
    const api = createPanelApi(context)
    const signals = createPanelSignals()

    // 侧边栏完整面板（与 V1 同一组件；命令 layer 在组件内注册）。
    // prepend：排在宿主官方信息（问候/Context/用量）之前，紧跟会话标题。
    context.ui.slot({
      prepend: "sidebar.content",
      render: (props) => (
        <PluginRoot context={context} api={api} signals={signals} sessionID={String(props.sessionID ?? "")} />
      ),
    })

    // 底部状态栏（完整口径与 V1 一致；余额读共享 signals.balanceState）
    context.ui.slot({
      append: "prompt.footer.status",
      render: (props) => (
        <StatusView context={context} api={api} signals={signals} sessionID={String(props.sessionID ?? "")} />
      ),
    })

    // 偏好持久化（实验：storage.store 用法验证）
    context.storage.store("opencode-visual-cache.panel", { initial: { collapsed: false } })
  },
  // V1 server 空实现（兼容标记）：参考 oh-my-opencode-slim 的 { id, server, setup }——
  // v2 加载 setup，但 V1 检测需要 server 字段识别为插件
  server: async () => ({}),
}

export default mod
