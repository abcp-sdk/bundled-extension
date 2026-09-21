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

import { strArg, type ToolSpec } from '@abc-protocol/sdk'
import type { BundledDeps } from './deps.js'
import { localeOf, tr } from './i18n.js'
import { generativeFromConfig, storeMedia } from './image.js'

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
    const locale = await localeOf(deps, tenant, sessionName ?? '')
    if (text.trim() === '') throw new Error(tr(locale, 'textRequired'))
    const { model, modelId } = await generativeFromConfig(
      deps,
      sessionName ?? '',
      tenant,
      'model.speech',
      'speech',
      locale,
    )
    const { generateSpeech } = await import('ai')
    // Preset-voice model: use the provider's default voice (no override).
    const res = await generateSpeech({
      // biome-ignore lint/suspicious/noExplicitAny: the AI SDK option bags are not fully typed across providers
      model: model as any,
      text,
    })
    const mime = res.audio.mediaType ?? 'audio/mpeg'
    const stored = await storeMedia(deps, sessionName ?? '', tenant, 'audio', [
      { uint8Array: res.audio.uint8Array, mediaType: mime },
    ])
    return {
      content: tr(locale, 'synthesized', {
        kib: Math.round(res.audio.uint8Array.length / 1024),
        mime,
        model: modelId,
        code: stored[0]?.code ?? '',
      }),
      data: { files: stored, model: modelId },
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
    const locale = await localeOf(deps, tenant, sessionName ?? '')
    if (text.trim() === '') throw new Error(tr(locale, 'textRequired'))
    if (code === '') throw new Error(tr(locale, 'codeRequired'))
    const refText = strArg(args, 'ref_text')
    const { model, modelId } = await generativeFromConfig(
      deps,
      sessionName ?? '',
      tenant,
      'model.speech_clone',
      'speech',
      locale,
    )
    const blob = await deps.blobGet(code, tenant)
    const mime = String(blob.meta['mime'] ?? '')
    if (!mime.startsWith('audio/')) {
      throw new Error(
        tr(locale, 'referenceNotAudio', { code, mime: mime || 'unknown mime' }),
      )
    }
    // The gateway accepts a base64 `data:` URL as the reference voice.
    const refAudio = `data:${mime};base64,${Buffer.from(blob.data).toString('base64')}`
    const { generateSpeech } = await import('ai')
    const res = await generateSpeech({
      // biome-ignore lint/suspicious/noExplicitAny: the AI SDK option bags are not fully typed across providers
      model: model as any,
      text,
      voice: refAudio,
      ...(refText.trim() === ''
        ? {}
        : {
            // biome-ignore lint/suspicious/noExplicitAny: the AI SDK option bags are not fully typed across providers
            providerOptions: { gateway: { ref_text: refText.trim() } } as any,
          }),
    })
    const outMime = res.audio.mediaType ?? 'audio/mpeg'
    const stored = await storeMedia(deps, sessionName ?? '', tenant, 'audio', [
      { uint8Array: res.audio.uint8Array, mediaType: outMime },
    ])
    return {
      content: tr(locale, 'synthesizedClone', {
        kib: Math.round(res.audio.uint8Array.length / 1024),
        mime: outMime,
        model: modelId,
        ref: code,
        code: stored[0]?.code ?? '',
      }),
      data: { files: stored, model: modelId, reference: code },
    }
  }

  return {
    'tts-generate': ttsGenerate,
    'tts-clone': ttsClone,
  }
}
