/**
 * image-generate / image-edit / video-generate tool handlers.
 * Speech synthesis lives in speech.ts (tts-generate / tts-clone).
 * Descriptions/schemas are declared in manifest.yaml (with `descriptions.zh`);
 * this module exposes the execute handlers only (deps captured via factory).
 *
 * All generation models come from the AGENT PROVIDER REGISTRY through the
 * injected `resolveGenerative(capability, ref)`: the config knobs
 * (`model.image` / `model.image_edit` / `model.video`) hold a
 * canonical `provider_id/model_id` ref — NOT a bare model name and NOT a
 * separate base-url/key pair. One endpoint, one key, capability-tagged.
 */

import type { ToolSpec } from '@abc-protocol/sdk'
import type { BundledDeps } from './deps.js'

function strArg(m: Record<string, unknown>, k: string): string {
  const v = m[k]
  return typeof v === 'string' ? v : ''
}

/** Resolve a generation model from a config knob holding a provider/model ref. */
export async function generativeFromConfig(
  deps: BundledDeps,
  sessionName: string,
  tenant: string,
  modelCfg: string,
  capability: 'image' | 'video' | 'speech',
): Promise<{ model: unknown; modelId: string; providerId: string }> {
  const ref = String(
    (await deps.resolveConfig(modelCfg, sessionName, tenant)) ?? '',
  ).trim()
  if (ref === '') {
    throw new Error(
      `${modelCfg} not configured — set it to a ${capability} model registered on the agent (provider_id/model_id)`,
    )
  }
  const resolved = await deps.resolveGenerative(capability, ref, tenant)
  if (resolved.isErr()) {
    throw new Error(`${modelCfg}: ${resolved.error ?? 'model not found'}`)
  }
  const v = resolved.value!
  return { model: v.model, modelId: v.modelId, providerId: v.providerId }
}

/** Store generated media bytes in the agent blob store, returning file refs. */
export async function storeMedia(
  deps: BundledDeps,
  sessionName: string,
  tenant: string,
  items: Array<{ uint8Array: Uint8Array; mediaType?: string }>,
): Promise<Array<{ code: string; mime: string; bytes: number }>> {
  const out: Array<{ code: string; mime: string; bytes: number }> = []
  for (const img of items) {
    const b64 = Buffer.from(img.uint8Array).toString('base64')
    const stored = await deps.ingestBlob({
      bytes: b64,
      name: `generated-${Date.now()}-${out.length}.png`,
      mime: img.mediaType ?? 'image/png',
      session: sessionName,
      tenant,
    })
    out.push({
      code: stored.code,
      mime: stored.mime,
      bytes: img.uint8Array.length,
    })
  }
  return out
}

