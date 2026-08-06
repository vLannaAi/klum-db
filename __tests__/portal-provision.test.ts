/**
 * lobby.provisionPortal (#42): fleet-level portal provisioning — ensure
 * the client shard, assign the portal handle (#43's link target), apply
 * firm grants, issue the client's magic-link invite, and keep the
 * invite audit trail on the fleet registry row.
 *
 * Composes published primitives only: VaultGroup shard machinery (this
 * repo), `@noy-db/hub/team` grants, `@noy-db/on-magic-link`
 * issueInvite / issuePeerRecovery / revokeInvite.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { withTeam } from '@noy-db/hub/team'
import { toMemory } from '@noy-db/to-memory'
import type { Vault } from '@noy-db/hub'
import { createLobby, type VaultRegistryRow } from '../src/index.js'

interface Invoice { clientId: string; amount: number }

async function buildFleet() {
  const adapter = toMemory()
  const db = await createNoydb({ store: adapter, user: 'operator', secret: 'op-pass', teamStrategy: withTeam() })
  const lobby = createLobby(db)
  lobby.withVaultTemplate('client-template', {
    version: 1,
    configure: (v: Vault) => { v.collection<Invoice>('invoices') },
  })
  const state = await db.openVault('state')
  const registry = state.collection<VaultRegistryRow>('vault-registry')
  const group = await lobby.openVaultGroup<Invoice>('portal', {
    registry,
    sharding: { keyOf: (r) => r.clientId, vaultTemplate: 'client-template' },
  })
  return { db, lobby, group, registry, adapter }
}

describe('Lobby.provisionPortal (#42)', () => {
  it('provisions a NEW client: creates the shard, assigns a ULID handle, stamps portal, issues the invite', async () => {
    const { lobby, group } = await buildFleet()

    const res = await lobby.provisionPortal(group, {
      client: 'acme',
      invite: { userId: 'client-acme', displayName: 'Acme Portal', role: 'client' },
    })

    expect(res.vaultId).toBe('portal--acme')
    expect(res.handle).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(res.invite.userId).toBe('client-acme')
    expect(res.invite.encoded).toBeTypeOf('string')
    expect(res.invite.tokenId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(res.row.handle).toBe(res.handle)
    expect(res.row.portal?.enabledAt).toBeTypeOf('number')
    expect(res.row.portal?.invites).toHaveLength(1)
    expect(res.row.portal?.invites[0]).toMatchObject({
      tokenId: res.invite.tokenId, userId: 'client-acme', kind: 'invite',
    })
  })

  it('is idempotent on the handle: re-provisioning keeps the handle and appends to the audit trail', async () => {
    const { lobby, group } = await buildFleet()

    const first = await lobby.provisionPortal(group, {
      client: 'acme',
      invite: { userId: 'client-acme', displayName: 'Acme Portal' },
    })
    const second = await lobby.provisionPortal(group, {
      client: 'acme',
      invite: { userId: 'client-acme-2', displayName: 'Acme Portal 2' },
    })

    expect(second.handle).toBe(first.handle)
    expect(second.row.portal?.invites).toHaveLength(2)
    expect(second.invite.tokenId).not.toBe(first.invite.tokenId)
  })

  it('after provisioning, #43 buildShareLink mints links for the client', async () => {
    const { lobby, group, registry } = await buildFleet()
    const res = await lobby.provisionPortal(group, {
      client: 'acme',
      invite: { userId: 'client-acme', displayName: 'Acme Portal' },
    })

    const url = await lobby.buildShareLink(
      { client: 'acme', group: 'portal', collection: 'invoices', record: 'inv-1' },
      { registry },
    )

    expect(url).toBe(`/r/${res.handle}/invoices/inv-1`)
  })

  it('applies firm grants: a granted custodian can open the client vault', async () => {
    const { lobby, group, adapter } = await buildFleet()

    await lobby.provisionPortal(group, {
      client: 'acme',
      invite: { userId: 'client-acme', displayName: 'Acme Portal' },
      firmGrants: [{ userId: 'firm-custodian', displayName: 'Firm', role: 'admin', secret: 'firm-pass' }],
    })

    const custodian = await createNoydb({ store: adapter, user: 'firm-custodian', secret: 'firm-pass' })
    const vault = await custodian.openVault('portal--acme')
    expect(vault).toBeDefined()
    await custodian.close()
  })

  it('rebind mode re-invites the SAME principal (no new identity), audited as kind "rebind"', async () => {
    const { lobby, group } = await buildFleet()
    await lobby.provisionPortal(group, {
      client: 'acme',
      invite: { userId: 'client-acme', displayName: 'Acme Portal' },
    })

    const rebound = await lobby.provisionPortal(group, {
      client: 'acme',
      mode: 'rebind',
      invite: { userId: 'client-acme', displayName: 'Acme Portal' },
    })

    expect(rebound.invite.userId).toBe('client-acme')
    const audit = rebound.row.portal?.invites ?? []
    expect(audit).toHaveLength(2)
    expect(audit[1]).toMatchObject({ userId: 'client-acme', kind: 'rebind' })
  })

  it('revokePortalInvite marks the invite revoked in the audit trail (idempotent)', async () => {
    const { lobby, group } = await buildFleet()
    const res = await lobby.provisionPortal(group, {
      client: 'acme',
      invite: { userId: 'client-acme', displayName: 'Acme Portal' },
    })

    const row1 = await lobby.revokePortalInvite(group, { client: 'acme', tokenId: res.invite.tokenId })
    const row2 = await lobby.revokePortalInvite(group, { client: 'acme', tokenId: res.invite.tokenId })

    expect(row1.portal?.invites[0]?.revokedAt).toBeTypeOf('number')
    expect(row2.portal?.invites[0]?.revokedAt).toBe(row1.portal?.invites[0]?.revokedAt)
  })

  it('revokePortalInvite fails closed on an unknown tokenId', async () => {
    const { lobby, group } = await buildFleet()
    await lobby.provisionPortal(group, {
      client: 'acme',
      invite: { userId: 'client-acme', displayName: 'Acme Portal' },
    })

    await expect(
      lobby.revokePortalInvite(group, { client: 'acme', tokenId: '01JUNKJUNKJUNKJUNKJUNKJUNK' }),
    ).rejects.toThrow(/tokenId/)
  })
})
