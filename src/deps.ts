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
  /**
   * Resolve a GENERATION model (image / video / speech) from the provider
   * registry. `ref` is a canonical `provider_id/model_id`; the agent builds
   * the capability-specific AI-SDK model (ImageModelV4 /
   * Experimental_VideoModelV4 / SpeechModelV4) from the provider's
   * credentials. Errors name the missing knob so the caller can surface it.
   */
  resolveGenerative: (
    capability: 'image' | 'video' | 'speech',
    ref: string,
  ) => Promise<{
    isOk: () => boolean
    isErr: () => boolean
    value?: { model: unknown; modelId: string; providerId: string }
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
  /**
   * Store generated media bytes (images/videos/audio) in the agent blob
   * store so they can be referenced as `file:<code>`. Returns the stored
   * record's code + mime.
   */
  ingestBlob: (input: {
    /** base64-encoded media bytes. */
    bytes: string
    name: string
    mime: string
    session: string
  }) => Promise<{ code: string; mime: string }>
}

/** Narrow a `Record<string, unknown>` blob meta into a string map (structural). */
export function metaToObj(meta: Record<string, unknown>): Record<string, unknown> {
  return { ...meta }
}
