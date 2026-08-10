<div align="center">
<strong>
    <h1>OpenCode Visual Cache</h1>
    实时 Token 缓存命中率 · TUI 侧边栏可视化<br>
    自适应主题色 · 自动低饱和设计语言 · 支持中/英双语
</strong>
<br>
<br>
如果你觉得这个插件不错的话，可以帮我点点小星星 ⭐，谢谢！<br>
<br>

[![GitHub](https://img.shields.io/badge/GitHub-Repository-black?style=flat-square&logo=github)](https://github.com/Hotakus/opencode-visual-cache)
[![Stars](https://img.shields.io/github/stars/Hotakus/opencode-visual-cache?style=flat-square)](https://github.com/Hotakus/opencode-visual-cache/stargazers)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![English](https://img.shields.io/badge/English-README-blue?style=flat-square)](https://github.com/Hotakus/opencode-visual-cache/blob/master/README_EN.md)
![NPM Version](https://img.shields.io/npm/v/opencode-visual-cache?style=flat-square)

</div>

---

对 `子代理监控` 感兴趣吗？可以试试 [opencode-subagent-magazine](https://github.com/Hotakus/opencode-subagent-magazine) 这个插件！

---

## 1. 图片展示

<div align="center"> 
<strong>支持折叠，节省侧边栏占用👇</strong> <br>
<img src="https://raw.githubusercontent.com/Hotakus/opencode-visual-cache/master/assets/collapse.png"></img>
<img src="https://raw.githubusercontent.com/Hotakus/opencode-visual-cache/master/assets/collapse_en.png"></img>
</div>
<div align="center"> 
<strong>展开👇</strong> <br>
<img src="https://raw.githubusercontent.com/Hotakus/opencode-visual-cache/master/assets/expand.png"></img>
<img src="https://raw.githubusercontent.com/Hotakus/opencode-visual-cache/master/assets/expand_en.png"></img>
</div>


---
## 2. 功能

- **缓存命中率**：实时计算并显示缓存命中率，自适应宽度进度条
- **Token 明细**：缓存读 / 缓存写 / 未命中 / 输出，标签左对齐 · 数据右对齐
- **费用与节省**：Session 累计费用 + 缓存命中带来的费用节省
- **模型定价**：显示当前模型的输入 / 缓存读 / 缓存写单价（从 provider 配置动态读取）
- **折叠面板**：主标题默认折叠，点击展开；明细、模型、分布各自独立折叠
- **颜色自适应**：命中率 ≥85% 绿 · ≥70% 橙 · <70% 红，颜色从主题色自动去饱和
- **Token 分布**：按角色（系统提示 / 用户 / 子代理指令 / Tool 调用 / Tool 结果）展示估算 Token 占比
- **折叠记忆**：折叠状态持久化，重启后保持
- **语言适配**：支持 中文 / English / 日本語 / 한국어，自动检测系统语言，`/cache-lang` 运行时切换，偏好持久化优先
- **多币种**：通过 `/cache-currency` 切换货币，费用和节省同步换算
- **余额查询**：查询多家 AI 提供商的账户余额，支持自动切换跟随当前会话提供商
- **斜杠命令**：`/cache-session` `/cache-session-back` `/cache-rate` `/cache-section` `/cache-config` `/cache-lang` 动态配置面板
- **子代理缓存查看**：`/cache-session` 自动扫描并列出子代理，选择一个即可切换面板显示其缓存统计，支持 `/cache-session-back` 返回主会话
- **已加载技能**：检测 session 中 LLM 调用 `skill` tool 的记录，展示已加载技能名及估算 Token 占用
- **底部状态栏**：输入框提示行单行显示 命中率（含趋势）· Tokens · 余额，关闭侧边栏也能随时看到缓存统计，可经 `/cache-section` 隐藏

---

## 3. 安装

### 3.1 方式一：OpenCode 命令安装（推荐）

在 OpenCode 中按 **`Ctrl + P`** 打开命令面板，搜索 **`install plugin`**，输入：

```
opencode-visual-cache@latest
```

回车即可完成安装与配置。

### 3.2 方式二：手动安装

**1. 安装插件**

```bash
npm install -g opencode-visual-cache@latest
```

**2. 配置 TUI 插件**

创建或编辑 `~/.config/opencode/tui.jsonc`：

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-visual-cache@latest"]
}
```

### 3.3 重启 OpenCode

进入任意 session，侧边栏即可看到缓存统计面板。

---

## 4. 使用指南

### 4.1 斜杠命令

插件支持通过斜杠命令或命令面板（`Ctrl + P`）动态调整配置，所有设置即时生效并持久化：

| 命令 | 功能 | 使用方式 |
|------|------|---------|
| `/cache-session` | 查看子代理缓存统计 | 自动列出子代理供选择，或手动粘贴 Session ID 切换面板数据源 |
| `/cache-session-back` | 返回主会话统计 | 从子代理缓存视图切回主会话 |
| `/cache-currency` | 切换货币单位 | 从列表选择货币（USD / CNY / EUR / JPY / GBP / KRW），自动填入默认汇率 |
| `/cache-rate` | 调整汇率乘数 | 输入自定义汇率（如 `7.2`），用于费用换算 |
| `/cache-section` | 开关区块与边框 | 独立控制 Token 明细 / 模型与定价 / 估算 Token 分布 / 已加载技能 / 余额 / 底部状态栏 / 面板边框的显隐 |
| `/cache-config` | 查看当前配置 | 弹出当前货币、汇率、区块可见性状态 |
| `/cache-lang` | 切换显示语言 | 从列表选择中文或 English，界面即时切换，无需重启 |
| `/cache-balance` | 余额查询设置 | 选择余额提供商（菜单标注 Key 来源：用户 key / OpenCode / 未配置）/ 开关自动切换 |
| `/cache-balance-key` | 设置余额 API Key | 两步流程：选择提供商 → 输入 API Key |

<div align="center">
  <img src="https://raw.githubusercontent.com/Hotakus/opencode-visual-cache/master/assets/splash_cmd.png" alt="斜杠命令" width="49%"></img>
  <img src="https://raw.githubusercontent.com/Hotakus/opencode-visual-cache/master/assets/ctrlP_cmd.png" alt="Ctrl+P 命令面板" width="49%"></img>
</div>

切换货币时会自动填入离线内置的近似汇率（以 USD 为基准），用户可随时通过 `/cache-rate` 自定义。

### 4.2 货币与汇率

费用展示支持多币种切换：

| 货币代码 | 符号 | 默认汇率（1 USD = ?） |
|---------|------|---------------------|
| USD | `$` | 1 |
| CNY | `¥` | 7.2 |
| EUR | `€` | 0.92 |
| JPY | `JP¥` | 150 |
| GBP | `£` | 0.79 |
| KRW | `₩` | 1350 |

> 汇率会同步应用到 Session 累计费用、缓存节省金额、以及模型单价展示。
>
> **基币说明**：插件假设提供商定价均为美元（USD）。目前主流 AI API（OpenAI / Anthropic / Google / DeepSeek / xAI 等）的国际版均以 USD 计价。如果你使用的提供商以人民币或其他货币计价，请将汇率设为 `1`。

### 4.3 区块可见性

面板中的子区块可以独立关闭，方便在侧边栏空间紧张时隐藏不需要的信息：

- **Token 明细**：缓存读 / 缓存写 / 未命中 / 输出
- **模型与定价**：费用 / 提供商 / 模型名 / 单价
- **估算 Token 分布**：按角色拆分的 Token 估算
- **已加载技能**：session 中 LLM 实际调用过的 Skill 名及估算 Token 占用
- **余额**：当前提供商账户余额（多提供商 + 自动切换）
- **底部状态栏**：输入框提示行的 命中率 · Tokens · 余额 单行统计

通过 `/cache-section` 切换后即时生效，无需重启。此外，该命令还可以开关面板的**外边框**——关闭后内容会顶格显示，释放额外空间。

> **关于 Token 分布数值**：分布面板中"推理"为 API 返回的**精确值**；"系统提示"/"用户"/"子代理指令"/"Tool 调用"/"Tool 结果"为**估算值**——API 仅返回 token 总量，无法拆分各内容类型，插件按内容类型收集文本后基于字符计数近似估算，数值仅供参考。OpenCode 运行时注入的系统提示内容（环境信息、Skill 目录、工具 Schema 定义等，详见 [`system.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/system.ts)、[`tools.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/tools.ts)）不在此估算范围内。

### 4.4 余额查询

面板支持显示多家 AI 提供商的账户余额。开启**自动切换**后，余额查询会跟随当前会话正在使用的模型提供商自动切换。

已支持余额查询的提供商：

| 提供商 | 余额查询端点 | 币种 | Key 前缀 | 状态 |
|--------|-------------|------|---------|------|
| DeepSeek | `https://api.deepseek.com/user/balance` | CNY / USD | `sk-` | ✅ 已支持 |
| SiliconFlow | `https://api.siliconflow.cn/v1/user/info` | CNY | `sk-` | ✅ 已支持 |
| OpenRouter | `https://openrouter.ai/api/v1/credits` | USD | `sk-or-` | ✅ 已支持 |
| Moonshot | `https://api.moonshot.cn/v1/users/me/balance` | CNY | `sk-` | ✅ 已支持 |
| 智谱 GLM | 待接入（社区逆向端点，非官方） | CNY | — | ⏳ 希望支持 |
| xAI | 待接入（需 Management Key + Team ID） | USD | — | ⏳ 希望支持 |

> **Key 来源**：优先使用 `/cache-balance-key` 手动配置的 Key；未手动配置时自动复用 OpenCode 已认证的凭据（`/connect` 配置的 provider）。两者都没有的提供商无法查询余额。
>
> **Key 存储**：手动配置的 API Key 明文保存于插件持久化 KV，请勿在共享设备上使用。
>
> **自动切换**：默认开启；手动选择提供商后自动关闭，可在 `/cache-balance` 中重新开启。自动切换按当前会话的模型提供商匹配，未配置 Key 的提供商被选中时显示「未配置」提示。
>
> **希望支持**：已调研确认具备可行性的候选提供商，尚未实现。智谱 GLM 仅有社区逆向的非官方端点（无稳定性保障）。
>
> **统计口径**：命中率 = 缓存读 /（新鲜输入 + 缓存读 + 缓存写），与业界（OpenAI / Anthropic / Bedrock）口径一致；明细中「未命中」= 新鲜输入 + 缓存写。底部栏的 Tokens 为输入侧总量（不含输出）。未单独报告缓存写的提供商（如 DeepSeek）自动退化为 hit/miss 口径。
>
> **余额显示**：侧边栏与底部栏共享同一份余额数据，两处显示一致。当前提供商不支持余额查询时，侧边栏显示提示、底部栏隐藏余额项。

---

## 5. 更新

由于 [OpenCode 已知问题 #6774](https://github.com/anomalyco/opencode/issues/6774)，插件缓存会锁死在首次安装时的版本，不会自动检测 npm 上的新版本。

更新步骤：

**1. 清除 OpenCode 插件缓存**

```powershell
# Windows
Remove-Item -Recurse -Force "$env:USERPROFILE\.cache\opencode\packages\opencode-visual-cache@latest"
```

```bash
# macOS / Linux
rm -rf ~/.cache/opencode/packages/opencode-visual-cache@latest
```

**2. 重新安装插件**

在 OpenCode 中按 **`Ctrl + P`** → `install plugin` → `opencode-visual-cache@latest` → 回车

**3. 重启 OpenCode**

---

## 6. 语言设置

插件支持三种方式控制显示语言，按优先级从高到低排列：

### 6.1 运行时切换（推荐）

在 TUI 中输入 `/cache-lang`，从弹窗选择 中文 / English / 日本語 / 한국어 即可即时切换，无需重启。偏好会自动持久化，下次启动优先恢复用户选择。

### 6.2 环境变量覆盖

启动前设置 `CACHE_TUI_LANG` 环境变量可强制指定语言（`zh` / `en` / `ja` / `ko`）：

```powershell
# Windows PowerShell
$env:CACHE_TUI_LANG="en"; opencode
```

```bash
# macOS / Linux
CACHE_TUI_LANG=en opencode
```

### 6.3 自动检测

默认自动检测系统语言。若不符合预期，用 `/cache-lang` 手动切换一次即可，偏好会被记住。

---

## 7. 兼容性

代码完全模型无关，支持所有 OpenCode 兼容的 AI 模型（DeepSeek / Claude / GPT 等）。
Token 数据和定价信息均通过 OpenCode SDK 标准接口获取。

---

## 8. License

MIT
