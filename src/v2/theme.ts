import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { Context } from "./types"

/** V2 theme → V1 形状映射（组件按 primary/text/textMuted/… 字段消费）。
 *  侧边栏与底部栏共用——保证命中率颜色等两处一致。
 *  - V1 primary → V2 interactive（v1-migrate.ts 官方映射：interactive = hues.byToken.primary）
 *  - step 取 300：更亮（对齐 V2 暗色强调惯例的亮端），500/400 在暗背景下偏深
 */
export function mapTheme(theme: Context["theme"]): TuiThemeCurrent {
  return {
    primary: theme.hue.interactive[300],
    text: theme.text.default,
    textMuted: theme.text.subdued,
    success: theme.text.feedback.success.default,
    warning: theme.text.feedback.warning.default,
    error: theme.text.feedback.error.default,
    border: theme.text.subdued,
  } as unknown as TuiThemeCurrent
}
