// ── token estimation ──
// Character-based BPE approximation.  Default ratios (~4 ASCII or ~1.5 CJK
// chars per token) work well for natural language but systematically
// under-count tokens in JSON and source code where every punctuation mark
// tends to be its own token.  Detect these cases and tighten the ratio.
// See: GPT-4 / Claude tokenizer behaviour with structured text.

export function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0
  let ascii = 0
  let cjk = 0
  for (const c of text) {
    const code = c.codePointAt(0) ?? 0
    if (code >= 0x4E00 && code <= 0x9FFF) cjk++       // CJK Unified
    else if (code >= 0x3040 && code <= 0x30FF) cjk++   // Hiragana/Katakana
    else if (code >= 0xAC00 && code <= 0xD7A3) cjk++   // Hangul
    else if (code >= 0x1100 && code <= 0x11FF) cjk++   // Hangul Jamo
    else if (code >= 0x2E80 && code <= 0x2EFF) cjk++   // CJK Radicals
    else ascii++
  }

  // Real BPE tokenizers (cl100k_base, o200k_base) average ~3.5-4.0
  // ASCII chars/token for both JSON and source code — close to prose.
  // The old 2.0 / 2.5 ratios matched minified-JS extremes, not typical
  // payloads, and systematically over-estimated token counts.
  const trimmed = text.trimStart()
  // Strip markdown code-fence prefix so that ```json … is detected as JSON
  const strippedFence = trimmed.replace(/^\x60{3}\w*\s*\n?/, "")
  const jsonLike = (strippedFence.startsWith("{") || strippedFence.startsWith("["))
    && /"[^"]+"\s*:/.test(text)
  const codeLike = !jsonLike
    && /```|^import |^export |^function |^const |^let |^var |^class |^interface |^type |^def |^fn |^pub |^use |^mod |^package /m.test(text)

  const asciiPerToken = jsonLike ? 3.5 : codeLike ? 3.5 : 4
  return Math.max(1, Math.ceil(ascii / asciiPerToken + cjk / 1.0))
}
