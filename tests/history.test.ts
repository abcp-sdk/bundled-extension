import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { BundledDeps } from '../src/deps.js'
import { memoryExecutes } from '../src/memory.js'

/**
 * The history tools only need `sessionTip` + `messageChain` + `messageParts`
 * (plus locale stubs), so the deps are a tiny in-memory stub. `rows[0]` is the
 * tip (depth 0); the chain is walked newest-first, matching the agent host.
 */

interface Row {
  id: string
  role: string
  created: string
  text: string
}

function tools(rows: Row[]) {
  const deps = {
    sessionTip: async () => (rows.length > 0 ? rows[0]!.id : ''),
    messageChain: async (_tenant: string, _tip: string, limit: number) => {
      const capped = limit > 0 ? rows.slice(0, limit) : rows
      return capped.map((r, i) => ({
        id: r.id,
        role: r.role,
        createdAt: r.created,
        depth: i,
      }))
    },
    messageParts: async (_tenant: string, ids: string[]) =>
      ids.flatMap(id => {
        const r = rows.find(x => x.id === id)
        if (!r) return []
        return [
          {
            messageId: id,
            type: 'text',
            seq: 0,
            data: JSON.stringify({ text: r.text }),
          },
        ]
      }),
    getSessionVariable: async () => undefined,
    resolveConfig: async () => undefined,
    todosEnsure: async () => {},
  } as unknown as BundledDeps
  return memoryExecutes(deps)
}

function chain(n: number, text = 'msg'): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    created: '',
    text: `${text} ${i}`,
  }))
}

type Tool = (
  args: Record<string, unknown>,
  callId: string,
  session: string,
  signal: undefined,
  tenant: string,
) => Promise<{ content?: unknown; data?: any }>

const call = (
  t: Record<string, unknown>,
  name: string,
  args: Record<string, unknown>,
) => (t[name] as Tool)(args, 'call', 's', undefined, 't')

describe('history-range', () => {
  it('returns a deep window that exceeds the old 200-entry depth cap', async () => {
    const t = tools(chain(1000))
    const r = await call(t as never, 'history-range', {
      from: 900,
      to: 1000,
      limit: 100,
      max_total_chars: 0,
    })
    expect(r.data.total).toBe(1000)
    expect(r.data.count).toBe(100)
    expect(r.data.entries[0].depth).toBe(900)
    expect(r.data.entries[99].depth).toBe(999)
  })

  it('is not empty for a window beyond the limit when limit is small', async () => {
    const t = tools(chain(1000))
    // limit only caps the RETURN count; the traversal must not be depth-capped.
    const r = await call(t as never, 'history-range', {
      from: 250,
      to: 300,
      limit: 200,
      max_total_chars: 0,
    })
    expect(r.data.count).toBe(50)
    expect(r.data.entries[0].depth).toBe(250)
  })

  it('honours limit as a return cap of a wide window', async () => {
    const t = tools(chain(1000))
    const r = await call(t as never, 'history-range', {
      from: 0,
      to: 500,
      limit: 500,
      max_total_chars: 0,
    })
    expect(r.data.count).toBe(500)
  })
})

describe('history-search', () => {
  it('paginates over the full chain with has_more/next_offset', async () => {
    // Matches only at deep positions: 10, 150, 290 (0 = newest).
    const rows = chain(300, 'noise')
    rows[10]!.text = 'needle here'
    rows[150]!.text = 'needle here'
    rows[290]!.text = 'needle here'
    const t = tools(rows)

    const p0 = await call(t as never, 'history-search', {
      query: 'needle',
      offset: 0,
      limit: 1,
      max_total_chars: 0,
    })
    expect(p0.data.total).toBe(3)
    expect(p0.data.count).toBe(1)
    expect(p0.data.entries[0].depth).toBe(10)
    expect(p0.data.has_more).toBe(true)
    expect(p0.data.next_offset).toBe(1)

    const p2 = await call(t as never, 'history-search', {
      query: 'needle',
      offset: 2,
      limit: 1,
      max_total_chars: 0,
    })
    expect(p2.data.entries[0].depth).toBe(290)
    expect(p2.data.has_more).toBe(false)
    expect(p2.data.next_offset).toBeNull()
  })

  it('finds early history (beyond the old hardcoded 10k cap is structural)', async () => {
    const rows = chain(50, 'noise')
    rows[49]!.text = 'early needle'
    const t = tools(rows)
    const r = await call(t as never, 'history-search', {
      query: 'needle',
      max_total_chars: 0,
    })
    expect(r.data.total).toBe(1)
    expect(r.data.entries[0].depth).toBe(49)
  })
})

describe('render budget (max_total_chars)', () => {
  it('returns full messages for a short session (no 200-char truncation)', async () => {
    const long = 'x'.repeat(500)
    const t = tools([{ id: 'm0', role: 'user', created: '', text: long }])
    const r = await call(t as never, 'history-range', {
      from: 0,
      to: 1,
    })
    expect(r.content).toContain(long)
    expect(r.content).not.toContain('…')
    expect(r.data.entries[0].content).toBe(long)
  })

  it('stops after the entry that would exceed the budget, never truncating one', async () => {
    const body = 'y'.repeat(1000)
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`,
      role: 'user',
      created: '',
      text: body,
    }))
    const t = tools(rows)
    const r = await call(t as never, 'history-range', {
      from: 0,
      to: 5,
      max_total_chars: 2500,
    })
    // ~1018 chars per entry: 2 fit, the 3rd is emitted in full then we stop.
    expect(r.data.count).toBe(3)
    expect(
      r.data.entries.every((e: Record<string, unknown>) => e.content === body),
    ).toBe(true)
    expect(r.content).not.toContain('…')
    expect(r.content).toContain('2500')
  })

  it('max_total_chars=0 returns everything', async () => {
    const body = 'z'.repeat(1000)
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`,
      role: 'user',
      created: '',
      text: body,
    }))
    const t = tools(rows)
    const r = await call(t as never, 'history-range', {
      from: 0,
      to: 5,
      max_total_chars: 0,
    })
    expect(r.data.count).toBe(5)
  })
})

describe('history manifest contract', () => {
  const manifest = readFileSync(
    fileURLToPath(new URL('../manifest.yaml', import.meta.url)),
    'utf8',
  )

  it('declares offset + max_total_chars on history-search', () => {
    expect(manifest).toMatch(/name: history-search/)
    expect(manifest).toMatch(/offset:/)
    expect(manifest).toMatch(/max_total_chars:/)
    expect(manifest).not.toMatch(/max_chars:/)
  })

  it('declares max_total_chars on history-range', () => {
    expect(manifest).toMatch(/name: history-range/)
  })
})
