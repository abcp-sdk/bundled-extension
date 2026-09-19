/**
 * audio-transcribe tool handler: transcribe a stored audio file
 * (file:<code>) to text. The model comes from the AGENT PROVIDER REGISTRY —
 * the `model.transcription` config knob holds a canonical `provider_id/model_id` ref
 * (capability=transcription), resolved through the injected
 * `deps.resolveGenerative` and driven with the AI SDK `transcribe()`.
 */

import type { ToolSpec } from '@abc-protocol/sdk'
import type { BundledDeps } from './deps.js'
import { localeOf, tr } from './i18n.js'

function strArg(m: Record<string, unknown>, k: string): string {
  const v = m[k]
  return typeof v === 'string' ? v : ''
}

/** audio-transcribe execute handler. */
export const audioTranscribeExecute =
  (deps: BundledDeps): ToolSpec['execute'] =>
  async (args, _callId, sessionName, _signal, tenant = '') => {
    const code = strArg(args, 'code')
    const locale = await localeOf(deps, tenant, sessionName ?? '')
    if (code === '') throw new Error(tr(locale, 'codeRequired'))
    const language = strArg(args, 'language')
    const meta = await deps.blobGet(code, tenant).then(r => r.meta)
    const mime = String(meta['mime'] ?? '')
    if (!mime.startsWith('audio/')) {
      throw new Error(tr(locale, 'notAudio', { code, mime: mime || 'unknown mime' }))
    }
    const ref = String(
      (await deps.resolveConfig('model.transcription', sessionName, tenant)) ?? '',
    ).trim()
    if (ref === '') {
      throw new Error(
        tr(locale, 'transcriptionNotConfigured'),
      )
    }
    const resolved = await deps.resolveGenerative('transcription', ref, tenant)
    if (resolved.isErr()) {
      throw new Error(
        tr(locale, 'transcriptionModelResolve', {
          error: resolved.error ?? tr(locale, 'modelNotFound'),
        }),
      )
    }
    const { model, modelId } = resolved.value!
    const blob = await deps.blobGet(code, tenant)
    const { transcribe } = await import('ai')
    const res = await transcribe({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: model as any,
      audio: new Uint8Array(blob.data),
      ...(language.trim() === ''
        ? {}
        : // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { providerOptions: { openai: { language: language.trim() } } as any }),
    })
    const text = res.text.trim()
    if (text === '') throw new Error(tr(locale, 'transcriptionEmpty'))
    return {
      content: text,
      data: {
        code,
        mime,
        size: Number(meta['size'] ?? 0),
        model: modelId,
        language: language || undefined,
      },
    }
  }
