// tui/index.js——V1/V2 共用入口（双格式）
// - V1（opencode）：exports["./tui"] → 本文件——readV1Plugin 读 tui 字段（V1 面板）
// - V2（opencode2）：exports["./tui"] → 本文件——isPlugin 读 setup 字段（V2 面板）
import tuiMod from "./../dist/tui.js"
import v2Mod from "./../dist/v2.js"

export default {
  id: "opencode-visual-cache",
  tui: tuiMod.tui,
  setup: v2Mod.setup,
}