/** Build the generation execute handlers bound to [deps]. */
export function imageGenExecutes(
  deps: BundledDeps,
): Record<string, ToolSpec['execute']> {
  const imageGenerate: ToolSpec['execute'] = async (
    args,
    _callId,
    sessionName,
    _signal,
    tenant = '',
  ) => {
    const prompt = strArg(args, 'prompt')
    if (prompt.trim() === '') throw new Error('prompt is required')
    const { model, modelId } = await generativeFromConfig(
      deps,
      sessionName ?? '',
      tenant,
      'model.image',
      'image',
    )
    const { generateImage } = await import('ai')
    const size = strArg(args, 'size')
    const res = await generateImage({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: model as any,
      prompt,
      n: Number(args['n'] ?? 1),
      ...(size.trim() === '' ? {} : { size: size as `${number}x${number}` }),
    })
    const stored = await storeMedia(deps, sessionName ?? '', tenant, res.images)
    return {
      content: [
        `Generated ${stored.length} image(s) with ${modelId}.`,
        ...stored.map(s => `file:${s.code} (${s.mime}, ${s.bytes} bytes)`),
      ].join('\n'),
      data: { images: stored, model: modelId },
    }
  }

  const imageEdit: ToolSpec['execute'] = async (
    args,
    _callId,
    sessionName,
    _signal,
    tenant = '',
  ) => {
    const code = strArg(args, 'code')
    const prompt = strArg(args, 'prompt')
    if (code === '') throw new Error('code is required')
    if (prompt.trim() === '') throw new Error('prompt is required')
    const { model, modelId } = await generativeFromConfig(
      deps,
      sessionName ?? '',
      tenant,
      'model.image_edit',
      'image',
    )
    const blob = await deps.blobGet(code, tenant)
    const { generateImage } = await import('ai')
    const res = await generateImage({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: model as any,
      prompt: {
        images: [Buffer.from(blob.data)],
        text: prompt,
      },
    })
    const stored = await storeMedia(deps, sessionName ?? '', tenant, res.images)
    return {
      content: [
        `Edited ${stored.length} image(s) from file:${code} with ${modelId}.`,
        ...stored.map(s => `file:${s.code} (${s.mime}, ${s.bytes} bytes)`),
      ].join('\n'),
      data: { images: stored, model: modelId, source: code },
    }
  }

  const videoGenerate: ToolSpec['execute'] = async (
    args,
    _callId,
    sessionName,
    _signal,
    tenant = '',
  ) => {
    const prompt = strArg(args, 'prompt')
    if (prompt.trim() === '') throw new Error('prompt is required')
    // Optional first / last frames: stored images (file:<code>) that seed the
    // video. Only IMAGES are accepted — anything else fails loudly rather than
    // being silently dropped by the provider. `frameImages` is the v4 standard
    // field (`VideoModelV4FrameImage` with `frameType` first_frame|last_frame).
    const firstFrameCode = strArg(args, 'first_frame_code').trim()
    const lastFrameCode = strArg(args, 'last_frame_code').trim()
    const loadFrame = async (
      code: string,
      frameType: 'first_frame' | 'last_frame',
    ): Promise<{ image: string; frameType: 'first_frame' | 'last_frame' } | null> => {
      if (code === '') return null
      const blob = await deps.blobGet(code, tenant)
      const mime = String(blob.meta['mime'] ?? '')
      if (!mime.startsWith('image/')) {
        throw new Error(
          `${frameType} file ${code} is not an image (${mime || 'unknown mime'}) — the ${frameType.replace('_', ' ')} must be an image file`,
        )
      }
      return {
        image: `data:${mime};base64,${Buffer.from(blob.data).toString('base64')}`,
        frameType,
      }
    }
    const frames = (
      await Promise.all([
        loadFrame(firstFrameCode, 'first_frame'),
        loadFrame(lastFrameCode, 'last_frame'),
      ])
    ).filter((f): f is { image: string; frameType: 'first_frame' | 'last_frame' } => f !== null)
    const { model, modelId } = await generativeFromConfig(
      deps,
      sessionName ?? '',
      tenant,
      'model.video',
      'video',
    )
    const { experimental_generateVideo } = await import('ai')
    const aspect = strArg(args, 'aspect_ratio')
    const resolution = strArg(args, 'resolution')
    const res = await experimental_generateVideo({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: model as any,
      prompt,
      ...(aspect.trim() === '' ? {} : { aspectRatio: aspect as `${number}:${number}` }),
      ...(resolution.trim() === '' ? {} : { resolution: resolution as `${number}p` }),
      ...(frames.length === 0 ? {} : { frameImages: frames }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    const stored = await storeMedia(
      deps,
      sessionName ?? '',
      tenant,
      res.videos.map(v => ({
        uint8Array: v.uint8Array,
        mediaType: v.mediaType ?? 'video/mp4',
      })),
    )
    const frameNote = [
      firstFrameCode === '' ? '' : `first frame file:${firstFrameCode}`,
      lastFrameCode === '' ? '' : `last frame file:${lastFrameCode}`,
    ].filter(s => s !== '')
    return {
      content: [
        `Generated ${stored.length} video(s) with ${modelId}${
          frameNote.length === 0 ? '' : ` (${frameNote.join(', ')})`
        }.`,
        ...stored.map(s => `file:${s.code} (${s.mime}, ${s.bytes} bytes)`),
      ].join('\n'),
      data: {
        videos: stored,
        model: modelId,
        ...(firstFrameCode === '' ? {} : { first_frame: firstFrameCode }),
        ...(lastFrameCode === '' ? {} : { last_frame: lastFrameCode }),
      },
    }
  }

  return {
    'image-generate': imageGenerate,
    'image-edit': imageEdit,
    'video-generate': videoGenerate,
  }
}
