/**
 * web-fetch tool: fetch an HTTP(S) URL and return it as text, markdown or
 * HTML. Algorithm ported from opencode's `webfetch` (no effect/permission
 * framework — a plain fetch + htmlparser2 + turndown), used verbatim here so
 * standalone/bundled deployments get the same fetch semantics.
 */

import { parseDocument } from 'htmlparser2'
import type { ToolSpec } from '@abc-protocol/sdk'

// Minimal ambient type for turndown (CJS) so this git dependency, consumed as
// TS source by the agent, needs no @types/turndown.
declare module 'turndown' {
  interface TurndownInstance {
    remove: (f: string | string[]) => TurndownInstance
    turndown: (html: string) => string
  }
  function turndownFactory(options?: Record<string, unknown>): TurndownInstance
}
import TurndownService from 'turndown'

export const WEB_FETCH_MAX_BYTES = 5 * 1024 * 1024
export const WEB_FETCH_DEFAULT_TIMEOUT_SECONDS = 30
export const WEB_FETCH_MAX_TIMEOUT_SECONDS = 120
export const WEB_FETCH_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'

type Format = 'markdown' | 'text' | 'html'

const inputSchema = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'The HTTP or HTTPS URL to fetch content from' },
    format: {
      type: 'string',
      enum: ['text', 'markdown', 'html'],
      description: 'The format to return the content in. Defaults to markdown.',
    },
    timeout: {
      type: 'number',
      description: `Optional timeout in seconds (maximum: ${WEB_FETCH_MAX_TIMEOUT_SECONDS})`,
    },
  },
  required: ['url'],
} as const

const description = `Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default.

Use a more targeted tool when one is available. This tool is read-only. Large text results may be replaced with a preview while the complete output is retained in managed storage.`

const acceptHeader = (format: Format) => {
  switch (format) {
    case 'markdown':
      return 'text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1'
    case 'text':
      return 'text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1'
    case 'html':
      return 'text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1'
  }
  return '*/*'
}

const isCloudflareChallenge = (status: number, headers: Headers): boolean =>
  status === 403 && (headers.get('cf-mitigated') === 'challenge' || headers.get('cf-mitigated') === 'block')

const mimeFrom = (contentType: string): string =>
  contentType.split(';', 1)[0]?.trim().toLowerCase() ?? ''

const isImageAttachment = (mime: string): boolean =>
  mime.startsWith('image/') && mime !== 'image/svg+xml'

const isTextualMime = (mime: string): boolean =>
  !mime ||
  mime.startsWith('text/') ||
  mime === 'application/json' ||
  mime.endsWith('+json') ||
  mime === 'application/xml' ||
  mime.endsWith('+xml') ||
  mime === 'application/javascript' ||
  mime === 'application/x-javascript'

// ---- html → text / markdown (htmlparser2 + turndown, ported from opencode) ----

/** Plain text extraction: skip script/style/noscript/iframe/object/embed. */
export function extractTextFromHTML(html: string): string {
  const doc = parseDocument(html)
  const skip = new Set(['script', 'style', 'noscript', 'iframe', 'object', 'embed'])
  const out: string[] = []
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as { type?: string; name?: string; children?: unknown[]; data?: string }
    if (n.type === 'text') {
      out.push(n.data ?? '')
      return
    }
    if (n.type === 'tag' || n.type === 'script' || n.type === 'style') {
      if (skip.has(n.name ?? '')) return
      if (n.children) for (const c of n.children) walk(c)
    }
  }
  walk(doc)
  return out.join('').replace(/\s+/g, ' ').trim()
}

/** Markdown conversion via turndown (mirrors opencode's convertHTMLToMarkdown). */
export function convertHTMLToMarkdown(html: string): string {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  })
  turndown.remove(['script', 'style', 'meta', 'link'])
  return turndown.turndown(html)
}

const convert = (content: string, contentType: string, format: Format): string => {
  if (!contentType.includes('text/html')) return content
  if (format === 'markdown') return convertHTMLToMarkdown(content)
  if (format === 'text') return extractTextFromHTML(content)
  return content
}

// ---- tool ----

/** Fetch a single byte stream (bounded) then decode per format. */
async function fetchUrl(rawUrl: string, format: Format, timeoutSeconds: number): Promise<{ url: string; contentType: string; format: Format; output: string }> {
  const url = new URL(rawUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('URL must use http:// or https://')
  }
  if (timeoutSeconds <= 0 || timeoutSeconds > WEB_FETCH_MAX_TIMEOUT_SECONDS) {
    timeoutSeconds = WEB_FETCH_DEFAULT_TIMEOUT_SECONDS
  }
  const doFetch = async (ua: string) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutSeconds * 1000)
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': ua,
          Accept: acceptHeader(format),
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: controller.signal,
      })
      const contentType = res.headers.get('content-type') ?? ''
      const mime = mimeFrom(contentType)
      if (isImageAttachment(mime)) {
        throw new Error(`Unsupported fetched image content type: ${mime}`)
      }
      if (!isTextualMime(mime)) {
        throw new Error(`Unsupported fetched file content type: ${mime}`)
      }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > WEB_FETCH_MAX_BYTES) {
        throw new Error(`Response too large (exceeds ${WEB_FETCH_MAX_BYTES} byte limit)`)
      }
      return { contentType, buf }
    } finally {
      clearTimeout(timer)
    }
  }

  let fetched: { contentType: string; buf: Buffer }
  let first: unknown
  try {
    fetched = await doFetch(WEB_FETCH_USER_AGENT)
  } catch (e) {
    // Cloudflare challenge backoff: retry with the plain "opencode" UA.
    if (e && typeof e === 'object' && 'type' in e && (e as { type: string }).type === 'aborted') throw e
    first = e
    try {
      fetched = await doFetch('opencode')
    } catch (e2) {
      throw (first as Error) ?? (e2 as Error)
    }
  }
  const content = fetched.buf.toString('utf8')
  const output = convert(content, fetched.contentType, format)
  return { url: rawUrl, contentType: fetched.contentType, format, output }
}

export function webFetchTool(): Record<string, ToolSpec> {
  return {
    'web-fetch': {
      description,
      inputSchema,
      execute: async (args) => {
        const rawUrl = String(args['url'] ?? '')
        if (rawUrl === '') throw new Error('url is required')
        const format = (args['format'] as Format) ?? 'markdown'
        const timeout = Number(args['timeout'] ?? 0)
        const out = await fetchUrl(rawUrl, format, timeout)
        return { content: out.output, data: { url: out.url, contentType: out.contentType, format: out.format } }
      },
    },
  }
}
