/**
 * audio-transcribe tool handler: transcribe a stored audio file
 * (file:<code>) to text. The model comes from the AGENT PROVIDER REGISTRY —
 * the `asr_model` config knob holds a canonical `provider_id/model_id` ref
 * (capability=transcription), resolved through the injected
 * `deps.resolveGenerative` and driven with the AI SDK `transcribe()`.
 */

import type { ToolSpec } from '@abc-protocol/sdk'
import type { BundledDeps } from './deps.js'

function strArg(m: Record<string, unknown>, k: string): string {
  const v = m[k]
  return typeof v === 'string' ? v : ''
}

/** audio-transcribe execute handler. */
export const audioTranscribeExecute =
  (deps: BundledDeps): ToolSpec['execute'] =>
  async (args, _callId, sessionName) => {
    const code = strArg(args, 'code')
    if (code === '') throw new Error('code is required')
    const language = strArg(args, 'language')
    const meta = await deps.blobGet(code).then(r => r.meta)
    const mime = String(meta['mime'] ?? '')
    if (!mime.startsWith('audio/')) {
      throw new Error(`file ${code} is not audio (${mime || 'unknown mime'})`)
    }
    const ref = String(
      (await deps.resolveConfig('asr_model', sessionName)) ?? '',
    ).trim()
    if (ref === '') {
      throw new Error(
        'asr_model not configured — set it to a transcription model registered on the agent (provider_id/model_id, capability=transcription)',
      )
    }
    const resolved = await deps.resolveGenerative('transcription', ref)
    if (resolved.isErr()) {
      throw new Error(`asr_model: ${resolved.error ?? 'model not found'}`)
    }
    const { model, modelId } = resolved.value!
    const blob = await deps.blobGet(code)
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
    if (text === '') throw new Error('transcription returned an empty transcript')
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
