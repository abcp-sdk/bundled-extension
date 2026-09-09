/**
 * image-generate / image-edit tools, driven by @ai-sdk/openai-compatible's
 * `imageModel` (base URL + api key from config). No video support in
 * openai-compatible, so video-generate is intentionally NOT included yet.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { ToolSpec } from '@abc-protocol/sdk'
import type { BundledDeps } from './deps.js'

function strArg(m: Record<string, unknown>, k: string): string {
  const v = m[k]
  return typeof v === 'string' ? v : ''
}

export function imageGenTool(deps: BundledDeps): Record<string, ToolSpec> {
  const resolveImageModel = (baseUrl: string, apiKey: string, modelId: string) => {
    if (baseUrl.trim() === '') throw new Error('image_base_url not configured')
    if (modelId.trim() === '') throw new Error('image_model not configured')
    const oc = createOpenAICompatible({
      baseURL: baseUrl.trim(),
      name: 'bundled-image',
      ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
    })
    return oc.imageModel(modelId.trim())
  }

  return {
    'image-generate': {
      description: 'Generate an image from a natural-language prompt using a configured vision image model.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The prompt that should be used to generate the image.' },
          size: { type: 'string', description: 'Size of the image to generate (format `{width}x{height}`).' },
          n: { type: 'integer', description: 'Number of images to generate (default 1).' },
        },
        required: ['prompt'],
      },
      requiredConfig: ['image_base_url', 'image_model'],
      execute: async (args, _callId, sessionName) => {
        const prompt = strArg(args, 'prompt')
        if (prompt.trim() === '') throw new Error('prompt is required')
        const baseUrl = String(await deps.resolveConfig('image_base_url', sessionName) ?? '')
        const apiKey = String(await deps.resolveConfig('image_api_key', sessionName) ?? '')
        const modelId = String(await deps.resolveConfig('image_model', sessionName) ?? '')
        const model = resolveImageModel(baseUrl, apiKey, modelId)
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
      },
    },
    'image-edit': {
      description: 'Edit an image (referenced by file:<code>) using a vision image model, given a natural-language instruction.',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'The file code (the 16-char segment after file:) of the source image.' },
          prompt: { type: 'string', description: 'The edit instruction to apply to the image.' },
        },
        required: ['code', 'prompt'],
      },
      requiredConfig: ['image_base_url', 'image_model'],
      execute: async (args, _callId, sessionName) => {
        const code = strArg(args, 'code')
        const prompt = strArg(args, 'prompt')
        if (code === '') throw new Error('code is required')
        if (prompt.trim() === '') throw new Error('prompt is required')
        const baseUrl = String(await deps.resolveConfig('image_base_url', sessionName) ?? '')
        const apiKey = String(await deps.resolveConfig('image_api_key', sessionName) ?? '')
        const modelId = String(await deps.resolveConfig('image_model', sessionName) ?? '')
        const model = resolveImageModel(baseUrl, apiKey, modelId)
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
      },
    },
  }
}
