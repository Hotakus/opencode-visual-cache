<div align="center">
<strong>
    <h1>OpenCode Visual Cache</h1>
    Real-time Token Cache Hit Rate · TUI Sidebar Visualization<br>
    Adaptive Theme Colors · Auto-desaturated · Chinese / English
</strong>
<br>
<br>
If you find this plugin useful, a ⭐ would mean a lot — thank you!<br>
<br>

[![GitHub](https://img.shields.io/badge/GitHub-Repository-black?style=flat-square&logo=github)](https://github.com/Hotakus/opencode-visual-cache)
[![Stars](https://img.shields.io/github/stars/Hotakus/opencode-visual-cache?style=flat-square)](https://github.com/Hotakus/opencode-visual-cache/stargazers)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![中文](https://img.shields.io/badge/中文-README-blue?style=flat-square)](https://github.com/Hotakus/opencode-visual-cache/blob/master/README.md)
![NPM Version](https://img.shields.io/npm/v/opencode-visual-cache?style=flat-square)

</div>

---

Interested in sub-agent monitoring? Check out [opencode-subagent-magazine](https://github.com/Hotakus/opencode-subagent-magazine)!

---

## 1. Screenshots

<div align="center">
<strong>Collapsed 👇</strong> <br>
<img src="https://raw.githubusercontent.com/Hotakus/opencode-visual-cache/master/assets/collapse.png"></img>
<img src="https://raw.githubusercontent.com/Hotakus/opencode-visual-cache/master/assets/collapse_en.png"></img>
</div>
<div align="center">
<strong>Expanded 👇</strong> <br>
<img src="https://raw.githubusercontent.com/Hotakus/opencode-visual-cache/master/assets/expand.png"></img>
<img src="https://raw.githubusercontent.com/Hotakus/opencode-visual-cache/master/assets/expand_en.png"></img>
</div>

---

## 2. Features

- **Cache Hit Rate**: Real-time hit rate with adaptive-width progress bar and trend indicator
- **Token Detail**: Cache read / write / miss / output, left-aligned labels, right-aligned values
- **Cost & Savings**: Session cumulative cost plus cache-hit savings
- **Model Pricing**: Input / cache-read / cache-write per-million rates (read from provider config dynamically)
- **Collapsible**: Main title collapsed by default; click to expand. Detail, model, and distribution sections fold independently
- **Adaptive Colors**: ≥85% green · ≥70% orange · <70% red, auto-desaturated from current theme
- **Token Distribution**: Per-role (system / user / agent instr / tool call / tool result) estimated token breakdown
- **Persistent State**: Fold preferences and config remembered across restarts via api.kv
- **Language**: Auto-detects system locale, with `/cache-lang` for runtime switching between Chinese and English — preference persisted across restarts
- **Multi-currency**: Switch via `/cache-currency` — costs, savings, and per-million rates convert in real time
- **Balance Query**: Query account balance across multiple AI providers, with auto-switch following the current session's provider
- **Slash Commands**: `/cache-session` `/cache-session-back` `/cache-rate` `/cache-section` `/cache-config` `/cache-lang` for live panel configuration
- **Sub-Agent Cache View**: `/cache-session` auto-scans and lists sub-agents; select one to switch the panel stats. Use `/cache-session-back` to return to the main session
- **Loaded Skills**: Detects `skill` tool calls in the session and displays loaded skill names with estimated token footprint

---

## 3. Installation

### 3.1 Option 1: OpenCode Command (recommended)

Press **`Ctrl + P`** in OpenCode to open the command palette, search **`install plugin`**, then type:

```
opencode-visual-cache@latest
```

Press Enter to install and configure automatically.

### 3.2 Option 2: Manual

**1. Install the plugin**

```bash
npm install -g opencode-visual-cache@latest
```

**2. Configure TUI plugin**

Create or edit `~/.config/opencode/tui.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-visual-cache@latest"]
}
```

### 3.3 Restart OpenCode

Open any session — the cache stats panel appears in the sidebar.

---

## 4. Usage Guide

### 4.1 Slash Commands

The plugin supports slash commands and command palette (`Ctrl + P`) for runtime configuration. All changes take effect immediately and are persisted:

| Command | Function | How to use |
|---------|----------|------------|
| `/cache-session` | View sub-agent cache stats | Lists sub-agents automatically, or paste a Session ID to switch the panel data source |
| `/cache-session-back` | Return to main session | Switch back to main session from sub-agent cache view |
| `/cache-currency` | Switch currency | Pick from a list (USD / CNY / EUR / JPY / GBP / KRW); default exchange rate auto-filled |
| `/cache-rate` | Adjust exchange rate | Enter a custom rate (e.g. `7.2` for CNY) |
| `/cache-section` | Toggle sections & border | Independently show/hide Detail, Model & Pricing, Token Distribution, Loaded Skills, Balance, or the panel border |
| `/cache-config` | View current config | Displays currency, rate, and section visibility |
| `/cache-lang` | Switch display language | Pick Chinese or English from the dialog — takes effect immediately, no restart needed |
| `/cache-balance` | Balance query settings | Pick a balance provider (menu shows key source: user key / OpenCode / not set) / toggle auto-switch |
| `/cache-balance-key` | Set balance API key | Two-step flow: pick a provider → enter the API key |

<div align="center">
  <img src="https://raw.githubusercontent.com/Hotakus/opencode-visual-cache/master/assets/splash_cmd.png" alt="Slash command" width="49%"></img>
  <img src="https://raw.githubusercontent.com/Hotakus/opencode-visual-cache/master/assets/ctrlP_cmd.png" alt="Ctrl+P command palette" width="49%"></img>
</div>

Switching currency automatically applies a built-in approximate exchange rate (USD-based). Override it anytime with `/cache-rate`.

### 4.2 Currency & Exchange Rate

Cost display supports multiple currencies:

| Code | Symbol | Default rate (1 USD = ?) |
|------|--------|-------------------------|
| USD | `$` | 1 |
| CNY | `¥` | 7.2 |
| EUR | `€` | 0.92 |
| JPY | `JP¥` | 150 |
| GBP | `£` | 0.79 |
| KRW | `₩` | 1350 |

> The rate applies to session cost, cache savings, and per-million pricing — consistently across the panel.
>
> **Base currency**: The plugin assumes all provider pricing is in USD. Major AI APIs (OpenAI / Anthropic / Google / DeepSeek / xAI etc.) use USD for their international endpoints. If your provider bills in CNY or another currency, set the exchange rate to `1`.

### 4.3 Section Visibility

Three sub-sections can be toggled independently to save sidebar space:

- **Token Detail**: cache read / write / miss / output
- **Model & Pricing**: cost / provider / model name / per-million rates
- **Estimated Token Dist.**: per-role token breakdown
- **Loaded Skills**: skill names the LLM actually loaded via the `skill` tool, with estimated token counts
- **Balance**: the selected provider's account balance (multi-provider with auto-switch)

Toggled via `/cache-section` — takes effect instantly, no restart required. The same command also toggles the panel **border**; turning it off removes the outline and padding so content fills the full width.

### 4.4 Balance Query

The panel can display account balance from multiple AI providers. With **auto-switch** enabled, the balance query follows the model provider of the current session automatically.

Supported balance providers:

| Provider | Balance endpoint | Currency | Key prefix | Status |
|----------|-----------------|----------|------------|--------|
| DeepSeek | `https://api.deepseek.com/user/balance` | CNY / USD | `sk-` | ✅ Supported |
| SiliconFlow | `https://api.siliconflow.cn/v1/user/info` | CNY | `sk-` | ✅ Supported |
| OpenRouter | `https://openrouter.ai/api/v1/credits` | USD | `sk-or-` | ✅ Supported |
| Moonshot | `https://api.moonshot.cn/v1/users/me/balance` | CNY | `sk-` | ✅ Supported |
| Zhipu GLM | Pending (community-reversed endpoint, unofficial) | CNY | — | ⏳ Planned |
| xAI | Pending (requires Management Key + Team ID) | USD | — | ⏳ Planned |

> **Key source**: a key set manually via `/cache-balance-key` takes priority; otherwise the plugin reuses the credential OpenCode already authenticated (`/connect`-configured providers). Providers with neither cannot show a balance.
>
> **Key storage**: manually configured API keys are stored in plaintext in the plugin's persistent KV — avoid using on shared devices.
>
> **Auto-switch**: enabled by default; picking a provider manually disables it — re-enable anytime via `/cache-balance`. Auto-switch matches the current session's model provider; a provider without a key shows a "not set" hint when selected.
>
> **Planned**: candidates confirmed feasible by research, not yet implemented. Zhipu GLM only has a community-reversed unofficial endpoint (no stability guarantee).

---

## 5. Update

Due to a [known OpenCode issue #6774](https://github.com/anomalyco/opencode/issues/6774), the plugin cache locks to the version installed at first setup and does **not** auto-detect newer releases on npm.

To update:

**1. Clear the OpenCode plugin cache**

```powershell
# Windows
Remove-Item -Recurse -Force "$env:USERPROFILE\.cache\opencode\packages\opencode-visual-cache@latest"
```

```bash
# macOS / Linux
rm -rf ~/.cache/opencode/packages/opencode-visual-cache@latest
```

**2. Re-install the plugin**

Press **`Ctrl + P`** in OpenCode → `install plugin` → `opencode-visual-cache@latest` → Enter

**3. Restart OpenCode**

---

## 6. Language Settings

The plugin provides three ways to control the display language, listed by priority (highest first):

### 6.1 Runtime Switching (recommended)

Type `/cache-lang` in the TUI and select **Chinese** or **English** from the dialog. The panel switches immediately without restarting, and your preference is persisted automatically for the next session.

### 6.2 Environment Variable Override

Set the `CACHE_TUI_LANG` environment variable before launching to force a specific language:

```powershell
# Windows PowerShell
$env:CACHE_TUI_LANG="en"; opencode
```

```bash
# macOS / Linux
CACHE_TUI_LANG=en opencode
```

### 6.3 Auto Detection

Defaults to the system locale automatically. If it doesn't match, switch once with `/cache-lang` and the preference will be remembered.

---

## 7. Compatibility

Model-agnostic — works with all OpenCode-compatible AI models (DeepSeek / Claude / GPT etc.).
Token data and pricing are read via OpenCode SDK standard interfaces.

---

## 8. License

MIT
