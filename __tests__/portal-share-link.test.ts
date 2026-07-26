/**
 * Vendor-side deep-link addressing (#43): resolve/build portal share
 * links against the fleet registry, over `@noy-db/hub/share-link` (#806).
 *
 * The hub owns the link GRAMMAR; the Lobby contributes the fleet
 * resolution: `vaultHandle → registry row` (resolve) and
 * `client → vaultHandle` (build). Unknown/foreign handles fail closed
 * with a typed error that never enumerates the fleet.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { parseShareLink } from '@noy-db/hub/share-link'
import { generateULID } from '@noy-db/hub/cargo'
import { memory } from '@noy-db/to-memory'
import { createLobby, ShareLinkResolutionError, type VaultRegistryRow } from '../src/index.js'

const ACME_HANDLE = generateULID()
const BETA_HANDLE = generateULID()

async function buildFleet() {
  const db = await createNoydb({ store: memory(), user: 'operator', secret: 'op-pass' })
  const lobby = createLobby(db)
  const state = await db.openVault('state')
  const registry = state.collection<VaultRegistryRow>('vault-registry')

  await registry.put('portal::acme', {
    vaultId: 'portal--acme', partitionKey: 'acme', templateName: 'client-template',
    schemaVersion: 1, createdAt: 1, group: 'portal', handle: ACME_HANDLE,
  })
  await registry.put('portal::beta', {
    vaultId: 'portal--beta', partitionKey: 'beta', templateName: 'client-template',
    schemaVersion: 1, createdAt: 2, group: 'portal', handle: BETA_HANDLE,
  })
  // a shard WITHOUT a portal handle (portal never provisioned)
  await registry.put('portal::gamma', {
    vaultId: 'portal--gamma', partitionKey: 'gamma', templateName: 'client-template',
    schemaVersion: 1, createdAt: 3, group: 'portal',
  })
  return { db, lobby, registry }
}

describe('Lobby.resolveShareLink (#43)', () => {
  it('resolves a known handle to the fleet row + console-route descriptor', async () => {
    const { lobby, registry } = await buildFleet()
    const link = parseShareLink(`/r/${ACME_HANDLE}/bills/b-77?period=2026-Q2&v=3`)

    const res = await lobby.resolveShareLink(link, { registry })

    expect(res.row.vaultId).toBe('portal--acme')
    expect(res.row.partitionKey).toBe('acme')
    expect(res.row.group).toBe('portal')
    expect(res.link).toEqual(link)
    expect(res.consoleRoute).toEqual({
      vaultId: 'portal--acme', collection: 'bills', recordId: 'b-77',
      period: '2026-Q2', version: 3,
    })
  })

  it('accepts a raw link string and delegates parsing to the hub grammar', async () => {
    const { lobby, registry } = await buildFleet()

    const res = await lobby.resolveShareLink(`https://liff.line.me/123-abc/r/${BETA_HANDLE}/invoices/inv-1`, { registry })

    expect(res.row.vaultId).toBe('portal--beta')
    expect(res.consoleRoute).toEqual({ vaultId: 'portal--beta', collection: 'invoices', recordId: 'inv-1' })
  })

  it('fails closed on an unknown handle: typed error, no fleet enumeration in the message', async () => {
    const { lobby, registry } = await buildFleet()
    const foreign = generateULID()

    const err = await lobby.resolveShareLink(`/r/${foreign}/bills/b-1`, { registry })
      .then(() => null, (e: unknown) => e as ShareLinkResolutionError)

    expect(err).toBeInstanceOf(ShareLinkResolutionError)
    expect(err!.code).toBe('UNKNOWN_VAULT_HANDLE')
    expect(err!.message).not.toContain('acme')
    expect(err!.message).not.toContain('portal--')
  })
})

describe('Lobby.buildShareLink (#43)', () => {
  it('mints a link for a known client that round-trips through the hub parser', async () => {
    const { lobby, registry } = await buildFleet()

    const url = await lobby.buildShareLink(
      { client: 'acme', group: 'portal', collection: 'bills', record: 'b-77', period: '2026-Q2', version: 3, grantToken: 'tok-1' },
      { registry },
    )

    expect(parseShareLink(url)).toEqual({
      vaultHandle: ACME_HANDLE, collection: 'bills', recordId: 'b-77',
      period: '2026-Q2', version: 3, grantToken: 'tok-1',
    })
    expect(url).toContain('#g=tok-1')
  })

  it('prefixes the given base verbatim', async () => {
    const { lobby, registry } = await buildFleet()

    const url = await lobby.buildShareLink(
      { client: 'beta', group: 'portal', collection: 'invoices', record: 'inv-1', base: 'https://liff.line.me/123-abc' },
      { registry },
    )

    expect(url).toBe(`https://liff.line.me/123-abc/r/${BETA_HANDLE}/invoices/inv-1`)
  })

  it('fails closed for an unknown client (UNKNOWN_CLIENT)', async () => {
    const { lobby, registry } = await buildFleet()

    const err = await lobby.buildShareLink(
      { client: 'nobody', group: 'portal', collection: 'bills', record: 'b-1' },
      { registry },
    ).then(() => null, (e: unknown) => e as ShareLinkResolutionError)

    expect(err).toBeInstanceOf(ShareLinkResolutionError)
    expect(err!.code).toBe('UNKNOWN_CLIENT')
  })

  it('fails closed for a client whose shard has no portal handle (NO_PORTAL_HANDLE)', async () => {
    const { lobby, registry } = await buildFleet()

    const err = await lobby.buildShareLink(
      { client: 'gamma', group: 'portal', collection: 'bills', record: 'b-1' },
      { registry },
    ).then(() => null, (e: unknown) => e as ShareLinkResolutionError)

    expect(err).toBeInstanceOf(ShareLinkResolutionError)
    expect(err!.code).toBe('NO_PORTAL_HANDLE')
  })
})
