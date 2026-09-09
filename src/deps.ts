import type { LanguageModel } from 'ai'

/**
 * The injected runtime surface the bundled extension relies on. Kept
 * STRUCTURAL (no import of agent source) so the bundled extension is a
 * standalone lib: the agent server supplies these at boot. This lets the
 * agent either serve it in-process (bundle) or omit it entirely.
 */
export interface BundledDeps {
  /** Resolve a provider/model reference to an AI SDK LanguageModel. */
  resolveModel: (db: unknown, modelId: string) => Promise<{
    isOk: () => boolean
    isErr: () => boolean
    value?: { model: LanguageModel }
    error?: string
  }>
  /** Resolve an effective config knob (session > global > default). */
  resolveConfig: (name: string, sessionName?: string) => Promise<unknown>
  /** Raw SQL read (positional `?` for sqlite). Returns plain row records. */
  rawAll: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>
  /** Raw SQL write (DDL / INSERT / UPDATE / DELETE). */
  rawRun: (sql: string, params?: unknown[]) => Promise<void>
  /** Read a stored file blob (meta + bytes) by `file:<code>`. */
  blobGet: (code: string) => Promise<{ meta: Record<string, unknown>; data: Uint8Array }>
}
