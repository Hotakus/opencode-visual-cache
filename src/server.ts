import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import v2Mod from "./v2/index"

// V1 server 插件（空实现，保持原行为）；V2 经 exports["./server"] 加载此入口，
// 需要 default.setup——此处复用 v2 的 setup，一个入口同时满足 V1（server）与 V2（setup）。
const server: Plugin = async () => ({})

const mod: PluginModule & { setup: typeof v2Mod.setup } = {
  id: "opencode-visual-cache",
  server,
  setup: v2Mod.setup,
}

export default mod
