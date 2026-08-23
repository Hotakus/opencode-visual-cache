/**
 * Token distribution breakdown for a session round.
 * Pure data model shared by V1/V2 shells.
 */
export interface TokenDist {
  system: number   // UserMessage.system
  user: number     // user message text/file parts
  agent: number    // task tool input prompt/description (sub-agent delegation)
  toolCall: number // ToolPart.input (actual tool params)
  toolResult: number // ToolPart completed output / error
  output: number   // AssistantMessage.tokens.output (API exact, reasoning excluded)
  reasoning: number // AssistantMessage.tokens.reasoning (API exact)
  apiOutput: number // StepFinishPart.tokens.output (API exact, preferred)
  apiInput: number  // API exact total input context (input + cache read + cache write)
  stepCost: number  // last step-finish part cost (USD) in the current round
  stepCount: number // step-finish parts count across the current round (parentID chain)
}
