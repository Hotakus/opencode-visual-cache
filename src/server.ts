import type { Plugin, PluginModule } from "@opencode-ai/plugin"

const server: Plugin = async () => ({})

const mod: PluginModule = {
  id: "opencode-visual-cache",
  server,
}

export default mod
