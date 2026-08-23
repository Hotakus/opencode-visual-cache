import type { Context, KeymapCommand } from "./types"
import type { PanelApi, PanelSignals } from "../panel/panel-api"
import { CURRENCIES, DEFAULT_RATES, visualPadEnd } from "../core"
import { balanceProviders, getBalanceProvider, maskKey, type BalanceProvider } from "../balance-providers"
import { LANG_META, createT, type LangCode } from "../i18n"

const KV_PREFIX = "cache_panel"

// ---------------------------------------------------------------------------
// V2 helpers（对齐 V1 index.tsx 内嵌辅助；API 形态从 V1 组件式切换为 V2 Promise 式）
// ---------------------------------------------------------------------------

/** V2 无 api.state.part API——从消息 content 数组提取 tool parts（V2 Tool part 形状）。 */
function extractToolParts(msg: Record<string, any>): Array<Record<string, any>> {
  if (!Array.isArray(msg?.content)) return []
  return msg.content.filter((p: Record<string, any>) => p?.type === "tool")
}

/** V2 版 findOpencodeKey：从 V2 provider list 找 OpenCode 已认证的 key（对齐 V1 api.state.provider）。
 *  导出供 index.tsx 的余额轮询复用。 */
export function findOpencodeKeyV2(context: Context, provider: BalanceProvider): string {
  try {
    const provs = context.data.location.provider.list() as Array<{ id?: string; key?: string; options?: { apiKey?: string } }>
    const id = provider.id.toLowerCase()
    const hit = provs.find((p) => String(p.id ?? "").toLowerCase() === id)
      ?? provs.find((p) => String(p.id ?? "").toLowerCase().startsWith(id))
    if (!hit) return ""
    const k = typeof hit.key === "string" ? hit.key : ""
    if (k) return k
    return typeof hit.options?.apiKey === "string" ? hit.options.apiKey : ""
  } catch {
    return ""
  }
}

/** 当前路由 sessionID（V2 ui.router.current()；Route = { type: "session", sessionID }）。 */
function currentSessionID(context: Context): string {
  try {
    const rt = context.ui.router.current()
    if (rt?.type === "session" && rt.sessionID) return String(rt.sessionID)
  } catch {}
  return ""
}

/** V2 斜杠命令（对齐 V1 10 个命令的完整行为）。
 *  keymap.layer 必须在组件渲染上下文调用，因此本函数只构建命令数组，
 *  由渲染组件内 layer(() => ({ commands })) 注册。 */
