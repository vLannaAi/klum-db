import { describe, it, expect, vi } from 'vitest'
import { InsightAutoPush } from '../src/federation/insight-auto-push.js'

describe('InsightAutoPush', () => {
  it('coalesces a burst of same-shard writes into ONE recompute', async () => {
    const recompute = vi.fn(async () => {})
    const ap = new InsightAutoPush(recompute, () => true)
    ap.noteWrite('acme', 'invoices')
    ap.noteWrite('acme', 'invoices')
    ap.noteWrite('acme', 'invoices')
    await ap.whenSettled()
    expect(recompute).toHaveBeenCalledTimes(1)
    expect(recompute).toHaveBeenCalledWith('acme')
  })

  it('ignores writes to non-source collections', async () => {
    const recompute = vi.fn(async () => {})
    const ap = new InsightAutoPush(recompute, (c) => c === 'invoices')
    ap.noteWrite('acme', 'unrelated')
    await ap.whenSettled()
    expect(recompute).not.toHaveBeenCalled()
  })

  it('recomputes each distinct dirty shard once', async () => {
    const recompute = vi.fn(async () => {})
    const ap = new InsightAutoPush(recompute, () => true)
    ap.noteWrite('acme', 'invoices')
    ap.noteWrite('globex', 'invoices')
    await ap.whenSettled()
    expect(recompute.mock.calls.map((c) => c[0]).sort()).toEqual(['acme', 'globex'])
  })

  it('is best-effort: a throwing recompute is reported, not propagated; whenSettled still resolves', async () => {
    const onError = vi.fn()
    const recompute = vi.fn(async () => {
      throw new Error('boom')
    })
    const ap = new InsightAutoPush(recompute, () => true, onError)
    ap.noteWrite('acme', 'invoices')
    await expect(ap.whenSettled()).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][1]).toBe('acme')
  })

  it('whenSettled resolves immediately when nothing is pending', async () => {
    const ap = new InsightAutoPush(async () => {}, () => true)
    await expect(ap.whenSettled()).resolves.toBeUndefined()
  })

  it('coalesces across separate ticks correctly (second burst triggers a new flush)', async () => {
    const recompute = vi.fn(async () => {})
    const ap = new InsightAutoPush(recompute, () => true)
    ap.noteWrite('acme', 'invoices')
    await ap.whenSettled()
    ap.noteWrite('acme', 'invoices')
    await ap.whenSettled()
    expect(recompute).toHaveBeenCalledTimes(2)
  })
})
