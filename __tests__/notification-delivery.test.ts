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
