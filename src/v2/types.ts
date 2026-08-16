/**
 * V2 (opencode2) TUI plugin API — 最小本地类型（实验版）。
 * 运行时由 opencode2 提供，此处仅用于本地类型检查；
 * 结构对应 v2 分支 packages/plugin/src/tui/context.ts。
 */

export interface App {
  readonly version: string
  readonly channel: string
}

export interface Theme {
  readonly text: {
    readonly default: string
    readonly subdued: string
    readonly feedback: {
      readonly success: { readonly default: string }
      readonly error: { readonly default: string }
      readonly warning: { readonly default: string }
    }
  }
}

/** token 用量：结构与 V1 的 message.tokens 同构，字段以运行时实际数据为准。 */
export interface TokenUsage {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

export interface MessageInfo {
  readonly id: string
  readonly type: string
  readonly agent?: string
  readonly model?: string
  readonly time: { readonly created: number; readonly completed?: number }
  readonly cost?: unknown
  readonly tokens?: TokenUsage
  readonly content?: unknown[]
}

export interface SessionInfo {
  readonly id: string
  readonly title?: string
  readonly time?: { readonly created: number; readonly updated: number }
  readonly model?: string
  readonly agent?: string
  readonly parentID?: string
}

export interface Data {
  readonly session: {
    get(sessionID: string): SessionInfo | undefined
    list(): SessionInfo[]
    cost(sessionID: string): number
    status(sessionID: string): string
    readonly message: {
      list(sessionID: string): MessageInfo[]
      sync(sessionID: string): Promise<void>
    }
  }
  readonly location: {
    readonly provider: { list(location?: unknown): unknown[] }
    readonly model: { list(location?: unknown): unknown[] }
    readonly mcp: { readonly server: { list(location?: unknown): unknown[] } }
  }
  readonly on: (type: string, handler: (event: unknown) => void) => () => void
  readonly listen: (handler: (event: unknown) => void) => () => void
}

export interface Storage {
  store<Value extends object>(
    key: string,
    options: { readonly initial: Value },
  ): readonly [Value, (mutation: (draft: Value) => void) => Promise<void>]
  memory<Value extends object>(
    key: string,
    options: { readonly initial: Value },
  ): readonly [Value, (mutation: (draft: Value) => void) => void]
}

export type SlotClaim = {
  readonly render: (input: Record<string, any>) => unknown
} & (
  | { readonly append: string; readonly prepend?: never; readonly before?: never; readonly after?: never; readonly replace?: never }
  | { readonly prepend: string; readonly append?: never; readonly before?: never; readonly after?: never; readonly replace?: never }
  | { readonly before: string; readonly append?: never; readonly prepend?: never; readonly after?: never; readonly replace?: never }
  | { readonly after: string; readonly append?: never; readonly prepend?: never; readonly before?: never; readonly replace?: never }
  | { readonly replace: string; readonly append?: never; readonly prepend?: never; readonly before?: never; readonly after?: never }
)

export interface KeymapCommand {
  readonly id?: string
  readonly title?: string
  readonly description?: string
  readonly group?: string
  readonly palette?: true
  readonly slash?: { readonly name: string; readonly aliases?: string[]; readonly arguments?: true }
  /** 旧字段（opencode-dcp 兼容写法：palette 可见性 + slash 补全依赖它们） */
  readonly namespace?: string
  readonly name?: string
  readonly desc?: string
  readonly category?: string
  readonly slashName?: string
  readonly slashAliases?: string[]
  readonly run: (input?: string) => void | false | Promise<void>
}

export interface Context {
  readonly app: App
  readonly options: Record<string, any>
  readonly location: { readonly directory?: string } | undefined
  readonly renderer: { readonly terminalWidth: number }
  readonly theme: Theme
  readonly data: Data
  readonly storage: Storage
  readonly ui: {
    slot(claim: SlotClaim): () => void
    readonly toast: {
      show(options: { readonly message: string; readonly title?: string; readonly variant?: string }): void
    }
    readonly dialog: {
      prompt(options: { readonly title: string; readonly message?: string }): Promise<string | undefined>
      select<Value>(options: {
        readonly title: string
        readonly placeholder?: string
        readonly options: readonly {
          readonly title: string
          readonly value: Value
          readonly description?: string
          readonly category?: string
          readonly disabled?: boolean
        }[]
        readonly current?: Value
      }): Promise<Value | undefined>
    }
  }
  readonly keymap: {
    layer(input: () => { readonly commands?: readonly KeymapCommand[] }): void
    shortcuts(id: string): readonly string[]
  }
}

export type PluginModule = {
  readonly id: string
  readonly setup: (context: Context) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>
}
