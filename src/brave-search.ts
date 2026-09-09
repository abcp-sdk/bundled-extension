/**
 * brave-search tool: web search against the Brave Search API. Algorithm
 * ported from opencode's `websearch` (Exa/Parallel MCP → Brave REST here) with
 * the same validation / timeout / no-results semantics, but a single provider
 * (Brave) driven by `BRAVE_API_KEY` config.
 */

import type { ToolSpec } from '@abc-protocol/sdk'
import type { BundledDeps } from './deps.js'

export const BRAVE_API_BASE = 'https://api.search.brave.com/res/v1/web/search'
export const BRAVE_MAX_RESULTS = 20
export const BRAVE_NO_RESULTS =
  'No search results found. Please try a different query.'
export const BRAVE_MAX_BYTES = 256 * 1024
export const BRAVE_TIMEOUT_MS = 25_000
export const BRAVE_FAILURE = 'web search failed'

interface BraveWebResult {
  title?: string
  url?: string
  description?: string
  age?: string
  title_language?: string
}

interface BraveResponse {
  web?: { results?: BraveWebResult[] }
}

function assertApiKey(apiKey: string): void {
  if (!apiKey || apiKey.trim() === '') {
    throw new Error('brave_api_key not configured')
  }
}

/** Render results into the model-visible content (mirror opencode shape). */
function renderResults(query: string, results: BraveWebResult[], count: number): string {
  if (!results || results.length === 0) return BRAVE_NO_RESULTS
  const lines: string[] = []
  for (const r of results) {
    const title = r.title ?? ''
    const url = r.url ?? ''
    const desc = r.description ?? ''
    lines.push(`**${title}**\n${url}\n${desc}`)
  }
  return `Result of searching for "${query}" (${count} results):\n\n${lines.join('\n\n')}`
}

async function callBrave(apiKey: string, query: string, count: number): Promise<string> {
  assertApiKey(apiKey)
  const url = new URL(BRAVE_API_BASE)
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(count))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), BRAVE_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
      signal: controller.signal,
    })
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > BRAVE_MAX_BYTES) {
      throw new Error(`Response too large (exceeds ${BRAVE_MAX_BYTES} bytes)`)
    }
    if (!res.ok) {
      // Brave returns 4xx/5xx w/ a JSON error payload.
      let msg = ''
      try {
        const j = JSON.parse(buf.toString('utf8')) as { message?: string; error?: string }
        msg = j.message ?? j.error ?? ''
      } catch {
        /* ignore */
      }
      throw new Error(`${BRAVE_FAILURE}: HTTP ${res.status}${msg ? ` ${msg}` : ''}`)
    }
    const body = JSON.parse(buf.toString('utf8')) as BraveResponse
    return renderResults(query, body.web?.results ?? [], body.web?.results?.length ?? 0)
  } catch (e) {
    if (e instanceof Error && e.message === 'Request timed out') throw e
    throw new Error(`${BRAVE_FAILURE}: ${String(e)}`)
  } finally {
    clearTimeout(timer)
  }
}

export function braveSearchTool(deps: BundledDeps): Record<string, ToolSpec> {
  return {
    'brave-search': {
      description: `Search the web using the session's Brave Search provider. Use this for current information beyond knowledge cutoff.

This is a provider-independent local tool backed by the Brave Search API. The current year is ${new Date().getFullYear()}. Use this year when searching for recent information or current events.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Web search query' },
          count: {
            type: 'integer',
            minimum: 1,
            maximum: BRAVE_MAX_RESULTS,
            description: `Number of search results to return (default: 8, maximum: ${BRAVE_MAX_RESULTS})`,
          },
        },
        required: ['query'],
      },
      requiredConfig: ['brave_api_key'],
      execute: async (args, _callId, sessionName) => {
        const query = String(args['query'] ?? '')
        if (query.trim() === '') throw new Error('query is required')
        let count = Number(args['count'] ?? 8)
        if (!Number.isInteger(count) || count < 1) count = 8
        if (count > BRAVE_MAX_RESULTS) count = BRAVE_MAX_RESULTS
        const apiKey = String(
          await deps.resolveConfig('brave_api_key', sessionName) ?? '',
        )
        const text = await callBrave(apiKey, query, count)
        return { content: text, data: { provider: 'brave', query } }
      },
    },
  }
}