export function makeCommands(context: Context, api: PanelApi, signals: PanelSignals): KeymapCommand[] {
  const t = () => createT(() => signals.langCode())

  /** 菜单中 provider 选项标题：标注 key 来源（手动配置 / OpenCode 自动复用 / 未配置）。 */
  const providerOptionTitle = (p: BalanceProvider, current?: string) => {
    const hasManual = !!api.kv.get<string>(`${KV_PREFIX}.balance.${p.id}.key`, "")
    const hasAuto = !hasManual && !!findOpencodeKeyV2(context, p)
    const mark = hasManual
      ? t()("keyUser")
      : hasAuto
        ? t()("keyOpenCode")
        : t()("keyNotSet")
    return p.name + mark + (current && p.id === current ? " *" : "")
  }

  /** 弹出指定 provider 的 API Key 输入框（空清除 / 含 * 保留原 key / 新 key 实时刷新）。 */
  const promptBalanceKey = async (provider: BalanceProvider): Promise<void> => {
    const current = api.kv.get<string>(`${KV_PREFIX}.balance.${provider.id}.key`, "") ?? ""
    const val = await context.ui.dialog.prompt({
      title: provider.name,
      message: t()("balKeyPrompt", { p: provider.name }),
      placeholder: provider.keyPlaceholder ?? "sk-...",
    })
    if (val === undefined) return // 取消
    const input = val.trim()
    let key: string
    if (input === "") {
      key = ""
    } else if (input.includes("*")) {
      key = current
    } else {
      key = input
    }
    await api.kv.set(`${KV_PREFIX}.balance.${provider.id}.key`, key)
    signals.setBalanceRefresh(signals.balanceRefresh() + 1)
    context.ui.toast.show({ message: key ? t()("keySaved") : t()("keyCleared") })
  }

  return [
    // ── /cache-currency 切换货币 ──
    {
      id: "opencode-visual-cache.cache.currency",
      title: "Cache: Set Currency",
      description: "Change the currency unit for cost display",
      group: "Cache",
      palette: true,
      slash: { name: "cache-currency" },
      run: async () => {
        const opt = await context.ui.dialog.select<string>({
          title: "Select Currency",
          options: Object.entries(CURRENCIES).map(([code, sym]) => ({
            title: `${code}  (${sym})`,
            value: code,
          })),
        })
        if (!opt) return
        const sym = CURRENCIES[opt] ?? "$"
        const defRate = DEFAULT_RATES[opt] ?? 1
        await api.kv.set(`${KV_PREFIX}.currency`, sym)
        await api.kv.set(`${KV_PREFIX}.rate`, defRate)
        // 同步余额显示币种偏好：CNY/USD 原生直显，其余币种按汇率换算
        await api.kv.set(`${KV_PREFIX}.balance_currency`, opt)
        signals.setBalanceCurrency(opt)
        signals.setCurrencySymbol(sym)
        signals.setExchangeRate(defRate)
        context.ui.toast.show({ message: t()("currencySet", { v: opt, s: sym, r: defRate }) })
      },
    },
    // ── /cache-rate 调整汇率 ──
    {
      id: "opencode-visual-cache.cache.rate",
      title: "Cache: Set Exchange Rate",
      description: "Set the exchange rate multiplier for the selected currency",
      group: "Cache",
      palette: true,
      slash: { name: "cache-rate" },
      run: async () => {
        const val = await context.ui.dialog.prompt({
          title: "Exchange Rate",
          message: "Enter the exchange rate from USD to your currency (e.g. 7.2 for CNY)",
          placeholder: "1.0",
        })
        if (val === undefined) return
        const n = parseFloat(val)
        if (n > 0) {
          await api.kv.set(`${KV_PREFIX}.rate`, n)
          signals.setExchangeRate(n)
          context.ui.toast.show({ message: t()("rateSet", { r: n }) })
        }
      },
    },
    // ── /cache-section 开关区块与边框 ──
    {
      id: "opencode-visual-cache.cache.section",
      title: "Cache: Toggle Section",
      description: "Show or hide a sidebar section",
      group: "Cache",
      palette: true,
      slash: { name: "cache-section" },
      run: async () => {
        const detailOn = Boolean(api.kv.get(`${KV_PREFIX}.section.detail`, true))
        const modelOn  = Boolean(api.kv.get(`${KV_PREFIX}.section.model`, true))
        const distOn   = Boolean(api.kv.get(`${KV_PREFIX}.section.dist`, true))
        const skillsOn = Boolean(api.kv.get(`${KV_PREFIX}.section.skills`, true))
        const balanceOn = Boolean(api.kv.get(`${KV_PREFIX}.section.balance`, true))
        const bottomOn = Boolean(api.kv.get(`${KV_PREFIX}.section.bottom`, true))
        const borderOn = Boolean(api.kv.get(`${KV_PREFIX}.border`, true))
        const labels: Record<string, string> = {
          detail:  t()("secDetail"),
          model:   t()("secModel"),
          dist:    t()("distTitle"),
          skills:  t()("secSkills"),
          balance: t()("secBalance"),
          bottom:  t()("secBottom"),
          border:  t()("secBorder"),
        }
        const optTitle = (label: string, on: boolean) => `${visualPadEnd(label, 15)}[${on ? "ON" : "OFF"}]`
        const opt = await context.ui.dialog.select<string>({
          title: t()("secToggle"),
          options: [
            { title: optTitle(labels.detail, detailOn),   value: "detail" },
            { title: optTitle(labels.model, modelOn),     value: "model" },
            { title: optTitle(labels.dist, distOn),       value: "dist" },
            { title: optTitle(labels.skills, skillsOn),   value: "skills" },
            { title: optTitle(labels.balance, balanceOn), value: "balance" },
            { title: optTitle(labels.bottom, bottomOn),   value: "bottom" },
            { title: optTitle(labels.border, borderOn),   value: "border" },
          ],
        })
        if (!opt) return
        if (opt === "border") {
          const cur = Boolean(api.kv.get(`${KV_PREFIX}.border`, true))
          await api.kv.set(`${KV_PREFIX}.border`, !cur)
          signals.setBorderVisible(!cur)
          context.ui.toast.show({ message: !cur ? t()("borderShown") : t()("borderHidden") })
        } else {
          const key = `${KV_PREFIX}.section.${opt}`
          const cur = Boolean(api.kv.get(key, true))
          await api.kv.set(key, !cur)
          if (opt === "detail") signals.setSectionDetail(!cur)
          if (opt === "model")  signals.setSectionModel(!cur)
          if (opt === "dist")   signals.setSectionDist(!cur)
          if (opt === "skills") signals.setSectionSkills(!cur)
          if (opt === "balance") signals.setSectionBalance(!cur)
          if (opt === "bottom")  signals.setSectionBottom(!cur)
          const name = labels[opt] ?? opt
          context.ui.toast.show({ message: t()(!cur ? "sectionShown" : "sectionHidden", { s: name }) })
        }
      },
    },
    // ── /cache-config 查看当前配置 ──
    {
      id: "opencode-visual-cache.cache.config",
      title: "Cache: Show Config",
      description: "Display the current plugin configuration",
      group: "Cache",
      palette: true,
      slash: { name: "cache-config" },
      run: () => {
        const sym = api.kv.get<string>(`${KV_PREFIX}.currency`) ?? "$"
        const rate = api.kv.get<number>(`${KV_PREFIX}.rate`) ?? 1
        const detail = Boolean(api.kv.get(`${KV_PREFIX}.section.detail`, true))
        const model = Boolean(api.kv.get(`${KV_PREFIX}.section.model`, true))
        const dist = Boolean(api.kv.get(`${KV_PREFIX}.section.dist`, true))
        const skills = Boolean(api.kv.get(`${KV_PREFIX}.section.skills`, true))
        const balance = Boolean(api.kv.get(`${KV_PREFIX}.section.balance`, true))
        const bottom = Boolean(api.kv.get(`${KV_PREFIX}.section.bottom`, true))
        const on = (v: boolean) => v ? "ON" : "OFF"
        context.ui.toast.show({
          title: t()("panelConfigTitle"),
          message: t()("panelConfigMsg", {
            c: sym, r: rate,
            d: on(detail), m: on(model),
            t: on(dist), k: on(skills),
            b: on(balance), f: on(bottom),
          }),
        })
      },
    },
    // ── /cache-lang 切换显示语言 ──
    {
      id: "opencode-visual-cache.cache.lang",
      title: "Cache: Switch Language",
      description: "Switch display language (Chinese / English / 日本語 / 한국어)",
      group: "Cache",
      palette: true,
      slash: { name: "cache-lang" },
      run: async () => {
        const cur = signals.langCode()
        const opt = await context.ui.dialog.select<LangCode>({
          title: t()("langTitle"),
          options: LANG_META.map((m) => ({
            title: `${visualPadEnd(m.label, 9)}${cur === m.code ? "\u2713" : ""}`,
            value: m.code,
          })),
        })
        if (!opt) return
        await api.kv.set(`${KV_PREFIX}.lang`, opt)
        signals.setLangCode(opt)
        context.ui.toast.show({ message: t()("langSwitched") })
      },
    },
    // ── /cache-balance 切换余额提供商 / 自动切换 ──
    {
      id: "opencode-visual-cache.cache.balance",
      title: "Cache: Switch Balance Provider",
      description: "切换余额提供商 / 自动切换当前会话提供商 | Switch balance provider / auto-switch session provider",
      group: "Cache",
      palette: true,
      slash: { name: "cache-balance" },
      run: async () => {
        const current = signals.balanceProviderId()
        const auto = signals.autoBalance()
        const autoLabel = `${t()("autoSwitchOpt")} [${auto ? "ON" : "OFF"}]`
        const opt = await context.ui.dialog.select<string>({
          title: t()("balProvTitle"),
          options: [
            { title: autoLabel, value: "__auto__" },
            ...balanceProviders.map((p) => ({
              title: providerOptionTitle(p, current),
              value: p.id,
            })),
          ],
        })
        if (!opt) return
        if (opt === "__auto__") {
          const next = !auto
          await api.kv.set(`${KV_PREFIX}.balance.auto`, next)
          signals.setAutoBalance(next)
          context.ui.toast.show({ message: next ? t()("autoSwitchOn") : t()("autoSwitchOff") })
        } else {
          const provider = getBalanceProvider(opt)
          // 手动切换会关闭自动切换
          await api.kv.set(`${KV_PREFIX}.balance.provider`, provider.id)
          await api.kv.set(`${KV_PREFIX}.balance.auto`, false)
          signals.setBalanceProviderId(provider.id)
          signals.setAutoBalance(false)
          signals.setBalanceUnsupported(false)
          // 切换后立即按新 provider 刷新显示（无 key 时显示 idle，避免残留上一 provider 余额）
          signals.setBalanceRefresh(signals.balanceRefresh() + 1)
          const hasKey = !!api.kv.get<string>(`${KV_PREFIX}.balance.${provider.id}.key`, "")
          if (!hasKey) {
            // 未配置 key → 进入设置流程（对话框保持打开等待输入）
            await promptBalanceKey(provider)
          } else {
            context.ui.toast.show({ message: t()("providerManual", { p: provider.name }) })
          }
        }
      },
    },
    // ── /cache-balance-key 设置余额 API Key（两步：选 provider → 输 key）──
    {
      id: "opencode-visual-cache.cache.balance.key",
      title: "Cache: Set Balance API Key",
      description: "Select a provider and set its API key for balance display",
      group: "Cache",
      palette: true,
      slash: { name: "cache-balance-key" },
      run: async () => {
        // 步骤 1：选择 provider
        const opt = await context.ui.dialog.select<string>({
          title: t()("balSelectTitle"),
          options: balanceProviders.map((p) => ({
            title: providerOptionTitle(p),
            value: p.id,
          })),
        })
        if (!opt) return
        const provider = getBalanceProvider(opt)
        // 手动指定 provider 会关闭自动切换
        await api.kv.set(`${KV_PREFIX}.balance.provider`, provider.id)
        await api.kv.set(`${KV_PREFIX}.balance.auto`, false)
        signals.setBalanceProviderId(provider.id)
        signals.setAutoBalance(false)
        // 切换后立即刷新显示（防止取消输入时残留上一 provider 的余额）
        signals.setBalanceRefresh(signals.balanceRefresh() + 1)
        // 步骤 2：输入 key
        await promptBalanceKey(provider)
      },
    },
    // ── /cache-debug-skills 技能检测调试 ──
    {
      id: "opencode-visual-cache.cache.debug-skills",
      title: "Cache: Debug Skills Detection",
      description: "Dump all tool parts found in the current session for skill detection debugging",
      group: "Cache",
      palette: true,
      slash: { name: "cache-debug-skills" },
      run: () => {
        const sid = currentSessionID(context)
        if (!sid) {
          context.ui.toast.show({ message: t()("runInSession"), variant: "warning" })
          return
        }
        const msgs = api.state.session.messages(sid)
        const byTool: Record<string, number> = {}
        const skillParts: string[] = []
        for (const msg of msgs) {
          if (msg.role !== "assistant") continue
          for (const p of extractToolParts(msg)) {
            const tool = String(p.tool ?? "?")
            byTool[tool] = (byTool[tool] ?? 0) + 1
            if (tool === "skill") {
              const meta = p.state?.metadata
              const rootMeta = p.metadata
              skillParts.push(`state.metadata=${JSON.stringify(meta)} | root.metadata=${JSON.stringify(rootMeta)} | state.title="${p.state?.title}" | state.output[:80]="${String(p.state?.output ?? "").slice(0, 80)}"`)
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
        })
      },
    },
    // ── /cache-session 子代理缓存统计 ──
    {
      id: "opencode-visual-cache.cache.session",
      title: "Cache: Sub-Agent Stats",
      description: "View token cache statistics for a sub-agent by session ID",
      group: "Cache",
      palette: true,
      slash: { name: "cache-session" },
      run: async () => {
        // ── 扫描当前主 session 的子代理 session ID 列表 ──
        const parentSid = currentSessionID(context)
        const SUBAGENT_TOOLS = new Set(["task", "delegate", "call_omo_agent"])

        interface ChildEntry { title: string; value: string; description: string }
        const children: ChildEntry[] = []
        if (parentSid) {
          try {
            const msgs = api.state.session.messages(parentSid)
            for (const msg of msgs) {
              if (msg.role !== "assistant") continue
              for (const p of extractToolParts(msg)) {
                const tool = String(p.tool ?? "")
                if (!SUBAGENT_TOOLS.has(tool)) continue
                const st = p.state as Record<string, unknown> | undefined
                const stMeta = st?.metadata as Record<string, unknown> | undefined
                const subSid = stMeta?.session_id ?? stMeta?.sessionId
                if (!subSid) continue
                const sidStr = String(subSid)
                const input = st?.input as Record<string, unknown> | undefined
                const agent = String(p.subagent_type ?? input?.subagent_type ?? input?.category ?? tool)
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
          const currentSid = signals.overrideSessionId() ?? api.kv.get<string>(`${KV_PREFIX}.session`, "")
          const options = unique.map((c, i) => ({
            title: `${i + 1}. ${c.title}`,
            value: c.value,
            description: c.description,
          }))
          // 首尾各放一个"回到主会话"，长列表时顶部底部均可直达
          const backValue = "__main__"
          const backTitle = `\u2500 ${t()("backToMainTitle")}`
          options.unshift({ title: backTitle, value: backValue, description: "" })
          options.push({ title: backTitle, value: backValue, description: "" })
          const currentIdx = currentSid ? options.findIndex(o => o.value === currentSid) : -1
          const opt = await context.ui.dialog.select<string>({
            title: t()("subSelectTitle"),
            options,
            current: currentIdx >= 0 ? options[currentIdx].value : undefined,
          })
          if (!opt) return
          if (opt === backValue) {
            signals.setOverrideSessionId(undefined)
            await api.kv.set(`${KV_PREFIX}.session`, "")
            context.ui.toast.show({ message: t()("backToMain") })
          } else {
            signals.setOverrideSessionId(opt)
            await api.kv.set(`${KV_PREFIX}.session`, opt)
            context.ui.toast.show({ message: t()("subAgentSwitched", { s: opt.slice(0, 24) + "\u2026" }) })
          }
        } else {
          // ── 无子代理 → DialogPrompt 手动粘贴 ──
          const val = await context.ui.dialog.prompt({
            title: signals.overrideSessionId() ? t()("subSwitchTitle") : t()("subViewTitle"),
            message: t()("subNoFound"),
            placeholder: "ses_...",
          })
          if (val === undefined) return
          const sid = val.trim()
          if (sid) {
            signals.setOverrideSessionId(sid)
            await api.kv.set(`${KV_PREFIX}.session`, sid)
            context.ui.toast.show({ message: t()("subAgentSwitched", { s: sid.slice(0, 24) + "\u2026" }) })
          }
        }
      },
    },
    // ── /cache-session-back 返回主会话 ──
    {
      id: "opencode-visual-cache.cache.session.back",
      title: "Cache: Back to Main",
      description: "Return to main session stats",
      group: "Cache",
      palette: true,
      slash: { name: "cache-session-back" },
      run: async () => {
        signals.setOverrideSessionId(undefined)
        await api.kv.set(`${KV_PREFIX}.session`, "")
        context.ui.toast.show({ message: t()("backToMain") })
      },
    },
  ]
}
