// prepare-v2-publish.mjs
// 用法: node scripts/prepare-v2-publish.mjs <version>
// 改写 package.json 为 v2 (oc2) 版本：
//   - version = 指定版本（如 1.7.0-oc2）
//   - exports["./server"] → ./dist/v2.js（V2 加载器实测只认 ./server——无它会被静默跳过；
//     v2.js 是纯 {id, setup}，无 server 字段，不会触发 V1 路径）
//   - main/exports["."] 同样指向 v2.js（备用）
//   - peerDependencies 替换为 v2.js 实际运行时依赖（build.tui.mjs external: @opentui/*、solid-js）
// 其余字段（scripts/files/bin 等）原样保留。发布后由 git checkout HEAD -- package.json 恢复。
import { readFileSync, writeFileSync } from "fs"

const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+-oc2$/.test(version)) {
  console.error(`用法: node scripts/prepare-v2-publish.mjs <version>\n版本需形如 1.7.0-oc2，收到: ${version}`)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"))
pkg.version = version
pkg.main = "./dist/v2.js"
// V2 加载确认（2026-08-17）：exports["./tui"] → tui/index.js 是 npm 包名方式可行的关键
//（V2 认 ./tui 作为 TUI 入口）；"."/"./server" 指向 v2.js 会 Invalid（import.meta.resolve 缺陷）。
pkg.exports = {
  ".": "./dist/v2.js",
  "./server": "./dist/v2.js",
  "./tui": "./tui/index.js",
}
// 发布必须含 tui/index.js（V2 目录加载入口——resolveLocal 对目录解析 dir/tui）
if (!Array.isArray(pkg.files)) pkg.files = []
if (!pkg.files.includes("tui")) pkg.files.push("tui")
pkg.peerDependencies = {
  "@opentui/core": ">=0.2.0",
  "@opentui/solid": ">=0.2.0",
  "solid-js": ">=1.9.0",
}
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n")
console.log(`package.json 已改写: version=${version}, exports[./tui]=./tui/index.js, files+="tui"`)
