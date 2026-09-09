import { Extension, type Bus as AbcBus } from '@abc-protocol/sdk'
import type { BundledDeps } from './deps.js'
import { createBundledConfig } from './index.js'

export interface ServeBundledOpts extends BundledDeps {
  /** The abc bus to serve over (shared with the agent). */
  bus: AbcBus
}

/**
 * Serve the bundled extension in-process over an existing abc bus. Returns a
 * stop function. The server owns the bus lifecycle; this wires a BundledDeps
 * around the injected handles and calls serve() so the extension registers,
 * discovers and answers tool calls over the same bus as the agent.
 */
export function serveBundled(opts: ServeBundledOpts): () => void {
  let ext: Extension | null = null
  let closed = false
  const stop = () => {
    if (closed) return
    closed = true
    void ext?.close().catch(() => {})
  }
  void (async () => {
    try {
      ext = new Extension(opts.bus, createBundledConfig(opts))
      await ext.serve()
    } catch (e) {
      console.error('[bundled] failed to serve:', (e as Error)?.message ?? e)
    }
  })()
  return stop
}
