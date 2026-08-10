// ---------------------------------------------------------------------------
// i18n — centralized translations. Add a language by appending a table that
// satisfies `Translation`; the compiler enforces key completeness.
// ---------------------------------------------------------------------------

export type LangCode = "zh" | "en"

const ZH_T = {
  title:      "缓存统计",
  hit:        "命中率",
  totalHit:   "总命中:",
  read:       "缓存读:",
  write:      "缓存写:",
  miss:       "未命中:",
  out:        "输出:",
  cost:       "费用:",
  saved:      "累计节省:",
  model:      "模型:",
  provider:   "提供商:",
  rate:       "单价:",
  hitFolded:  "命中",
  inputRate:  "输入",
  cacheRate:  "缓存",
  writeRate:  "写入",
  noData:    "等待缓存数据...",
  tok:        "tok",
  distTitle:  "估算 Token 分布",
  distSys:    "系统提示:",
  distUser:   "用户:",
  distAgent:  "Agent 指令:",
  distTool:   "Tool 调用:",
  distRes:    "Tool 结果:",
  distTotal:  "总计:",
  distOut:    "输出:",
  secDetail:  "明细",
  secModel:   "模型",
  secSkills:  "已加载技能",
  balTotal:   "总余额:",
  balNoKey:   "未配置 {p} API Key",
  balLoading: "查询中...",
  balError:   "查询失败",
  balErr401:  "API Key 无效",
  balErr403:  "余额查询被拒绝",
  balErrEmpty:"未获取到余额数据",
  balErrTimeout: "查询超时",
  balUnsupported: "当前提供商不支持余额查询",
  barHit:     "命中率",
  barBal:     "余额",
  barTok:     "Tokens",
  // ── /cache-section 面板 ──
  secToggle:  "切换区块",
  secBalance: "余额",
  secBottom:  "底部状态栏",
  secBorder:  "面板边框",
  // ── toast ──
  keySaved:   "API Key 已保存，正在查询余额...",
  keyCleared: "API Key 已清除",
  currencySet: "币种: {v} ({s}), 汇率: {r}",
  rateSet:    "汇率已设为 {r}",
  panelConfigTitle: "缓存面板配置",
  panelConfigMsg: "币种: {c} | 汇率: {r} | 明细: {d} | 模型: {m} | 分布: {t} | 技能: {k} | 余额: {b} | 底部: {f}",
  borderShown: "面板边框 已显示",
  borderHidden: "面板边框 已隐藏",
  sectionShown: "{s} 已显示",
  sectionHidden: "{s} 已隐藏",
  langSwitched: "语言已切换为中文",
  autoSwitchOn: "自动切换余额提供商: 开",
  autoSwitchOff: "自动切换余额提供商: 关",
  providerManual: "余额提供商: {p}（自动切换已关闭）",
  runInSession: "请在会话内运行此命令",
  backToMain: "已切回主会话",
  subAgentSwitched: "已切换至子代理: {s}",
  // ── 对话框 / 菜单 ──
  langTitle:  "显示语言",
  subPrefix:  "子代理: ",
  keyUser:    "（用户 key）",
  keyOpenCode: "（OpenCode）",
  keyNotSet:  "（未配置）",
  balKeyPrompt: "输入 {p} API Key 以显示账户余额（留空清除）",
  balProvTitle: "余额提供商 / 自动切换",
  autoSwitchOpt: "自动切换提供商",
  balSelectTitle: "选择余额提供商",
  backToMainTitle: "回到主会话",
  subSelectTitle: "选择子代理",
  subSwitchTitle: "切换子代理",
  subViewTitle: "查看子代理缓存",
  subNoFound: "未找到子代理，请手动粘贴 Session ID",
} as const

/** 结构约束：值放宽为 string，键集合来自中文表（新增语言缺 key 会编译报错）。 */
export type Translation = { [K in keyof typeof ZH_T]: string }

