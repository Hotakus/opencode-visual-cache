import assert from "node:assert/strict"
import { createMemo, createRoot } from "solid-js"
import { createPanelApi } from "../src/v2/v2-panel-api"

// Run with `npm run test:adapter`. solid-js is reactive only in its browser build, hence `--conditions=browser`.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const row = (id: string, parent_id: string | null, output: number) => ({ id, parent_id, title: id, agent: null, model: null, cost: 0, tokens_input: 0, tokens_output: output, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0 })

/** A fake host. `read` stands for the database statement, `sync` for the server request of the records fallback. */
function host(read: (id: string) => unknown[] | undefined, sync?: (id: string) => Promise<void>) {
  const handlers = new Map<string, (e: unknown) => void>()
  const store = new Map<string, unknown>()
  const reads: string[] = []
  const session = { list: () => [...store.values()], get: (id: string) => store.get(id), sync, message: { list: () => [] } }
  const on = (type: string, handler: (e: unknown) => void) => { handlers.set(type, handler); return () => handlers.delete(type) }
  const context: any = { renderer: { terminalWidth: 80 }, data: { session, on } }
  const api = createPanelApi(context, { ready: async () => {}, read: (id: string) => { reads.push(id); return read(id) as any } })
  /** One consumer, as the footer and the panel are: a memo over the snapshot, shown as sorted `id=output` pairs. */
  const watch = (rootId: string) => {
    let rows!: () => string | undefined, stop!: () => void
    createRoot((dispose) => { stop = dispose; rows = createMemo(() => api.state.session.subtree?.(rootId)?.map((s) => s.id + "=" + s.tokens?.output).sort().join()) })
    return { rows, stop }
  }
  return { api, store, reads, watch, emit: (type: string, e: unknown = {}) => handlers.get(type)?.(e) }
}

// 1. The last event arrives before its commit and no event follows: the committed value is shown about a second later, the event's own value (99) never.
{
  let output = 5
  const h = host(() => [row("r", null, 1), row("k", "r", output)])
  const w = h.watch("r")
  await sleep(0)
  assert.equal(w.rows(), "k=5,r=1")
  h.emit("session.usage.updated", { data: { sessionID: "k", cost: 0, tokens: { input: 0, output: 99, reasoning: 0, cache: { read: 0, write: 0 } } } })
  await sleep(300)
  assert.equal(w.rows(), "k=5,r=1")
  output = 9
  await sleep(1000)
  assert.equal(w.rows(), "k=9,r=1")
  h.api.dispose(); w.stop()
  console.log("ok 1 - late commit")
}

// 2. The database decides, also about a deleted session: its row is shown while the database returns it. A read that fails is kept for the refresh, so the second consumer does not read again, and the rows kept from before lose the deleted session.
{
  let fail = false
  const h = host((id) => (fail ? undefined : [row(id, null, 1), row(id + "k", id, 2)]))
  const a = h.watch("a")
  await sleep(0)
  h.emit("session.deleted", { properties: { sessionID: "ak" } }); await sleep(300)
  assert.equal(a.rows(), "a=1,ak=2")
  fail = true; h.reads.length = 0
  const b1 = h.watch("b"), b2 = h.watch("b")
  assert.deepEqual([b1.rows(), b2.rows(), h.reads], [undefined, undefined, ["b"]])
  await sleep(1000)
  assert.equal(a.rows(), "a=1")
  h.api.dispose(); a.stop(); b1.stop(); b2.stop()
  console.log("ok 2 - failed read shared")
}

// 3. Records fallback (no database). A sync that keeps failing is tried once more a second later and not again; without a consumer nothing is sent, and a consumer that comes back starts the walk again.
{
  const tree = [["r", undefined, 1], ["k", "r", 2], ["g", "k", 3]] as const
  const synced: string[] = []
  let down = true, release = () => {}
  const h = host(() => undefined, async (id) => {
    synced.push(id)
    if (id === "k") { if (down) throw new Error("offline"); await new Promise<void>((ok) => { release = ok }) }
    // like the host's sync with children: the session's record and those of its direct children
    for (const [sid, parentID, output] of tree) if (sid === id || parentID === id) h.store.set(sid, { id: sid, parentID, tokens: { output } })
  })
  let w = h.watch("r"); await sleep(300); w.stop(); await sleep(1100)
  assert.deepEqual(synced, ["r", "k"])
  w = h.watch("r"); await sleep(1400)
  assert.deepEqual([synced, w.rows()], [["r", "k", "k", "k"], "k=2,r=1"])
  down = false; h.emit("session.usage.updated"); await sleep(300)
  w.stop(); release(); await sleep(300)
  assert.deepEqual([synced, h.store.has("g")], [["r", "k", "k", "k", "k"], true])
  h.api.dispose()
  console.log("ok 3 - records fallback")
}

// 4. The real panel, compiled as the build compiles it and drawn by OpenTUI's test renderer: Model > Cost is the viewed session's own cost, the detail rows count its sub-agents too.
{
  const h = host(() => [{ ...row("r", null, 111), cost: 70.71 }, { ...row("k", "r", 222), cost: 400.2 }])
  await sleep(50)
  const esbuild = await import("esbuild"), { solidPlugin } = await import("esbuild-plugin-solid"), { testRender } = await import("@opentui/solid")
  // same settings as build.tui.mjs; the output goes where neither git nor the package sees it
  await esbuild.build({ entryPoints: ["src/panel/TokenCachePanel.tsx"], outfile: "node_modules/.cache/panel-test.js", format: "esm", platform: "node", bundle: true, external: ["@opencode-ai/*", "@opentui/*", "solid-js"], plugins: [solidPlugin({ solid: { moduleName: "@opentui/solid", generate: "universal" } })] })
  const { TokenCachePanel } = await import("../node_modules/.cache/panel-test.js")
  // stand-ins for the host: every section shown and open, no provider, no balance
  const signals: any = new Proxy({}, { get: (_t, k) => (String(k).startsWith("set") ? () => {} : String(k).startsWith("section") ? () => true : k === "langCode" ? () => "en" : k === "balanceState" ? () => ({ status: "idle", data: [{ currency: "USD", total: "0" }] }) : () => undefined) })
  const api: any = h.api; api.kv = { get: (k: string, d: unknown) => (k.endsWith(".open") ? true : d), set: () => {} }
  Object.defineProperty(api.state, "provider", { value: [] })
  const ui = await testRender(() => TokenCachePanel({ api, signals, sessionId: "r", theme: { primary: "#0000ff", text: "#ffffff", textMuted: "#888888", success: "#00ff00", warning: "#ffff00", error: "#ff0000", border: "#888888" } }), { width: 80, height: 80 })
  await ui.flush(); await ui.renderOnce()
  const frame = ui.captureCharFrame()
  // destroy the renderer first: while it is alive a failed assertion still ends the process with exit code 0
  try { assert.match(frame, /Cost: +\$70\.71/); assert.match(frame, /Out: +333 tok/) } finally { ui.renderer.destroy(); h.api.dispose() }
  console.log("ok 4 - panel cost")
}
