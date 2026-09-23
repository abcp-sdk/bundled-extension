import { describe, expect, it } from 'vitest'
import type { BundledDeps } from '../src/deps.js'
import { memoryExecutes } from '../src/memory.js'

/**
 * `file-read` reads a stored blob's TEXT content by code. Only plain-text
 * mimes are allowed; Office documents and binaries are rejected. The handler
 * only needs `blobGet` + `getSessionVariable`/`resolveConfig` (locale), so the
 * deps are a tiny in-memory stub.
 */

function fixture(files: Record<string, { mime: string; data: Uint8Array }>) {
  const deps = {
    blobGet: async (code: string) => {
      const f = files[code]
      if (!f) throw new Error(`no such file: ${code}`)
      return { meta: { mime: f.mime, name: `${code}.txt` }, data: f.data }
    },
    getSessionVariable: async () => undefined,
    resolveConfig: async () => undefined,
    // memoryExecutes ensures the todos table at construction time.
    todosEnsure: async () => {},
  } as unknown as BundledDeps
  return memoryExecutes(deps)
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('file-read', () => {
  it('reads a text file with 1-based line numbers', async () => {
    const tools = fixture({
      c1: { mime: 'text/plain', data: utf8('alpha\nbeta\ngamma') },
    })
    const r = await tools['file-read']!(
      { code: 'c1' },
      'call',
      's',
      undefined,
      't',
    )
    expect(r?.content).toBe('1  alpha\n2  beta\n3  gamma')
    expect(r?.data).toMatchObject({
      total_lines: 3,
      start: 0,
      shown: 3,
      name: 'c1.txt',
    })
  })

  it('windows by offset/limit and notes the range', async () => {
    const tools = fixture({
      c1: {
        mime: 'text/plain',
        data: utf8('l1\nl2\nl3\nl4\nl5'),
      },
    })
    const r = await tools['file-read']!(
      { code: 'c1', offset: 1, limit: 2 },
      'call',
      's',
      undefined,
      't',
    )
    const content = String(r?.content)
    expect(content).toContain('2  l2')
    expect(content).toContain('3  l3')
    expect(content).not.toContain('l1')
    expect(content).not.toContain('l4')
    // The trailing note reports the window and that more lines remain.
    expect(content).toContain('showing lines 2-3 of 5')
    expect(r?.data).toMatchObject({ total_lines: 5, start: 1, shown: 2 })
  })

  it('accepts markdown / json / csv (text-like mimes)', async () => {
    for (const mime of ['text/markdown', 'application/json', 'text/csv']) {
      const tools = fixture({ c: { mime, data: utf8('x') } })
      const r = await tools['file-read']!(
        { code: 'c' },
        'call',
        's',
        undefined,
        't',
      )
      expect(String(r?.content)).toContain('x')
    }
  })

  it('rejects binary and Office mimes', async () => {
    const tools = fixture({
      bin: { mime: 'application/octet-stream', data: utf8('\u0000\u0001') },
      docx: {
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        data: utf8('PK'),
      },
      png: { mime: 'image/png', data: utf8('\u0089PNG') },
    })
    for (const code of ['bin', 'docx', 'png']) {
      await expect(
        tools['file-read']!({ code }, 'call', 's', undefined, 't'),
      ).rejects.toThrow(/not readable text/)
    }
  })

  it('returns an empty-file note and requires a code', async () => {
    const tools = fixture({ empty: { mime: 'text/plain', data: utf8('') } })
    const r = await tools['file-read']!(
      { code: 'empty' },
      'call',
      's',
      undefined,
      't',
    )
    expect(String(r?.content)).toContain('empty file')
    await expect(
      tools['file-read']!({}, 'call', 's', undefined, 't'),
    ).rejects.toThrow(/code is required/)
  })

  it('tolerates CRLF and drops a trailing newline', async () => {
    const tools = fixture({
      c1: { mime: 'text/plain', data: utf8('a\r\nb\r\n') },
    })
    const r = await tools['file-read']!(
      { code: 'c1' },
      'call',
      's',
      undefined,
      't',
    )
    expect(r?.content).toBe('1  a\n2  b')
    expect(r?.data).toMatchObject({ total_lines: 2 })
  })
})
