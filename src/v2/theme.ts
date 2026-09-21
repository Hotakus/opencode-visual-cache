import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { Context } from "./types"

/** V2 theme → V1 形状映射（组件按 primary/text/textMuted/… 字段消费）。
 *  侧边栏与底部栏共用——保证命中率颜色等两处一致。
 *  - V1 primary → V2 interactive（v1-migrate.ts 官方映射：interactive = hues.byToken.primary）
 *  - step 取 300：更亮（对齐 V2 暗色强调惯例的亮端），500/400 在暗背景下偏深
 */
export function mapTheme(theme: Context["theme"]): TuiThemeCurrent {
  const text = theme.text
  const feedback = text.feedback
  // 文本色 token 有两代命名（base/muted 与 default/subdued），base/muted 优先。
  return {
    primary: theme.hue.interactive[300],
    text: text.base ?? text.default,
    textMuted: text.muted ?? text.subdued,
    success: feedback.success.base ?? feedback.success.default,
    warning: feedback.warning.base ?? feedback.warning.default,
    error: feedback.error.base ?? feedback.error.default,
    border: text.muted ?? text.subdued,
  } as unknown as TuiThemeCurrent
}
