/**
 * Notifications in-app delivery (#38) — record shape + id derivation.
 */
import { describe, it, expect } from 'vitest'
import { deriveNotificationId, notificationsVaultName } from '../src/notifications/record.js'
import type { NotificationRef } from '../src/notifications/types.js'

const REF: NotificationRef = { vaultId: 'shard_x', collection: 'clients', recordId: 'c1', version: 5 }

describe('notificationsVaultName', () => {
  it('namespaces the vault per group', () => {
    expect(notificationsVaultName('firm-clients')).toBe('notifications--firm-clients')
  })
})

describe('deriveNotificationId', () => {
  it('is deterministic for the same inputs', async () => {
    const a = await deriveNotificationId('risk', REF, 'u_ben')
    const b = await deriveNotificationId('risk', REF, 'u_ben')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('varies with the recipient', async () => {
    const ben = await deriveNotificationId('risk', REF, 'u_ben')
    const cy = await deriveNotificationId('risk', REF, 'u_cy')
    expect(ben).not.toBe(cy)
  })

  it('varies with the rule id', async () => {
    const a = await deriveNotificationId('risk', REF, 'u_ben')
    const b = await deriveNotificationId('other', REF, 'u_ben')
    expect(a).not.toBe(b)
  })

  it('varies with every component of the ref', async () => {
    const base = await deriveNotificationId('risk', REF, 'u_ben')
    const variants = await Promise.all([
      deriveNotificationId('risk', { ...REF, vaultId: 'shard_y' }, 'u_ben'),
      deriveNotificationId('risk', { ...REF, collection: 'invoices' }, 'u_ben'),
      deriveNotificationId('risk', { ...REF, recordId: 'c2' }, 'u_ben'),
      deriveNotificationId('risk', { ...REF, version: 6 }, 'u_ben'),
    ])
    for (const v of variants) expect(v).not.toBe(base)
    expect(new Set(variants).size).toBe(4)
  })

  it('does not collide when components are shifted across the delimiter', async () => {
    // 'collection' and 'recordId' are adjacent in the joined tuple, so shifting
    // the '|' between them is a real naive-concat collision: 'a|b' + 'c' vs
    // 'a' + 'b|c' must not hash the same — guards a naive concat.
    const a = await deriveNotificationId('r', { ...REF, collection: 'a|b', recordId: 'c' }, 'u_ben')
    const b = await deriveNotificationId('r', { ...REF, collection: 'a', recordId: 'b|c' }, 'u_ben')
    expect(a).not.toBe(b)
  })
})

import { createNotificationSink } from '../src/notifications/delivery.js'
import type { NotificationRecord } from '../src/notifications/record.js'
import type { NotificationIntent } from '../src/notifications/types.js'

function fakeWriter() {
  const written: Array<{ id: string; record: NotificationRecord }> = []
  return {
    written,
    put: async (id: string, record: NotificationRecord) => { written.push({ id, record }) },
  }
}

const INTENT: NotificationIntent = {
  ruleId: 'risk-escalation',
  actorId: 'u_ada',
  actorRole: 'advisor',
  op: 'update',
  ref: { vaultId: 'shard_x', collection: 'clients', recordId: 'c1', version: 5 },
  recipients: ['u_ben', 'u_cy'],
  severity: 'critical',
  ts: 1_700_000_000_000,
}

describe('createNotificationSink', () => {
  it('fans one intent out to one record per recipient', async () => {
    const w = fakeWriter()
    await createNotificationSink(w, { now: () => 1_700_000_000_000 })(INTENT)
    expect(w.written).toHaveLength(2)
    expect(w.written.map((x) => x.record.recipient).sort()).toEqual(['u_ben', 'u_cy'])
  })

  it('writes each record under its derived id', async () => {
    const w = fakeWriter()
    await createNotificationSink(w, { now: () => 1_700_000_000_000 })(INTENT)
    for (const { id, record } of w.written) expect(record.id).toBe(id)
    expect(new Set(w.written.map((x) => x.id)).size).toBe(2)
  })

  it('is idempotent — the same intent twice yields the same two ids', async () => {
    const w = fakeWriter()
    const sink = createNotificationSink(w, { now: () => 1_700_000_000_000 })
    await sink(INTENT)
    await sink(INTENT)
    expect(w.written).toHaveLength(4)
    expect(new Set(w.written.map((x) => x.id)).size).toBe(2)
  })

  it('carries reference fields and starts undismissed', async () => {
    const w = fakeWriter()
    await createNotificationSink(w, { now: () => 1_700_000_000_000 })(INTENT)
    const r = w.written[0]!.record
    expect(r.ruleId).toBe('risk-escalation')
    expect(r.actorId).toBe('u_ada')
    expect(r.actorRole).toBe('advisor')
    expect(r.op).toBe('update')
    expect(r.severity).toBe('critical')
    expect(r.ref).toEqual(INTENT.ref)
    expect(r.createdAt).toBe(1_700_000_000_000)
    expect(r.dismissedAt).toBeNull()
    expect(r.expiresAt).toBeUndefined()
  })

  it('sets expiresAt from defaultTtlMs when configured', async () => {
    const w = fakeWriter()
    await createNotificationSink(w, { now: () => 1_000, defaultTtlMs: 500 })(INTENT)
    expect(w.written[0]!.record.expiresAt).toBe(1_500)
  })

  it('omits optional fields the intent did not carry', async () => {
    const w = fakeWriter()
    const bare: NotificationIntent = {
      ruleId: 'r', actorId: 'u_ada', op: 'create',
      ref: { vaultId: 'v', collection: 'c', recordId: 'r1', version: 1 },
      recipients: ['u_ben'], ts: 5,
    }
    await createNotificationSink(w, { now: () => 5 })(bare)
    const r = w.written[0]!.record
    expect(r.actorRole).toBeUndefined()
    expect(r.severity).toBeUndefined()
  })

  it('writes nothing when the intent has no recipients', async () => {
    const w = fakeWriter()
    await createNotificationSink(w, { now: () => 1 })({ ...INTENT, recipients: [] })
    expect(w.written).toHaveLength(0)
  })

  it('never stores field values — payload minimization (spec § 4)', async () => {
    const w = fakeWriter()
    await createNotificationSink(w, { now: () => 1 })(INTENT)
    expect(w.written).toHaveLength(2)
    const json = JSON.stringify(w.written)
    expect(json).not.toContain('riskRating')
    expect(json).not.toContain('low')
    expect(json).not.toContain('high')
  })

  it('does not abort the remaining recipients when one write fails', async () => {
    const written: Array<{ id: string; record: NotificationRecord }> = []
    const writer = {
      put: async (id: string, record: NotificationRecord) => {
        if (record.recipient === 'u_ben') throw new Error('write down')
        written.push({ id, record })
      },
    }
    const sink = createNotificationSink(writer, { now: () => 1_700_000_000_000 })
    await expect(sink(INTENT)).rejects.toThrow(/1\/2 recipient/)
    expect(written).toHaveLength(1)
    expect(written[0]!.record.recipient).toBe('u_cy')
  })
})
