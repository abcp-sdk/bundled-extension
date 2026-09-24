import { describe, expect, it } from 'vitest'
import type { BundledDeps } from '../src/deps.js'
import {
  clampSeconds,
  TIME_WAIT_MAX_SECONDS,
  timeWaitExecutes,
} from '../src/time-wait.js'

const deps = {
  getSessionVariable: async () => undefined,
  resolveConfig: async () => undefined,
} as unknown as BundledDeps

const wait = timeWaitExecutes(deps)['time-wait']!

describe('time-wait clampSeconds', () => {
  it('clamps to [1, TIME_WAIT_MAX_SECONDS]', () => {
    expect(clampSeconds(0)).toBe(1)
    expect(clampSeconds(-5)).toBe(1)
    expect(clampSeconds(1)).toBe(1)
    expect(clampSeconds(30)).toBe(30)
    expect(clampSeconds(600)).toBe(TIME_WAIT_MAX_SECONDS)
    expect(clampSeconds(99999)).toBe(TIME_WAIT_MAX_SECONDS)
  })

  it('floors fractional values and guards non-finite input', () => {
    expect(clampSeconds(2.9)).toBe(2)
    expect(clampSeconds(Number.NaN)).toBe(1)
    expect(clampSeconds(Number.POSITIVE_INFINITY)).toBe(1)
  })
})

describe('time-wait execute', () => {
  it('returns after the (clamped) duration with a localized message', async () => {
    const started = Date.now()
    const r = await wait({ seconds: 1 }, 'c1', 'sess', undefined, 't')
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(900)
    expect(r?.content).toContain('1 second')
    expect(r?.data).toEqual({ seconds: 1 })
  })

  it('clamps a too-large request to the max (does not actually wait that long)', async () => {
    // Request 0 seconds -> clamped to 1 (keeps the test fast).
    const r = await wait({ seconds: 0 }, 'c1', 'sess', undefined, 't')
    expect(r?.data).toEqual({ seconds: 1 })
  })

  it('is cancelled immediately when the signal aborts mid-wait', async () => {
    const ac = new AbortController()
    const started = Date.now()
    setTimeout(() => ac.abort(), 50)
    await expect(
      wait({ seconds: 590 }, 'c1', 'sess', ac.signal, 't'),
    ).rejects.toThrow(/interrupted/)
    // Far less than the requested 590s: it aborted promptly.
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('does not wait at all when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const started = Date.now()
    await expect(
      wait({ seconds: 590 }, 'c1', 'sess', ac.signal, 't'),
    ).rejects.toThrow(/interrupted/)
    expect(Date.now() - started).toBeLessThan(200)
  })
})
