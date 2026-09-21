import type { LanguageModel } from 'ai'

/** One entry of a bounded chain walk (depth 0 = the tip). */
export interface ChainEntry {
  id: string
  role: string
  createdAt: string
  depth: number
}

/** One persisted message part (raw JSON `data`, ordered by message + seq). */
export interface MessagePartRow {
  messageId: string
  type: string
  seq: number
  data: string
}

/**
 * The injected runtime surface the bundled extension relies on. Kept
 * STRUCTURAL (no import of agent source) so the bundled extension is a
 * standalone lib: the agent server supplies these at boot. This lets the
 * agent either serve it in-process (bundle) or omit it entirely.
 */
export interface BundledDeps {
  /** Resolve a provider/model reference to an AI SDK LanguageModel.
   *  `tenant` scopes the provider registry lookup (v2). */
  resolveModel: (
    db: unknown,
    modelId: string,
    tenant?: string,
  ) => Promise<{
    isOk: () => boolean
    isErr: () => boolean
    value?: { model: LanguageModel }
    error?: string
  }>
  /**
   * Resolve a GENERATION model (image / video / speech / transcription) from
   * the provider registry. `ref` is a canonical `provider_id/model_id`; the
   * agent builds the capability-specific AI-SDK model (ImageModelV4 /
   * Experimental_VideoModelV4 / SpeechModelV4 / TranscriptionModelV4) from
   * the provider's credentials. Errors name the missing knob so the caller
   * can surface it.
   */
  resolveGenerative: (
    capability: 'image' | 'video' | 'speech' | 'transcription',
    ref: string,
    tenant?: string,
  ) => Promise<{
    isOk: () => boolean
    isErr: () => boolean
    value?: { model: unknown; modelId: string; providerId: string }
    error?: string
  }>
  /** Resolve an effective config knob (session > global > default), scoped
   *  to the tenant. */
  resolveConfig: (
    name: string,
    sessionName?: string,
    tenant?: string,
  ) => Promise<unknown>
  /**
   * Read a session variable the agent projects (vars bucket, provider "agent")
   * e.g. `locale`. Returns undefined when unset. Used by tools that need the
   * session's effective locale.
   */
  getSessionVariable: (
    tenant: string,
    provider: string,
    sessionName: string,
    name: string,
  ) => Promise<string | undefined>
  /**
   * ---- Narrow data access over the HOST's stores ----
   *
   * The extension never speaks SQL: every operation it needs is a named,
   * typed method implemented by the host (which owns the schema). This keeps
   * the extension portable to any host that can serve these semantics —
   * including a remote extension server over the bus.
   */
  /** Group key of a session ('' = top-level; '' when the session is absent). */
  sessionGroup(tenant: string, sid: string): Promise<string>
  /** Does the session exist in this tenant? */
  sessionExists(tenant: string, sid: string): Promise<boolean>
  /** The session's tip message id ('' when it has no messages / is absent). */
  sessionTip(tenant: string, sid: string): Promise<string>
  /** Names of every session whose group equals [group] (subsessions). */
  sessionsInGroup(tenant: string, group: string): Promise<string[]>
  /**
   * O(1) fork: create [child] by copying [parent]'s inheritable columns,
   * sharing its tip (same chain) and setting the child's group to the
   * parent's name.
   */
  forkSession(tenant: string, parent: string, child: string): Promise<void>
  /** Remove a session row (cascade delete of a subsession). */
  deleteSessionRow(tenant: string, sid: string): Promise<void>
  /** Remove a session's queued mailbox rows. */
  deleteSessionMailbox(tenant: string, sid: string): Promise<void>
  /** Bounded chain walk from a tip, oldest-first with depth 0 at the tip. */
  messageChain(
    tenant: string,
    tip: string,
    limit: number,
  ): Promise<ChainEntry[]>
  /** Ordered parts (message_id, seq order) for the given message ids. */
  messageParts(tenant: string, ids: string[]): Promise<MessagePartRow[]>
  /** Ensure the bundled todo table exists (idempotent). */
  todosEnsure(): Promise<void>
  /** Replace a session's todo rows wholesale. */
  todosReplace(
    tenant: string,
    sid: string,
    rows: Array<{ content: string; status: string; priority: string }>,
  ): Promise<void>
  /**
   * Publish a durable mailbox message to a session. `type` is one of
   * `user_prompt` (triggers a turn), `event` (folded into context only) or
   * `interrupt`. Used by the subsession-create / mail-send tools to hand work to
   * another session and to wake a parent when a child finishes.
   */
  publishMailbox: (
    tenant: string,
    sessionName: string,
    type: string,
    payload: unknown,
  ) => Promise<void>
  /** Read a stored file blob (meta + bytes) by `file:<code>`, tenant-scoped. */
  blobGet: (
    code: string,
    tenant?: string,
  ) => Promise<{ meta: Record<string, unknown>; data: Uint8Array }>
  /**
   * Store generated media bytes (images/videos/audio) in the agent blob
   * store so they can be referenced as `file:<code>`. The content type is
   * DERIVED by the agent from the bytes; the returned `mime` is authoritative.
   */
  ingestBlob: (input: {
    /** base64-encoded media bytes. */
    bytes: string
    name: string
    session: string
    /** Isolation key the generated media belongs to (v2). */
    tenant?: string
  }) => Promise<{ code: string; mime: string; name: string }>
}

/** Narrow a `Record<string, unknown>` blob meta into a string map (structural). */
export function metaToObj(
  meta: Record<string, unknown>,
): Record<string, unknown> {
  return { ...meta }
}
