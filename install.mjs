#!/usr/bin/env node

/**
 * Install script for @kilng235/opencode-visual-cache.
 *
 * Creates or updates `~/.config/opencode/opencode.jsonc` so OpenCode V2 loads
 * the TUI sidebar plugin via the `plugins` array.
 *
 * Usage:
 *   node install.mjs
 *   npm explore @kilng235/opencode-visual-cache -- node install.mjs
 */

import { readFile, writeFile, mkdir, access } from "node:fs/promises"
import { constants } from "node:fs"
import { homedir, platform } from "node:os"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLUGIN_SPEC = "@kilng235/opencode-visual-cache@latest"

function configDir() {
  if (platform() === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "opencode")
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode")
}

async function exists(p) {
  try { await access(p, constants.F_OK); return true }
  catch { return false }
}

async function readJSONC(p) {
  const raw = await readFile(p, "utf-8")
  // Strip single-line comments (//) outside strings — simple heuristic.
  const stripped = raw.replace(/^\s*\/\/.*$/gm, "")
  return JSON.parse(stripped)
}

function formatJSONC(obj) {
  return JSON.stringify(obj, null, 2) + "\n"
}

/** Merge plugin into an existing `plugins` array, avoiding duplicates. */
function mergePlugin(existing, spec) {
  const plugins = existing.plugins ?? []
  if (plugins.some((p) => (typeof p === "string" ? p : p.package ?? p[0]) === spec)) {
    return false // already present
  }
  existing.plugins = [...plugins, spec]
  return true
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const dir = configDir()
  await mkdir(dir, { recursive: true })

  const cfgPath = join(dir, "opencode.jsonc")
  let changed = false

  if (await exists(cfgPath)) {
    const cfg = await readJSONC(cfgPath)
    changed = mergePlugin(cfg, PLUGIN_SPEC)
    if (changed) {
      await writeFile(cfgPath, formatJSONC(cfg))
      console.log(`[opencode-visual-cache] Added to ${cfgPath}`)
    } else {
      console.log(`[opencode-visual-cache] Already in ${cfgPath}`)
    }
  } else {
    const cfg = {
      $schema: "https://opencode.ai/config.json",
      plugins: [PLUGIN_SPEC],
    }
    await writeFile(cfgPath, formatJSONC(cfg))
    console.log(`[opencode-visual-cache] Created ${cfgPath}`)
    changed = true
  }

  if (changed) {
    console.log("\nDone! Restart OpenCode to see the Token Cache sidebar panel.")
  } else {
    console.log("\nAlready installed. Restart OpenCode if you haven't yet.")
  }
}

main().catch((err) => {
  console.error("Install failed:", err.message)
  process.exit(1)
})