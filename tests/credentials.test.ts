import assert from "node:assert/strict"
import {
  credentialToken,
  findCredentialDbPath,
  parseCredentialValue,
  resolveCredentialToken,
} from "../src/v2/credentials"

// oauth（OpenAI / Google 等）→ access token
assert.equal(
  credentialToken(parseCredentialValue(JSON.stringify({ type: "oauth", access: "eyJ.token", refresh: "r" }))),
  "eyJ.token",
)

// api key（DeepSeek / OpenRouter 等）→ key
assert.equal(
  credentialToken(parseCredentialValue(JSON.stringify({ type: "api", key: "sk-test" }))),
  "sk-test",
)

// 无效输入 / 缺 token → undefined 或空串
assert.equal(parseCredentialValue("not json"), undefined)
assert.equal(parseCredentialValue(""), undefined)
assert.equal(parseCredentialValue(JSON.stringify({ type: "oauth" })), undefined)
assert.equal(parseCredentialValue(JSON.stringify({ type: "oauth", access: "" })), undefined)
assert.equal(credentialToken(undefined), "")
assert.equal(credentialToken({ type: "oauth" }), "")

// 库路径解析：OPENCODE_DB 优先，其次 XDG_DATA_HOME，最后 ~/.local/share
assert.equal(findCredentialDbPath({ HOME: "/h" }, "/h"), "/h/.local/share/opencode/opencode.db")
assert.equal(findCredentialDbPath({ HOME: "/h", XDG_DATA_HOME: "/x" }, "/h"), "/x/opencode/opencode.db")
assert.equal(findCredentialDbPath({ HOME: "/h", OPENCODE_DB: "/custom/db" }, "/h"), "/custom/db")

// Node 环境（bun:sqlite 不可用）：解析静默回退，不抛异常
assert.equal(resolveCredentialToken("provider-que-nao-existe"), "")

console.log("V2 credential resolution tests passed")
