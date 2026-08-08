/**
 * Notifications rule engine (#37) — integration against a real hub instance.
 * Proves the /cargo onAfterWrite seam wiring, not the matching logic.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memoryStore } from './helpers/two-shard-group.js'
import { NotificationRuleEngine } from '../src/notifications/rule-engine.js'
import type { NotificationIntent, NotificationRule } from '../src/notifications/types.js'

interface Client extends Record<string, unknown> { id: string; riskRating: string }

const RULE: NotificationRule = {
  id: 'risk-escalation',
  collection: 'clients',
  ops: ['update'],
  when: [{ field: 'riskRating', from: 'low', to: 'high' }],
  recipients: { kind: 'actors', ids: ['u_ben'] },
}

async function harness(rules: readonly NotificationRule[], sink: (i: NotificationIntent) => void | Promise<void>) {
  const db = await createNoydb({ store: memoryStore(), user: 'u_ada', secret: 'op-pass' })
  const vault = await db.openVault('clients-vault')
  const clients = vault.collection<Client>('clients')
  const engine = new NotificationRuleEngine({ rules, sink, onError: () => {} })
  return { db, clients, engine }
}

describe('NotificationRuleEngine.attach (#37)', () => {
  it('emits an intent for a real matching write', async () => {
    const seen: NotificationIntent[] = []
    const h = await harness([RULE], (i) => { seen.push(i) })
    const off = h.engine.attach(h.db)

    await h.clients.put('c1', { id: 'c1', riskRating: 'low' })
    expect(seen).toHaveLength(0)          // create does not match ops: ['update']

    await h.clients.put('c1', { id: 'c1', riskRating: 'high' })
    expect(seen).toHaveLength(1)
    expect(seen[0].ruleId).toBe('risk-escalation')
    expect(seen[0].ref.collection).toBe('clients')
    expect(seen[0].ref.recordId).toBe('c1')
    expect(seen[0].recipients).toEqual(['u_ben'])
    off()
  })

  it('resolves roles and recipients from the roster passed at attach time', async () => {
    const seen: NotificationIntent[] = []
    const ownerRule: NotificationRule = {
      id: 'owner-ping', collection: 'clients', ops: ['update'], recipients: { kind: 'vaultOwner' },
    }
    const h = await harness([ownerRule], (i) => { seen.push(i) })
    const off = h.engine.attach(h.db, {
      roster: { roles: { u_ada: 'advisor' }, vaultOwner: { 'clients-vault': 'u_ben' } },
    })

    await h.clients.put('c1', { id: 'c1', riskRating: 'low' })
    await h.clients.put('c1', { id: 'c1', riskRating: 'high' })
    expect(seen).toHaveLength(1)
    expect(seen[0].actorRole).toBe('advisor')
    expect(seen[0].recipients).toEqual(['u_ben'])
    off()
  })

  it('is best-effort: a throwing sink does NOT fail the write', async () => {
    const h = await harness([RULE], () => { throw new Error('sink down') })
    const off = h.engine.attach(h.db)

    await h.clients.put('c1', { id: 'c1', riskRating: 'low' })
    await h.clients.put('c1', { id: 'c1', riskRating: 'high' })    // does not throw/reject
    expect(await h.clients.get('c1')).toMatchObject({ riskRating: 'high' })
    off()
  })

  it('routes a sink failure to onError with phase "sink"', async () => {
    const db = await createNoydb({ store: memoryStore(), user: 'u_ada', secret: 'op-pass' })
    const vault = await db.openVault('clients-vault')
    const clients = vault.collection<Client>('clients')
    const ctxs: Array<{ phase: string }> = []
    const engine = new NotificationRuleEngine({
      rules: [RULE],
      sink: () => { throw new Error('sink down') },
      onError: (_e, ctx) => ctxs.push(ctx),
    })
    const off = engine.attach(db)

    await clients.put('c1', { id: 'c1', riskRating: 'low' })
    await clients.put('c1', { id: 'c1', riskRating: 'high' })
    expect(ctxs).toEqual([{ phase: 'sink', ruleId: 'risk-escalation' }])
    off()
  })

  it('stops emitting after the returned Unsubscribe is called', async () => {
    const seen: NotificationIntent[] = []
    const h = await harness([RULE], (i) => { seen.push(i) })
    const off = h.engine.attach(h.db)

    await h.clients.put('c1', { id: 'c1', riskRating: 'low' })
    off()
    await h.clients.put('c1', { id: 'c1', riskRating: 'high' })
    expect(seen).toHaveLength(0)
  })

  it('is best-effort: a throwing sink AND a throwing onError together do NOT fail the write', async () => {
    const db = await createNoydb({ store: memoryStore(), user: 'u_ada', secret: 'op-pass' })
    const vault = await db.openVault('clients-vault')
    const clients = vault.collection<Client>('clients')
    const engine = new NotificationRuleEngine({
      rules: [RULE],
      sink: () => { throw new Error('sink down') },
      onError: () => { throw new Error('onError down too') },
    })
    const off = engine.attach(db)

    await clients.put('c1', { id: 'c1', riskRating: 'low' })
    await clients.put('c1', { id: 'c1', riskRating: 'high' })    // does not throw/reject
    expect(await clients.get('c1')).toMatchObject({ riskRating: 'high' })
    off()
  })
})
