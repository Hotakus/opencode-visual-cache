/** @jsxImportSource @opentui/solid */

import { createSignal } from "solid-js"
import type { Context, PluginModule } from "./types"
import { createPanelApi } from "./v2-panel-api"
import { TokenCachePanel } from "../panel/TokenCachePanel"
import type { BalanceState, PanelSignals } from "../panel/panel-api"
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { StatusView } from "./status"

/** V2 theme → V1 形状映射（组件按 primary/text/textMuted/… 字段消费） */
function mapTheme(theme: Context["theme"]): TuiThemeCurrent {
  return {
    primary: theme.text.default,
    text: theme.text.default,
    textMuted: theme.text.subdued,
    success: theme.text.feedback.success.default,
    warning: theme.text.feedback.warning.default,
    error: theme.text.feedback.error.default,
    border: theme.text.subdued,
  } as unknown as TuiThemeCurrent
}

/** V2 侧创建面板信号（实验：默认值；偏好持久化经 PanelApi.kv → storage.store） */
function createPanelSignals(): PanelSignals {
  const [currencySymbol, setCurrencySymbol] = createSignal("$")
  const [exchangeRate, setExchangeRate] = createSignal(1)
  const [langCode, setLangCode] = createSignal("en")
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
  const [balanceState] = createSignal<BalanceState>({ status: "idle", data: null, lastFetch: 0 })
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
    balanceCurrency, setBalanceCurrency,
    borderVisible, setBorderVisible,
    overrideSessionId, setOverrideSessionId,
    sidebarVisible, setSidebarVisible,
  }
}

const mod: PluginModule = {
  id: "opencode-visual-cache",
  setup(context: Context) {
    const api = createPanelApi(context)
    const signals = createPanelSignals()

    // 侧边栏完整面板（与 V1 同一组件）
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => (
        <TokenCachePanel
          theme={mapTheme(context.theme)}
          api={api}
          sessionId={String(props.sessionID ?? "")}
          signals={signals}
        />
      ),
    })

    // 底部状态栏（简化版，完整口径与 V1 一致）
    context.ui.slot({
      append: "prompt.footer.status",
      render: (props) => <StatusView context={context} sessionID={String(props.sessionID ?? "")} />,
    })

    // 偏好持久化（实验：storage.store 用法验证）
    context.storage.store("opencode-visual-cache.panel", { initial: { collapsed: false } })
  },
}

export default mod
