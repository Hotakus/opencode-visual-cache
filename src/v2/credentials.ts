/**
 * V2 凭据解析：宿主 SQLite 优先，auth.json 兜底。
 *
 * opencode 2.x 把已认证凭据保存在 `~/.local/share/opencode/opencode.db`
 * 的 `credential` 表，OAuth 刷新只更新该库；`auth.json` 是迁移前的遗留
 * 快照，刷新后不再同步——只读 auth.json 会在 token 过期后拿到陈旧凭据
 * （OpenAI 余额查询因此 401 “Invalid API Key”）。
 *
 * bun:sqlite 仅 Bun 运行时可用：字符串变量让 tsc/esbuild 不做静态解析，
 * 动态 import 失败（Node/CI 测试）时静默回退 auth.json，不影响面板其余功能。
 */

declare const process: {
  env: Record<string, string | undefined>
  getBuiltinModule?: (id: string) => unknown
} | undefined

const BUN_SQLITE = "bun:sqlite"

export interface CredentialValue {
  type?: string
  access?: string
  key?: string
}

interface SqlStatement {
  all(...params: unknown[]): Record<string, unknown>[]
  get(...params: unknown[]): Record<string, unknown> | undefined
}
interface SqlDatabase {
  query(sql: string): SqlStatement
  close?(): void
}

/** 宿主数据库路径（OPENCODE_DB 覆盖，遵循 XDG_DATA_HOME）。 */
export function findCredentialDbPath(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
  home = typeof process !== "undefined" ? (process.env.HOME || process.env.USERPROFILE || "") : "",
): string | undefined {
  if (env.OPENCODE_DB) return env.OPENCODE_DB
  const base = env.XDG_DATA_HOME && env.XDG_DATA_HOME.length > 0
    ? env.XDG_DATA_HOME
    : home ? `${home}/.local/share` : ""
  if (!base) return undefined
  return `${base}/opencode/opencode.db`
}

/** 解析宿主持久化的凭据 JSON（oauth.access / api.key）。 */
export function parseCredentialValue(raw: unknown): CredentialValue | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined
  try {
    const value = JSON.parse(raw) as CredentialValue
    if (!value || typeof value !== "object") return undefined
    const hasToken = (typeof value.access === "string" && value.access.length > 0) ||
      (typeof value.key === "string" && value.key.length > 0)
    return hasToken ? value : undefined
  } catch {
    return undefined
  }
}

let db: SqlDatabase | undefined
let dbReady: Promise<void> | undefined

function openDatabase(): Promise<void> {
  if (dbReady) return dbReady
  dbReady = (async () => {
    const path = findCredentialDbPath()
    if (!path) return
    try {
      const mod = (await import(BUN_SQLITE)) as { Database?: new (p: string, o?: Record<string, unknown>) => SqlDatabase }
      const Database = mod?.Database
      if (!Database) return
      db = new Database(path, { readonly: true })
      try { db.query("pragma query_only = on").all() } catch { /* readonly 已足够 */ }
    } catch {
      db = undefined
    }
  })()
  return dbReady
}

/** 等待凭据库初始化（模块加载即开始；未就绪时解析会先回退 auth.json）。 */
export function credentialsDbReady(): Promise<void> {
  return openDatabase()
}

// 模块加载即预热（Bun 宿主），首次轮询无需等完整初始化流程
void openDatabase()

/** 读取宿主 SQLite 中该 integration 的启用凭据（库未就绪/无记录时 undefined）。 */
export function readDbCredential(integrationId: string): CredentialValue | undefined {
  if (!db || !integrationId) return undefined
  try {
    const row = db.query(
      "SELECT value FROM credential WHERE integration_id = ? AND active IS NOT 0 ORDER BY time_updated DESC LIMIT 1",
    ).get(integrationId)
    return parseCredentialValue(row?.value)
  } catch {
    return undefined
  }
}

/** 读取 auth.json（opencode 1.x / 迁移遗留）中某个 provider 的凭据。 */
export function readAuthJsonCredential(providerID: string): CredentialValue | undefined {
  try {
    const loader = typeof process !== "undefined" ? process.getBuiltinModule : undefined
    const fs = loader?.("node:fs") as { readFileSync(path: string, encoding: "utf8"): string } | undefined
    if (!fs) return undefined
    const home = typeof process !== "undefined" ? (process.env.HOME || process.env.USERPROFILE || "") : ""
    const dataHome = typeof process !== "undefined" ? process.env.XDG_DATA_HOME : undefined
    const paths = [
      dataHome ? `${dataHome}/opencode/auth.json` : "",
      home ? `${home}/.local/share/opencode/auth.json` : "",
    ]
    for (const path of paths) {
      if (!path) continue
      try {
        const auth = JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, unknown>
        const entry = auth[providerID]
        if (entry && typeof entry === "object") return entry as CredentialValue
      } catch { /* try the next known auth path */ }
    }
  } catch { /* ignore */ }
  return undefined
}

/** 凭据 → 余额查询 token（oauth 用 access，api/key 用 key）。 */
export function credentialToken(value: CredentialValue | undefined): string {
  if (!value) return ""
  if (value.type === "oauth" && typeof value.access === "string") return value.access
  if ((value.type === "api" || value.type === "key") && typeof value.key === "string") return value.key
  return ""
}

/** 统一解析：宿主 SQLite active 凭据优先（V2 的唯一实时来源），auth.json 兜底。 */
export function resolveCredentialToken(providerID: string): string {
  return credentialToken(readDbCredential(providerID)) || credentialToken(readAuthJsonCredential(providerID))
}
