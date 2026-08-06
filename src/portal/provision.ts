/**
 * Fleet-level portal provisioning (#42). One audited lobby operation
 * that prepares a per-client portal vault: ensure the client shard
 * exists in the fleet, assign the portal vault handle (the ULID that
 * `share-link` links address, #43), apply firm custodian/admin grants,
 * and issue the client's single-use, expiring magic-link invite — the
 * seed for LINE-federated enrollment.
 *
 * Composes published primitives only: this repo's VaultGroup shard
 * machinery, `@noy-db/hub` team grants (the session needs
 * `teamStrategy: withTeam()`), and `@noy-db/on-magic-link`
 * `issueInvite` / `issuePeerRecovery` / `revokeInvite`.
 *
 * Rebind (second-device enrollment, milestone security decision: new
 * devices ONLY via firm re-invite) is `mode: 'rebind'` — a
 * peer-recovery of the EXISTING principal, same keyring identity, no
 * new principal by construction.
 *
 * The registry audit trail stores only safe fields (tokenId, userId,
 * kind, timestamps) — NEVER the encoded invite, which carries the
 * single-use temp secret.
 *
 * OIDC device-entry revocation (`revokeOidcDevice`) is deliberately
 * NOT wrapped here: it requires the OIDC provider config and a live
 * id-token — an auth context only the firm app holds.
 */
import type { Noydb, Role } from '@noy-db/hub'
import { generateULID } from '@noy-db/hub/cargo'
import type { VaultGroup } from '../federation/vault-group.js'
import type { VaultRegistryRow, PortalInviteAuditRef } from '../federation/types.js'

/** A firm-side slot to ensure on the client vault (custodian/admin). */
export interface PortalFirmGrant {
  readonly userId: string
  readonly displayName: string
  readonly role: Role
  readonly secret: string
}

/** Options for {@link provisionPortal}. */
export interface ProvisionPortalOptions {
  /** The client's partition key in the fleet. */
  readonly client: string
  /**
   * `'invite'` (default) mints a NEW principal's enrollment invite;
   * `'rebind'` re-invites the EXISTING principal (second device / lost
   * access) — same keyring identity, no new principal.
   */
  readonly mode?: 'invite' | 'rebind'
  /** The client principal the invite enrolls (or re-enrolls). */
  readonly invite: {
    readonly userId: string
    readonly displayName: string
    /** Defaults to `'client'`. */
    readonly role?: Role
    readonly ttlMs?: number
    /** Override the generated temp phrase (deterministic tests only). */
    readonly tempPhrase?: string
  }
  /** Firm custodian/admin slots to ensure on the client vault. */
  readonly firmGrants?: readonly PortalFirmGrant[]
}

/** What {@link provisionPortal} returns. */
export interface ProvisionPortalResult {
  readonly vaultId: string
  /** The portal vault handle — the ULID share links address (#43). */
  readonly handle: string
  /** The minted invite. `encoded` embeds after `#` in the app's invite URL. */
  readonly invite: {
    readonly encoded: string
    readonly tokenId: string
    readonly userId: string
    readonly expiresAt: string
  }
  /** The updated fleet registry row (handle + portal audit trail). */
  readonly row: VaultRegistryRow
}

/** Options for {@link revokePortalInvite}. */
export interface RevokePortalInviteOptions {
  readonly client: string
  readonly tokenId: string
}

async function requireRow<T>(group: VaultGroup<T>, client: string): Promise<VaultRegistryRow> {
  const row = await group.registry.get(group.registryId(client))
  if (!row) throw new Error(`provisionPortal: client "${client}" has no registry row in group.`)
  return row
}

/** Provision (or re-invite) a client portal vault. See module doc. */
export async function provisionPortal<T>(
  db: Noydb,
  group: VaultGroup<T>,
  opts: ProvisionPortalOptions,
): Promise<ProvisionPortalResult> {
  const existing = await group.registry.get(group.registryId(opts.client))
  if (!existing) await group.createShard(opts.client)
  const row = existing ?? (await requireRow(group, opts.client))
  const vaultId = row.vaultId

  for (const g of opts.firmGrants ?? []) {
    await db.grant(vaultId, {
      userId: g.userId, displayName: g.displayName, role: g.role, secret: g.secret,
    })
  }

  const { issueInvite, issuePeerRecovery } = await import('@noy-db/on-magic-link')
  const mode = opts.mode ?? 'invite'
  const issued =
    mode === 'rebind'
      ? await issuePeerRecovery(db, vaultId, {
          userId: opts.invite.userId,
          displayName: opts.invite.displayName,
          ...(opts.invite.role !== undefined ? { role: opts.invite.role } : {}),
          ...(opts.invite.ttlMs !== undefined ? { ttlMs: opts.invite.ttlMs } : {}),
          ...(opts.invite.tempPhrase !== undefined ? { tempPhrase: opts.invite.tempPhrase } : {}),
        })
      : await issueInvite(db, vaultId, {
          userId: opts.invite.userId,
          displayName: opts.invite.displayName,
          role: opts.invite.role ?? 'client',
          ...(opts.invite.ttlMs !== undefined ? { ttlMs: opts.invite.ttlMs } : {}),
          ...(opts.invite.tempPhrase !== undefined ? { tempPhrase: opts.invite.tempPhrase } : {}),
        })

  const auditRef: PortalInviteAuditRef = {
    tokenId: issued.payload.tokenId,
    userId: opts.invite.userId,
    kind: mode,
    issuedAt: Date.now(),
    expiresAt: issued.payload.expiresAt,
  }
  const handle = row.handle ?? generateULID()
  const updated: VaultRegistryRow = {
    ...row,
    handle,
    portal: {
      enabledAt: row.portal?.enabledAt ?? Date.now(),
      invites: [...(row.portal?.invites ?? []), auditRef],
    },
  }
  await group.registry.put(group.registryId(opts.client), updated)

  return {
    vaultId,
    handle,
    invite: {
      encoded: issued.encoded,
      tokenId: issued.payload.tokenId,
      userId: opts.invite.userId,
      expiresAt: issued.payload.expiresAt,
    },
    row: updated,
  }
}

/**
 * Revoke an outstanding portal invite and stamp `revokedAt` on the
 * fleet audit trail. Idempotent. Fails closed on an unknown tokenId.
 */
export async function revokePortalInvite<T>(
  db: Noydb,
  group: VaultGroup<T>,
  opts: RevokePortalInviteOptions,
): Promise<VaultRegistryRow> {
  const row = await requireRow(group, opts.client)
  const invites = row.portal?.invites ?? []
  const ref = invites.find((i) => i.tokenId === opts.tokenId)
  if (!ref) {
    throw new Error(`revokePortalInvite: no invite with tokenId "${opts.tokenId}" for client "${opts.client}".`)
  }
  if (ref.revokedAt !== undefined) return row

  const { revokeInvite } = await import('@noy-db/on-magic-link')
  await revokeInvite(db, row.vaultId, {
    tokenId: ref.tokenId,
    vault: row.vaultId,
    userId: ref.userId,
    kind: ref.kind === 'rebind' ? 'peer-recovery' : 'invite',
    issuer: '',
    tempPhrase: '',
    expiresAt: ref.expiresAt,
  })

  const updated: VaultRegistryRow = {
    ...row,
    portal: {
      enabledAt: row.portal?.enabledAt ?? Date.now(),
      invites: invites.map((i) => (i.tokenId === opts.tokenId ? { ...i, revokedAt: Date.now() } : i)),
    },
  }
  await group.registry.put(group.registryId(opts.client), updated)
  return updated
}
