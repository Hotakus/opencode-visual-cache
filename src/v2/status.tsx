/** @jsxImportSource @opentui/solid */

import { createMemo, Show } from "solid-js"
import type { Context } from "./types"
import { collectSessionStats, hitRate, inputTotal } from "./data"
import { fmtCompact, fmtCost } from "../core"

/** 底部状态栏（prompt.footer.status）：命中率 · Tokens · 费用，复刻 V1 底部栏口径。 */
export function StatusView(props: { context: Context; sessionID: string }) {
  const stats = createMemo(() => collectSessionStats(props.context, props.sessionID))
  const rate = createMemo(() => hitRate(stats()))
  const theme = props.context.theme

  const rateColor = () => {
    const r = rate()
    if (r >= 85) return theme.text.feedback.success.default
    if (r >= 70) return theme.text.feedback.warning.default
    return theme.text.feedback.error.default
  }

  return (
    <Show when={stats().hasData}>
      <text>
        <span style={{ fg: rateColor() }}>{rate().toFixed(1) + "%"}</span>
        <span style={{ fg: theme.text.default }}> {fmtCompact(inputTotal(stats()))} tok</span>
        <Show when={stats().cost > 0}>
          <span style={{ fg: theme.text.subdued }}> {fmtCost(stats().cost)}</span>
        </Show>
      </text>
    </Show>
  )
}
