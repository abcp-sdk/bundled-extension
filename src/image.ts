/**
 * image-generate / image-edit tool handlers. Description/schema declared in
 * manifest.yaml (with `descriptions.zh`); this module exposes the execute
 * handlers only (deps captured via a factory). Driven by
 * @ai-sdk/openai-compatible's `imageModel`. No video support, so video-generate
 * is intentionally excluded.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { ToolSpec } from '@abc-protocol/sdk'
import type { BundledDeps } from './deps.js'

function strArg(m: Record<string, unknown>, k: string): string {
  const v = m[k]
  return typeof v === 'string' ? v : ''
}

function resolveImageModel(baseUrl: string, apiKey: string, modelId: string, modelCfg: string) {
  if (baseUrl.trim() === '') throw new Error('image_base_url not configured')
  if (modelId.trim() === '') throw new Error(`${modelCfg} not configured`)
  const oc = createOpenAICompatible({
    baseURL: baseUrl.trim(),
    name: 'bundled-image',
    ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
  })
  return oc.imageModel(modelId.trim())
}

/**
 * Resolve the image model for a tool. `modelCfg` is the config knob holding
 * the model ref — image-generate uses `image_model`, image-edit uses
 * `image_edit_model` (they are deliberately separate knobs so a deployment
 * can point edit at an edit-capable model while generate uses another).
 */
async function imageCfg(deps: BundledDeps, sessionName: string, modelCfg: 'image_model' | 'image_edit_model') {
  const baseUrl = String(await deps.resolveConfig('image_base_url', sessionName) ?? '')
  const apiKey = String(await deps.resolveConfig('image_api_key', sessionName) ?? '')
  const modelId = String(await deps.resolveConfig(modelCfg, sessionName) ?? '')
  return { model: resolveImageModel(baseUrl, apiKey, modelId, modelCfg), modelId }
}

/** Build the image execute handlers bound to [deps]. */
export function imageGenExecutes(deps: BundledDeps): Record<string, ToolSpec['execute']> {
  const imageGenerate: ToolSpec['execute'] = async (args, _callId, sessionName) => {
    const prompt = strArg(args, 'prompt')
    if (prompt.trim() === '') throw new Error('prompt is required')
    const { model, modelId } = await imageCfg(deps, sessionName ?? '', 'image_model')
    const { generateImage } = await import('ai')
    const size = strArg(args, 'size')
    const res = await generateImage({
      model,
      prompt,
      n: Number(args['n'] ?? 1),
      ...(size.trim() === '' ? {} : { size: size as `${number}x${number}` }),
    })
    const images = res.images.map(img => ({
      base64: Buffer.from(img.uint8Array).toString('base64'),
      mime: 'image/png',
    }))
    return { content: `Generated ${images.length} image(s).`, data: { images, model: modelId } }
  }

  const imageEdit: ToolSpec['execute'] = async (args, _callId, sessionName) => {
    const code = strArg(args, 'code')
    const prompt = strArg(args, 'prompt')
    if (code === '') throw new Error('code is required')
    if (prompt.trim() === '') throw new Error('prompt is required')
    const { model, modelId } = await imageCfg(deps, sessionName ?? '', 'image_edit_model')
    const blob = await deps.blobGet(code)
    const { generateImage } = await import('ai')
    const res = await generateImage({
      model,
      prompt: {
        images: [Buffer.from(blob.data)],
        text: prompt,
      },
    })
    const images = res.images.map(img => ({
      base64: Buffer.from(img.uint8Array).toString('base64'),
      mime: 'image/png',
    }))
    return { content: `Edited ${images.length} image(s).`, data: { images, model: modelId } }
  }

  return { 'image-generate': imageGenerate, 'image-edit': imageEdit }
}
