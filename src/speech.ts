/**
 * tts-generate / tts-clone tool handlers.
 *
 * Both drive the AI SDK `generateSpeech()` against a `speech`-capability model
 * from the AGENT PROVIDER REGISTRY, but they use TWO different knobs because
 * the gateway exposes two distinct TTS models:
 *
 *   - `model.speech`       -> a PRESET-VOICE model (customvoice). tts-generate
 *                             uses the provider's default voice; there is no
 *                             `voice` argument.
 *   - `model.speech_clone` -> a VOICE-CLONING model (base). tts-clone passes a
 *                             reference audio clip as the `voice` field (the
 *                             gateway accepts a `data:` URL for it), optionally
 *                             with `ref_text` (the clip's transcript).
 *
 * A reference clip is always a stored blob: the caller passes its `code` and
 * this handler reads the bytes + mime to build the data URL. Descriptions and
 * schemas live in manifest.yaml (with `descriptions.zh`).
 */

import type { ToolSpec } from '@abc-protocol/sdk'
import type { BundledDeps } from './deps.js'
import { generativeFromConfig, storeMedia } from './image.js'

function strArg(m: Record<string, unknown>, k: string): string {
  const v = m[k]
  return typeof v === 'string' ? v : ''
}

/** Build the generation execute handlers bound to [deps]. */
export function speechExecutes(
  deps: BundledDeps,
): Record<string, ToolSpec['execute']> {
  const ttsGenerate: ToolSpec['execute'] = async (
    args,
    _callId,
    sessionName,
    _signal,
    tenant = '',
  ) => {
    const text = strArg(args, 'text')
    if (text.trim() === '') throw new Error('text is required')
    const { model, modelId } = await generativeFromConfig(
      deps,
      sessionName ?? '',
      tenant,
      'model.speech',
      'speech',
    )
    const { generateSpeech } = await import('ai')
    // Preset-voice model: use the provider's default voice (no override).
    const res = await generateSpeech({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: model as any,
      text,
    })
    const mime = res.audio.mediaType ?? 'audio/mpeg'
    const stored = await storeMedia(
      deps,
      sessionName ?? '',
      tenant,
      [{ uint8Array: res.audio.uint8Array, mediaType: mime }],
    )
    return {
      content: `Synthesized ${Math.round(res.audio.uint8Array.length / 1024)} KiB ${mime} with ${modelId}: file:${stored[0]?.code}`,
      data: { audio: stored[0], model: modelId },
    }
  }

  const ttsClone: ToolSpec['execute'] = async (
    args,
    _callId,
    sessionName,
    _signal,
    tenant = '',
  ) => {
    const text = strArg(args, 'text')
    const code = strArg(args, 'code')
    if (text.trim() === '') throw new Error('text is required')
    if (code === '') throw new Error('code is required')
    const refText = strArg(args, 'ref_text')
    const { model, modelId } = await generativeFromConfig(
      deps,
      sessionName ?? '',
      tenant,
      'model.speech_clone',
      'speech',
    )
    const blob = await deps.blobGet(code, tenant)
    const mime = String(blob.meta['mime'] ?? '')
    if (!mime.startsWith('audio/')) {
      throw new Error(
        `reference file ${code} is not audio (${mime || 'unknown mime'}) — voice cloning needs an audio clip`,
      )
    }
    // The gateway accepts a base64 `data:` URL as the reference voice.
    const refAudio = `data:${mime};base64,${Buffer.from(blob.data).toString('base64')}`
    const { generateSpeech } = await import('ai')
    const res = await generateSpeech({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: model as any,
      text,
      voice: refAudio,
      ...(refText.trim() === ''
        ? {}
        : // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { providerOptions: { gateway: { ref_text: refText.trim() } } as any }),
    })
    const outMime = res.audio.mediaType ?? 'audio/mpeg'
    const stored = await storeMedia(
      deps,
      sessionName ?? '',
      tenant,
      [{ uint8Array: res.audio.uint8Array, mediaType: outMime }],
    )
    return {
      content: `Synthesized ${Math.round(res.audio.uint8Array.length / 1024)} KiB ${outMime} with ${modelId}, cloning voice from file:${code}: file:${stored[0]?.code}`,
      data: { audio: stored[0], model: modelId, reference: code },
    }
  }

  return {
    'tts-generate': ttsGenerate,
    'tts-clone': ttsClone,
  }
}
