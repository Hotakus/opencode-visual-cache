/** @jsxImportSource @opentui/solid */

import { createMemo, For, Show } from "solid-js"
import type { Context } from "./types"
import { collectLastHitRate } from "./data"
import { desaturateTo, fmtCompact, MAX_SAT, FALLBACK, visualWidth } from "../core"

/**
 * 底部状态栏（prompt.footer.status）——复刻 V1 BottomStatusBar 统计段口径：
 * 单条命中率（最后一条有 token 的 assistant 消息）+ 趋势 + Tokens 总量 + 余额。
 * V2 的 status slot 由宿主提供路径/commands，本插件只渲染统计部分。
 */
export function StatusView(props: { context: Context; sessionID: string }) {
  const theme = props.context.theme

  const pal = createMemo(() => {
    const th = theme as unknown as Record<string, string>
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

  // 余额：V2 下待斜杠命令 + 手动 key 接入后可用；当前显示 "-"
  const balanceText = createMemo(() => "-")

  const segs = createMemo<{ text: string; color: string | undefined }[]>(() => {
    const s = stats()
    const hr = s.hitRate >= 0 ? (Math.floor(s.hitRate * 10) / 10).toFixed(1) + "%" : "--"
    const out: { text: string; color: string | undefined }[] = [
      { text: "Hit ", color: pal().muted },
      { text: hr, color: hitColor() },
    ]
    const tr = trend()
    if (tr !== null) {
      out.push({ text: " " + (tr > 0 ? "\u2191" : "\u2193") + Math.abs(tr).toFixed(1) + "%", color: tr > 0 ? pal().success : pal().error })
    }
    out.push({ text: " \u00b7 Tok ", color: pal().muted })
    out.push({ text: fmtCompact(s.input + s.read + s.write), color: pal().text })
    out.push({ text: " \u00b7 Bal ", color: pal().muted })
    out.push({ text: balanceText(), color: pal().text })
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
