/** @jsxImportSource @opentui/solid */

import { createMemo, For, Show } from "solid-js"
import type { Context } from "./types"
import { collectSessionStats, hitRate } from "./data"
import { fmt, fmtCost, progressBar, visualPadEnd } from "../core"

const LABEL_GAP = 1
const BAR_BRACKETS = 2
const BAR_GAP = 1
const PCT_FIXED_WIDTH = 5
const MIN_PANEL_WIDTH = 20
const DEFAULT_PANEL_WIDTH = 26

export function SidebarView(props: { context: Context; sessionID: string }) {
  const stats = createMemo(() => collectSessionStats(props.context, props.sessionID))
  const rate = createMemo(() => hitRate(stats()))
  const theme = props.context.theme

  const rateColor = () => {
    const r = rate()
    if (r >= 85) return theme.text.feedback.success.default
    if (r >= 70) return theme.text.feedback.warning.default
    return theme.text.feedback.error.default
  }
  const barWidth = () =>
    Math.max(MIN_PANEL_WIDTH, Math.min(DEFAULT_PANEL_WIDTH, props.context.app.version ? DEFAULT_PANEL_WIDTH : DEFAULT_PANEL_WIDTH)) -
    LABEL_GAP - BAR_BRACKETS - BAR_GAP - PCT_FIXED_WIDTH - 1

  const rows = () => {
    const s = stats()
    return [
      { label: "Hit", value: fmt(s.cacheRead) + " tok", color: rateColor() },
      { label: "Miss", value: fmt(s.input + s.cacheWrite) + " tok", color: theme.text.default },
      { label: "Write", value: fmt(s.cacheWrite) + " tok", color: theme.text.subdued },
      { label: "Out", value: fmt(s.output) + " tok", color: theme.text.subdued },
    ]
  }

  return (
    <Show when={stats().hasData}>
      <box>
        <box flexDirection="row" gap={LABEL_GAP}>
          <text fg={theme.text.default}>Cache</text>
          <text fg={rateColor()}>
            {"["}
            {progressBar(rate(), barWidth())}
            {"]"}
          </text>
          <text fg={rateColor()}>{rate().toFixed(1) + "%"}</text>
        </box>
        <For each={rows()}>
          {(row) => (
            <box flexDirection="row" gap={LABEL_GAP}>
              <text fg={theme.text.default}>{visualPadEnd(row.label, 5)}</text>
              <text fg={row.color}>{row.value}</text>
            </box>
          )}
        </For>
        <Show when={stats().cost > 0}>
          <box flexDirection="row" gap={LABEL_GAP}>
            <text fg={theme.text.default}>{"Cost"}</text>
            <text fg={theme.text.default}>{fmtCost(stats().cost)}</text>
          </box>
        </Show>
      </box>
    </Show>
  )
}
