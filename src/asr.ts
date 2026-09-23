/**
 * audio-transcribe tool handler: transcribe a stored audio file
 * (file:<code>) to text. The model comes from the AGENT PROVIDER REGISTRY —
 * the `model.transcription` config knob holds a canonical `provider_id/model_id` ref
 * (capability=transcription), resolved through the injected
 * `deps.resolveGenerative` and driven with the AI SDK `transcribe()`.
 */

import { strArg, type ToolSpec } from '@abc-protocol/sdk'
import type { BundledDeps } from './deps.js'
import { localeOf, tr } from './i18n.js'

/** audio-transcribe execute handler. */
export const audioTranscribeExecute =
  (deps: BundledDeps): ToolSpec['execute'] =>
  async (args, _callId, sessionName, _signal, tenant = '') => {
    const code = strArg(args, 'code')
    const locale = await localeOf(deps, tenant, sessionName ?? '')
    if (code === '') throw new Error(tr(locale, 'codeRequired'))
    const meta = await deps.blobGet(code, tenant).then(r => r.meta)
    const mime = String(meta['mime'] ?? '')
    if (!mime.startsWith('audio/')) {
      throw new Error(
        tr(locale, 'notAudio', { code, mime: mime || 'unknown mime' }),
      )
    }
    const ref = String(
      (await deps.resolveConfig('model.transcription', sessionName, tenant)) ??
        '',
    ).trim()
    if (ref === '') {
      throw new Error(tr(locale, 'transcriptionNotConfigured'))
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
    // No `language` hint is sent: the gateway rejects the openai
    // providerOptions.language param. The model auto-detects the language.
    const res = await transcribe({
      // biome-ignore lint/suspicious/noExplicitAny: the AI SDK option bags are not fully typed across providers
      model: model as any,
      audio: new Uint8Array(blob.data),
    })
    const text = res.text.trim()
    if (text === '') throw new Error(tr(locale, 'transcriptionEmpty'))
    return {
      content: text,
      data: {
        code,
        name: String(meta['name'] ?? ''),
        mime,
        size: Number(meta['size'] ?? 0),
        model: modelId,
      },
    }
  }
