/**
 * Notifications in-app delivery (#38) — the inbox. Pure; no vault.
 */
import { describe, it, expect } from 'vitest'
import { NotificationInbox } from '../src/notifications/inbox.js'
import type { NotificationRecord } from '../src/notifications/record.js'

function rec(over: Partial<NotificationRecord> & { id: string; recipient: string }): NotificationRecord {
  return {
    ruleId: 'r', actorId: 'u_ada', op: 'update',
    ref: { vaultId: 'v', collection: 'c', recordId: 'x', version: 1 },
    createdAt: 100, dismissedAt: null,
    ...over,
  }
}

function fakeStore(seed: NotificationRecord[]) {
  const rows = new Map(seed.map((r) => [r.id, r]))
  return {
    hydrated: 0,
    async list() { this.hydrated++; return [...rows.keys()] },
    query() { return { toArray: () => [...rows.values()] } },
    async get(id: string) { return rows.get(id) ?? null },
    async put(id: string, record: NotificationRecord) { rows.set(id, record) },
  }
}

describe('NotificationInbox.list', () => {
  it('returns only the given recipient’s records', async () => {
    const store = fakeStore([
      rec({ id: 'a', recipient: 'u_ben' }),
      rec({ id: 'b', recipient: 'u_cy' }),
    ])
    const got = await new NotificationInbox(store).list({ recipient: 'u_ben' })
    expect(got.map((r) => r.id)).toEqual(['a'])
  })

  it('hydrates the collection before querying', async () => {
    const store = fakeStore([rec({ id: 'a', recipient: 'u_ben' })])
    await new NotificationInbox(store).list({ recipient: 'u_ben' })
    expect(store.hydrated).toBe(1)
  })

  it('excludes dismissed records by default and includes them on request', async () => {
    const store = fakeStore([
      rec({ id: 'a', recipient: 'u_ben' }),
      rec({ id: 'b', recipient: 'u_ben', dismissedAt: 150 }),
    ])
    const inbox = new NotificationInbox(store)
    expect((await inbox.list({ recipient: 'u_ben' })).map((r) => r.id)).toEqual(['a'])
    const all = await inbox.list({ recipient: 'u_ben', includeDismissed: true })
    expect(all.map((r) => r.id).sort()).toEqual(['a', 'b'])
  })

  it('excludes expired records, honouring the injected now', async () => {
    const store = fakeStore([
      rec({ id: 'live', recipient: 'u_ben', expiresAt: 500 }),
      rec({ id: 'dead', recipient: 'u_ben', expiresAt: 200 }),
      rec({ id: 'forever', recipient: 'u_ben' }),
    ])
    const got = await new NotificationInbox(store).list({ recipient: 'u_ben', now: 300 })
    expect(got.map((r) => r.id).sort()).toEqual(['forever', 'live'])
  })

  it('treats expiresAt exactly equal to now as expired', async () => {
    const store = fakeStore([rec({ id: 'edge', recipient: 'u_ben', expiresAt: 300 })])
    expect(await new NotificationInbox(store).list({ recipient: 'u_ben', now: 300 })).toEqual([])
  })

  it('returns newest first', async () => {
    const store = fakeStore([
      rec({ id: 'old', recipient: 'u_ben', createdAt: 100 }),
      rec({ id: 'new', recipient: 'u_ben', createdAt: 300 }),
      rec({ id: 'mid', recipient: 'u_ben', createdAt: 200 }),
    ])
    const got = await new NotificationInbox(store).list({ recipient: 'u_ben' })
    expect(got.map((r) => r.id)).toEqual(['new', 'mid', 'old'])
  })
})

describe('NotificationInbox.unreadCount', () => {
  it('counts undismissed, unexpired records for the recipient', async () => {
    const store = fakeStore([
      rec({ id: 'a', recipient: 'u_ben' }),
      rec({ id: 'b', recipient: 'u_ben', dismissedAt: 150 }),
      rec({ id: 'c', recipient: 'u_ben', expiresAt: 200 }),
      rec({ id: 'd', recipient: 'u_cy' }),
    ])
    expect(await new NotificationInbox(store).unreadCount('u_ben', { now: 300 })).toBe(1)
  })
})

describe('NotificationInbox.dismiss', () => {
  it('stamps dismissedAt so the record leaves the default list', async () => {
    const store = fakeStore([rec({ id: 'a', recipient: 'u_ben' })])
    const inbox = new NotificationInbox(store)
    await inbox.dismiss('a', { at: 999 })
    expect((await store.get('a'))!.dismissedAt).toBe(999)
    expect(await inbox.list({ recipient: 'u_ben' })).toEqual([])
  })

  it('is idempotent — dismissing twice keeps the first timestamp', async () => {
    const store = fakeStore([rec({ id: 'a', recipient: 'u_ben' })])
    const inbox = new NotificationInbox(store)
    await inbox.dismiss('a', { at: 999 })
    await inbox.dismiss('a', { at: 1500 })
    expect((await store.get('a'))!.dismissedAt).toBe(999)
  })

  it('throws a clear error for an unknown id', async () => {
    const inbox = new NotificationInbox(fakeStore([]))
    await expect(inbox.dismiss('nope')).rejects.toThrow(/nope/)
  })
})