const EN_T: Translation = {
  title:      "Token Cache",
  hit:        "Hit",
  totalHit:   "Total Hit:",
  read:       "Read:",
  write:      "Write:",
  miss:       "Miss:",
  out:        "Out:",
  cost:       "Cost:",
  saved:      "Total Saved:",
  model:      "Model:",
  provider:   "Provider:",
  rate:       "Rate:",
  hitFolded:  "hit",
  inputRate:  "in",
  cacheRate:  "cache",
  writeRate:  "write",
  noData:    "Waiting for cache data...",
  tok:        "tok",
  distTitle:  "Estimated Token Dist.",
  distSys:    "System:",
  distUser:   "User:",
  distAgent:  "Agent Instr:",
  distTool:   "Tool Call:",
  distRes:    "Tool Result:",
  distTotal:  "Total:",
  distOut:    "Output:",
  secDetail:  "Detail",
  secModel:   "Model",
  secSkills:  "Loaded Skills",
  balTotal:   "Total:",
  balNoKey:   "{p} API Key not set",
  balLoading: "Fetching...",
  balError:   "Fetch failed",
  balErr401:  "Invalid API Key",
  balErr403:  "Balance request rejected",
  balErrEmpty:"No balance data",
  balErrTimeout: "Request timed out",
  balUnsupported: "Balance query unsupported",
  barHit:     "Hit",
  barBal:     "Balance",
  barTok:     "Tokens",
  // ── /cache-section panel ──
  secToggle:  "Toggle Section",
  secBalance: "Balance",
  secBottom:  "Bottom Bar",
  secBorder:  "Panel Border",
  // ── toasts ──
  keySaved:   "API Key saved, fetching balance...",
  keyCleared: "API Key cleared",
  currencySet: "Currency: {v} ({s}), rate: {r}",
  rateSet:    "Exchange rate set to {r}",
  panelConfigTitle: "Cache Panel Config",
  panelConfigMsg: "Currency: {c} | Rate: {r} | Detail: {d} | Model: {m} | Dist: {t} | Skills: {k} | Balance: {b} | Bottom: {f}",
  borderShown: "Panel border shown",
  borderHidden: "Panel border hidden",
  sectionShown: "{s} section shown",
  sectionHidden: "{s} section hidden",
  langSwitched: "Switched to English",
  autoSwitchOn: "Auto-switch balance provider: ON",
  autoSwitchOff: "Auto-switch balance provider: OFF",
  providerManual: "Balance provider: {p} (auto-switch off)",
  runInSession: "Please run this command inside a session",
  backToMain: "Switched to main session",
  subAgentSwitched: "Showing sub-agent: {s}",
  // ── dialogs / menus ──
  langTitle:  "Display Language",
  subPrefix:  "Sub: ",
  keyUser:    " (user key)",
  keyOpenCode: " (OpenCode)",
  keyNotSet:  " (not set)",
  balKeyPrompt: "Enter your {p} API key to show account balance (leave empty to clear)",
  balProvTitle: "Balance Provider / Auto-switch",
  autoSwitchOpt: "Auto-switch provider",
  balSelectTitle: "Select Balance Provider",
  backToMainTitle: "Back to Main",
  subSelectTitle: "Select Sub-Agent",
  subSwitchTitle: "Switch Sub",
  subViewTitle: "View Sub Cache",
  subNoFound: "No sub-agents found. Paste a Session ID manually",
}

export const LANGS: Record<LangCode, Translation> = { zh: ZH_T, en: EN_T }

/** 语言元数据：/cache-lang 选项与自动检测共用。 */
export const LANG_META: { code: LangCode; label: string }[] = [
  { code: "zh", label: "中文" },
  { code: "en", label: "English" },
]

/**
 * 模板参数替换：`{key}` 占位符统一在此处理。
 * 未提供的参数保留原占位符，避免静默丢失。
 */
export function applyParams(tpl: string, params?: Record<string, string | number>): string {
  if (!params) return tpl
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) =>
    k in params ? String(params[k]) : m,
  )
}

/**
 * 翻译查找函数工厂：`t("key")` 返回当前语言的文本，`t("key", { p })` 附带模板参数。
 * `getCode` 读取语言信号——在 SolidJS 渲染/memo 上下文中调用时自动建立响应式依赖。
 */
export function createT(getCode: () => LangCode) {
  return (key: keyof Translation, params?: Record<string, string | number>): string =>
    applyParams(LANGS[getCode()][key], params)
}

/** 按系统 locale 自动检测语言（zh 前缀 → 中文，其余 → 英文）。 */
export function detectLang(): LangCode {
  try {
    const loc = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase()
    return loc.startsWith("zh") ? "zh" : "en"
  } catch {
    return "en"
  }
}
