/** @jsxImportSource @opentui/solid */

import { createMemo, For, Show } from "solid-js"
import type { Context } from "./types"
import type { PanelSignals } from "../panel/panel-api"
import { collectLastHitRate } from "./data"
import { desaturateTo, fmtCompact, formatBalanceText, MAX_SAT, FALLBACK, visualWidth } from "../core"
import { createT } from "../i18n"
import { mapTheme } from "./theme"

/**
 * 底部状态栏（prompt.footer.status）——对齐 V1 BottomStatusBar 统计段口径：
 * 单条命中率（最后一条有 token 的 assistant 消息）+ 趋势 + Tokens 总量 + 余额。
 * 余额读共享 signals.balanceState（PluginRoot 驱动轮询）；provider 不支持余额时隐藏余额段（对齐 V1）。
 * 颜色经 mapTheme（V1 形状）——与侧边栏命中率颜色同源，保证两处一致。
 */
export function StatusView(props: {
  context: Context
  signals: PanelSignals
  sessionID: string
}) {
  const t = createT(() => props.signals.langCode())

  // 与侧边栏 TokenCachePanel 同一颜色来源（mapTheme → desaturateTo）
  const pal = createMemo(() => {
    const th = mapTheme(props.context.theme) as unknown as Record<string, string>
    const sat = (k: string, fb: string) => desaturateTo(th[k], MAX_SAT, fb)
    return {
      text: sat("text", FALLBACK.text),
      muted: sat("textMuted", FALLBACK.muted),
      success: sat("success", FALLBACK.success),
      warning: sat("warning", FALLBACK.warning),
      error: sat("error", FALLBACK.error),
    }
  })

  const stats = createMemo(() => collectLastHitRate(props.context, props.sessionID))

  const hitColor = createMemo(() => {
    const r = stats().hitRate
    if (r >= 85) return pal().success
    if (r >= 70) return pal().warning
    return pal().error
  })

  // 命中率趋势：最后一条与上一条的差值；|Δ| < 0.05 视为无变化（null = 不显示）
  const trend = createMemo(() => {
    const s = stats()
    if (s.prevHitRate < 0 || s.hitRate < 0) return null
    const d = s.hitRate - s.prevHitRate
    return Math.abs(d) < 0.05 ? null : d
  })

  // 余额文本（对齐 V1）：ok → 数值；loading → …；error → ⚠；idle → -
  const balanceText = createMemo(() => {
    const s = props.signals.balanceState()
    if (s.status === "ok" && s.data) return formatBalanceText(s.data, props.signals.balanceCurrency(), props.signals.exchangeRate())
    if (s.status === "loading") return "\u2026"
    if (s.status === "error") return "\u26a0"
    return "-"
  })

  const segs = createMemo<{ text: string; color: string | undefined }[]>(() => {
    const s = stats()
    const hr = s.hitRate >= 0 ? (Math.floor(s.hitRate * 10) / 10).toFixed(1) + "%" : "--"
    const out: { text: string; color: string | undefined }[] = [
      { text: t("barHit") + " ", color: pal().muted },
      { text: hr, color: hitColor() },
    ]
    const tr = trend()
    if (tr !== null) {
      out.push({ text: " " + (tr > 0 ? "\u2191" : "\u2193") + Math.abs(tr).toFixed(1) + "%", color: tr > 0 ? pal().success : pal().error })
    }
    out.push({ text: " \u00b7 " + t("barTok") + " ", color: pal().muted })
    out.push({ text: s ? fmtCompact(s.input + s.read + s.write) : "--", color: pal().text })
    if (!props.signals.balanceUnsupported()) {
      out.push({ text: " \u00b7 " + t("barBal") + " ", color: pal().muted })
      out.push({ text: balanceText(), color: pal().text })
    }
    out.push({ text: " \u00b7 ", color: pal().muted })
    return out
  })
  const segsW = createMemo(() => {
    let w = 0
    for (const sg of segs()) w += visualWidth(sg.text)
    return w
  })

  return (
    <Show when={segsW() > 0}>
      <text>
        <For each={segs()}>{(sg) => <span style={{ fg: sg.color }}>{sg.text}</span>}</For>
      </text>
    </Show>
  )
}
