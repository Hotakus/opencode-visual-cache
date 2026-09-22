import type { Plugin, PluginModule } from "@opencode-ai/plugin"

const server: Plugin = async () => ({})

/**
 * V2 (opencode2) requires the default export to expose an `id` plus a
 * `setup` (or `effect`) function. This plugin has no server-side behavior,
 * so an empty setup keeps the module schema-valid and active on V2 while the
 * `server` field stays for V1 detection.
 */
const setup = async () => {}

const mod: PluginModule & { setup: () => Promise<void> } = {
  id: "opencode-visual-cache",
  server,
  setup,
}

export default mod
