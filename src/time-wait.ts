/**
 * The `time-wait` tool: block the turn for a fixed number of seconds.
 *
 * It is deliberately NOT a shell `sleep` — the agent runs every command as a
 * tracked background job, so a shell sleep would return immediately while the
 * job kept running. This blocks the tool call itself, which is what "wait
 * before the next step" means here.
 *
 * Bounds:
 *   - `seconds` is clamped to [1, 590]. 590 (not 600) leaves a safety margin
 *     under the agent's fixed 600s per-tool deadline (TOOL_TIMEOUT_MS), so the
 *     wait always returns normally instead of being pre-empted by the agent.
 *   - The wait is ABORTABLE: the injected AbortSignal (user interrupt /
 *     session delete) cancels it immediately.
 */
import { numArg, type ToolSpec } from '@abc-protocol/sdk'
import type { BundledDeps } from './deps.js'
import { localeOf, tr } from './i18n.js'

/** Hard upper bound, below the agent's 600s tool deadline. */
export const TIME_WAIT_MAX_SECONDS = 590

/** Clamp a requested duration to [1, TIME_WAIT_MAX_SECONDS]. */
export function clampSeconds(raw: number): number {
  if (!Number.isFinite(raw)) return 1
  return Math.max(1, Math.min(Math.floor(raw), TIME_WAIT_MAX_SECONDS))
}

/** Build the `time-wait` execute handler bound to [deps]. */
export function timeWaitExecutes(
  deps: BundledDeps,
): Record<string, ToolSpec['execute']> {
  const timeWait: ToolSpec['execute'] = async (
    args,
    _callId,
    sessionName,
    signal,
    tenant = '',
  ) => {
    const locale = await localeOf(deps, tenant, sessionName)
    const seconds = clampSeconds(numArg(args, 'seconds') ?? 1)

    await new Promise<void>(resolve => {
      if (signal?.aborted) return resolve()
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = () => {
        if (timer !== undefined) clearTimeout(timer)
        resolve()
      }
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, seconds * 1000)
      signal?.addEventListener('abort', onAbort, { once: true })
    })

    if (signal?.aborted) {
      // Interrupted mid-wait: surface it as a tool error so the model knows the
      // wait did not complete (rather than a normal "waited N seconds").
      throw new Error(tr(locale, 'timeWaitInterrupted'))
    }
    return {
      content: tr(locale, 'timeWaited', { n: seconds }),
      data: { seconds },
    }
  }

  return { 'time-wait': timeWait }
}
