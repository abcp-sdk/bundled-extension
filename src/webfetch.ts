/**
 * web-fetch tool handler. The tool's description/input_schema are declared in
 * manifest.yaml (with `descriptions.zh`); this module exposes the execute
 * handler only. Algorithm ported from opencode's `webfetch` (a plain fetch +
 * htmlparser2 + turndown).
 */

import type { ToolSpec } from '@abc-protocol/sdk'
import { parseDocument } from 'htmlparser2'
import TurndownService from 'turndown'
import type { BundledDeps } from './deps.js'
import { localeOf, tr } from './i18n.js'

export const WEB_FETCH_MAX_BYTES = 5 * 1024 * 1024
export const WEB_FETCH_DEFAULT_TIMEOUT_SECONDS = 30
export const WEB_FETCH_MAX_TIMEOUT_SECONDS = 120
export const WEB_FETCH_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'

type Format = 'markdown' | 'text' | 'html'

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
  const skip = new Set([
    'script',
    'style',
    'noscript',
    'iframe',
    'object',
    'embed',
  ])
  const out: string[] = []
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as {
      type?: string
      name?: string
      children?: unknown[]
      data?: string
    }
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

const convert = (
  content: string,
  contentType: string,
  format: Format,
): string => {
  if (!contentType.includes('text/html')) return content
  if (format === 'markdown') return convertHTMLToMarkdown(content)
  if (format === 'text') return extractTextFromHTML(content)
  return content
}

/** Fetch a single byte stream (bounded) then decode per format. */
async function fetchUrl(
  rawUrl: string,
  format: Format,
  timeoutSeconds: number,
  locale: string,
): Promise<{
  url: string
  contentType: string
  format: Format
  output: string
}> {
  const url = new URL(rawUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(tr(locale, 'fetchUrlScheme'))
  }
  if (timeoutSeconds <= 0 || timeoutSeconds > WEB_FETCH_MAX_TIMEOUT_SECONDS) {
    timeoutSeconds = WEB_FETCH_DEFAULT_TIMEOUT_SECONDS
  }
  const doFetch = async (ua: string) => {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error('Request timed out')),
      timeoutSeconds * 1000,
    )
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
        throw new Error(tr(locale, 'fetchUnsupportedImage', { mime }))
      }
      if (!isTextualMime(mime)) {
        throw new Error(tr(locale, 'fetchUnsupportedFile', { mime }))
      }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > WEB_FETCH_MAX_BYTES) {
        throw new Error(
          tr(locale, 'fetchTooLarge', { bytes: WEB_FETCH_MAX_BYTES }),
        )
      }
      return { contentType, buf }
    } finally {
      clearTimeout(timer)
    }
  }

  let fetched: { contentType: string; buf: Buffer }
  try {
    fetched = await doFetch(WEB_FETCH_USER_AGENT)
  } catch (e) {
    if (
      e &&
      typeof e === 'object' &&
      'type' in e &&
      (e as { type: string }).type === 'aborted'
    )
      throw e
    try {
      fetched = await doFetch('opencode')
    } catch (e2) {
      throw (e as Error) ?? (e2 as Error)
    }
  }
  const content = fetched.buf.toString('utf8')
  const output = convert(content, fetched.contentType, format)
  return { url: rawUrl, contentType: fetched.contentType, format, output }
}

/** web-fetch execute handler factory (description/schema from manifest.yaml). */
export const webFetchExecute =
  (deps: BundledDeps): ToolSpec['execute'] =>
  async (args, _callId, sessionName, _signal, tenant = '') => {
    const locale = await localeOf(deps, tenant, sessionName ?? '')
    const rawUrl = String(args['url'] ?? '')
    if (rawUrl === '') throw new Error(tr(locale, 'urlRequired'))
    const format = (args['format'] as Format) ?? 'markdown'
    const timeout = Number(args['timeout'] ?? 0)
    const out = await fetchUrl(rawUrl, format, timeout, locale)
    return {
      content: out.output,
      data: { url: out.url, contentType: out.contentType, format: out.format },
    }
  }
