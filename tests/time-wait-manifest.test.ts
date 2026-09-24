import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { BundledDeps } from '../src/deps.js'
import { timeWaitExecutes } from '../src/time-wait.js'

// index.ts imports manifest.yaml (a raw loader the agent's esbuild handles),
// so we assert the manifest<->handler contract statically here rather than
// importing the composed config in vitest.
describe('time-wait manifest/handler contract', () => {
  const manifest = readFileSync(
    fileURLToPath(new URL('../manifest.yaml', import.meta.url)),
    'utf8',
  )

  it('declares time-wait in the manifest with a seconds schema', () => {
    expect(manifest).toMatch(/- name: time-wait/)
    expect(manifest).toMatch(/required: \[seconds\]/)
  })

  it('exposes a matching handler key', () => {
    const handlers = timeWaitExecutes({} as BundledDeps)
    expect(Object.keys(handlers)).toEqual(['time-wait'])
    expect(typeof handlers['time-wait']).toBe('function')
  })
})
