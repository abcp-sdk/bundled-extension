import { afterEach, describe, expect, it, vi } from 'vitest'
import { braveSearchExecute } from '../src/brave-search.js'
import type { BundledDeps } from '../src/deps.js'

/** Minimal deps: only resolveConfig is exercised (api key). */
function deps(): BundledDeps {
  return {
    resolveConfig: async () => 'test-key',
    getSessionVariable: async () => '',
  } as unknown as BundledDeps
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('brave-search data', () => {
  it('returns structured results alongside the rendered text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          new TextEncoder().encode(
            JSON.stringify({
              web: {
                results: [
                  {
                    title: 'Alpha',
                    url: 'https://a.example',
                    description: 'first hit',
                    age: '2 days ago',
                  },
                  {
                    title: 'Beta',
                    url: 'https://b.example',
                    description: 'second hit',
                  },
                ],
              },
            }),
          ).buffer,
      })),
    )
    const exec = braveSearchExecute(deps())
    const r = await exec({ query: 'alpha' }, 'c', 's1', undefined, 't1')
    expect(String(r?.content)).toContain('https://a.example')
    const data = r?.data as {
      provider: string
      query: string
      results: Array<Record<string, unknown>>
    }
    expect(data.provider).toBe('brave')
    expect(data.query).toBe('alpha')
    expect(data.results).toEqual([
      {
        title: 'Alpha',
        url: 'https://a.example',
        description: 'first hit',
        age: '2 days ago',
      },
      { title: 'Beta', url: 'https://b.example', description: 'second hit' },
    ])
  })

  it('returns an empty results array when there are no hits', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          new TextEncoder().encode(JSON.stringify({ web: { results: [] } }))
            .buffer,
      })),
    )
    const exec = braveSearchExecute(deps())
    const r = await exec({ query: 'nothing' }, 'c', 's1', undefined, 't1')
    expect((r!.data as { results: unknown[] }).results).toEqual([])
  })
})
