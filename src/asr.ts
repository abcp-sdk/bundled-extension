/**
 * audio-transcribe tool handler: send a stored audio file (file:<code>) to an
 * OpenAI-compatible ASR endpoint (`/v1/audio/transcriptions`, multipart) and
 * return the transcript. Description/schema declared in manifest.yaml; this
 * module exposes the execute handler only.
 *
 * The endpoint comes from the `asr_base_url` config knob (e.g. the easylab
 * gateway `https://gateway-dev004.../v1` serving qwen3-asr); the model from
 * `asr_model` (default `qwen3-asr`). An optional `language` hint (ISO 639-1,
 * e.g. `zh`/`en`) rides the request when provided.
 */

import type { ToolSpec } from '@abc-protocol/sdk'
import type { BundledDeps } from './deps.js'

export const ASR_TIMEOUT_MS = 60_000

function strArg(m: Record<string, unknown>, k: string): string {
  const v = m[k]
  return typeof v === 'string' ? v : ''
}

/** Call the ASR endpoint with the audio bytes (multipart/form-data). */
export async function transcribeAudio(opts: {
  baseUrl: string
  model: string
  apiKey: string
  bytes: Uint8Array
  filename: string
  language: string
}): Promise<string> {
  if (opts.baseUrl.trim() === '') {
    throw new Error('asr_base_url not configured — set it to an OpenAI-compatible ASR endpoint (e.g. https://…/v1)')
  }
  if (opts.model.trim() === '') {
    throw new Error('asr_model not configured')
  }
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(opts.bytes)]), opts.filename)
  form.append('model', opts.model.trim())
  if (opts.language.trim() !== '') form.append('language', opts.language.trim())
  const url = `${opts.baseUrl.trim().replace(/\/+$/, '')}/audio/transcriptions`
  const headers: Record<string, string> = {}
  if (opts.apiKey.trim() !== '') headers['Authorization'] = `Bearer ${opts.apiKey.trim()}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ASR_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: form,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`asr failed (HTTP ${res.status}): ${text.slice(0, 200)}`)
  }
  let parsed: { text?: unknown } | null = null
  try {
    parsed = JSON.parse(text) as { text?: unknown }
  } catch {
    throw new Error(`asr returned invalid JSON: ${text.slice(0, 120)}`)
  }
  const out = String(parsed?.text ?? '')
  if (out === '') throw new Error('asr returned an empty transcript')
  return out
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
    const blob = await deps.blobGet(code)
    const baseUrl = String(
      (await deps.resolveConfig('asr_base_url', sessionName)) ?? '',
    )
    const model = String((await deps.resolveConfig('asr_model', sessionName)) ?? 'qwen3-asr')
    const apiKey = String((await deps.resolveConfig('asr_api_key', sessionName)) ?? '')
    const transcript = await transcribeAudio({
      baseUrl,
      model,
      apiKey,
      bytes: blob.data,
      filename: String(meta['name'] ?? `${code}.wav`),
      language,
    })
    return {
      content: transcript,
      data: {
        code,
        mime,
        size: Number(meta['size'] ?? 0),
        model,
        language: language || undefined,
      },
    }
  }
