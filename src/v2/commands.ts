import type { Context, KeymapCommand } from "./types"
import type { PanelApi, PanelSignals } from "../panel/panel-api"

const KV_PREFIX = "cache_panel"

/** V2 斜杠命令定义（实验：基础命令集，key 存储走 storage.store）。
 *  注意：keymap.layer 必须在组件渲染上下文调用（owned by the calling component），
 *  因此本函数只构建命令数组，由渲染组件内 layer(() => ({ commands })) 注册。 */
export function makeCommands(context: Context, api: PanelApi, signals: PanelSignals): KeymapCommand[] {
  return [
    {
id: "opencode-visual-cache.cache.balance.key",
title: "Set balance API key",
name: "opencode-visual-cache.cache.balance.key",
namespace: "palette",
desc: "Manually set the API key used for balance queries",
category: "Cache",
slashName: "cache-balance-key",
description: "Manually set the API key used for balance queries",
palette: true,
slash: { name: "cache-balance-key" },
run: async () => {
  const providerId = signals.balanceProviderId() || "deepseek"
  const key = await context.ui.dialog.prompt({ title: `API Key for ${providerId}` })
  if (key) {
    await api.kv.set(`${KV_PREFIX}.balance.${providerId}.key`, key)
    context.ui.toast.show({ message: `Balance key saved for ${providerId}` })
    signals.setBalanceRefresh(signals.balanceRefresh() + 1)
  }
},
    },
    {
id: "opencode-visual-cache.cache.currency",
title: "Set currency",
name: "opencode-visual-cache.cache.currency",
namespace: "palette",
desc: "Switch display currency",
category: "Cache",
slashName: "cache-currency",
palette: true,
slash: { name: "cache-currency" },
run: async () => {
  const opt = await context.ui.dialog.select<{ code: string; symbol: string; rate: number }>({
    title: "Currency",
          options: [
            { title: "USD $", value: { code: "USD", symbol: "$", rate: 1 } },
            { title: "CNY ¥", value: { code: "CNY", symbol: "¥", rate: 7.2 } },
            { title: "EUR €", value: { code: "EUR", symbol: "€", rate: 0.92 } },
            { title: "JPY JP¥", value: { code: "JPY", symbol: "JP¥", rate: 150 } },
            { title: "GBP £", value: { code: "GBP", symbol: "£", rate: 0.79 } },
            { title: "KRW ₩", value: { code: "KRW", symbol: "₩", rate: 1350 } },
          ],
  })
  if (!opt) return
  signals.setCurrencySymbol(opt.symbol)
  signals.setExchangeRate(opt.rate)
  await api.kv.set(`${KV_PREFIX}.currency`, opt.code)
  await api.kv.set(`${KV_PREFIX}.rate`, opt.rate)
  context.ui.toast.show({ message: `Currency set to ${opt.code}` })
},
    },
    {
id: "opencode-visual-cache.cache.rate",
title: "Set exchange rate",
name: "opencode-visual-cache.cache.rate",
namespace: "palette",
desc: "Set exchange rate",
category: "Cache",
slashName: "cache-rate",
palette: true,
slash: { name: "cache-rate" },
run: async () => {
  const current = String(signals.exchangeRate())
  const input = await context.ui.dialog.prompt({ title: "Exchange rate (USD base)", message: current })
  const n = parseFloat(input ?? "")
  if (Number.isFinite(n) && n > 0) {
    signals.setExchangeRate(n)
    await api.kv.set(`${KV_PREFIX}.rate`, n)
    context.ui.toast.show({ message: `Rate set to ${n}` })
  }
},
    },
    {
id: "opencode-visual-cache.cache.lang",
title: "Switch language",
name: "opencode-visual-cache.cache.lang",
namespace: "palette",
desc: "Switch display language",
category: "Cache",
slashName: "cache-lang",
palette: true,
slash: { name: "cache-lang" },
run: async () => {
  const opt = await context.ui.dialog.select<"en" | "zh">({
    title: "Language",
    options: [
      { title: "English", value: "en" },
      { title: "中文", value: "zh" },
    ],
  })
  if (!opt) return
  signals.setLangCode(opt)
  await api.kv.set(`${KV_PREFIX}.lang`, opt)
  context.ui.toast.show({ message: `Language set to ${opt}` })
},
    },
  ]
}



