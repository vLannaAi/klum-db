/**
 * @klum-db/lobby dock — graduate() (#11). Import a docked foreign unit into a
 * fresh sovereign noy-db vault, unlocking the full tier (keyring, CEK,
 * provenance, custody). Reuses the decrypted-merge core (no crypto round-trip):
 * foreign rows are plaintext to begin with, so they are staged + validated and
 * written via `mergeDecryptedRecords` (a degenerate all-insert merge).
 *
 * @module
 */
import { createDeedOwner } from '@noy-db/hub'
import type { Noydb, SealingKeyProvider } from '@noy-db/hub'
import type { DecryptedRecord } from '@noy-db/hub/bundle'
import { mergeDecryptedRecords } from '../interchange/merge-compartment.js'
import { stageAndValidate, type RecordTransform } from '../interchange/stage-records.js'
import type { VaultTemplate } from '../federation/types.js'
import type { StateManagementVault } from '../federation/state-vault.js'
import type { DockedUnit } from './docked-unit.js'

export interface GraduateOptions {
  /** Name of the fresh sovereign vault to create. */
  readonly vaultName: string
  /** Target schema applied to the new vault. */
  readonly template: VaultTemplate
  /** Per-(target)-collection transform mapping foreign rows → the target shape. */
  readonly mapping?: Record<string, RecordTransform>
  /** Map a foreign collection name → its target collection name (when they differ). */
  readonly collectionMap?: Record<string, string>
  /** Optionally seal an inalienable client Deed (FR-6) on the new vault. */
  readonly deed?: { readonly ownerId: string; readonly sealingProvider: SealingKeyProvider }
  /** Optional StateManagement vault to record the audited graduation event into. */
  readonly stateVault?: StateManagementVault
}

export interface GraduationReport {
  readonly vaultName: string
  readonly collections: Record<string, { graduated: number }>
  readonly deedSealed: boolean
  readonly event: { type: 'unit-graduated'; unitId: string; vault: string }
}

/** Thrown when graduation cannot proceed (target vault already populated, etc.). */
export class UnitGraduationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnitGraduationError'
  }
}

const ISO_EPOCH = '1970-01-01T00:00:00.000Z'

export async function graduate(
  noydb: Noydb,
  docked: DockedUnit,
  opts: GraduateOptions,
): Promise<GraduationReport> {
  // 1. Mint the fresh vault and apply the target schema.
  const vault = await noydb.openVault(opts.vaultName)
  opts.template.configure(vault)

  // 2. Read the foreign unit → DecryptedRecord[] keyed by TARGET collection.
  //    Refuse to graduate into a vault that already holds data (create-only;
  //    merge-into-existing is mergeCompartment's job, not this).
  const incoming: Record<string, DecryptedRecord[]> = {}
  const transforms: Record<string, RecordTransform[]> = {}
  for (const foreignColl of await docked.listCollections()) {
    const target = opts.collectionMap?.[foreignColl] ?? foreignColl
    const existing = await vault.collection(target).list()
    if (existing.length > 0) {
      throw new UnitGraduationError(
        `graduate: target vault "${opts.vaultName}" collection "${target}" is not empty`,
      )
    }
    const recs: DecryptedRecord[] = []
    for await (const row of docked.readRecords(foreignColl)) {
      if (row.id == null) {
        throw new UnitGraduationError(
          `graduate: foreign collection "${foreignColl}" has a row without an id — every docked row must carry a non-null id`,
        )
      }
      if (typeof row.id !== 'string' && typeof row.id !== 'number') {
        throw new UnitGraduationError(
          `graduate: foreign collection "${foreignColl}" has a row whose id is not a string or number — every docked row id must be a primitive`,
        )
      }
      const id = String(row.id)
      recs.push({ id, record: row, ts: ISO_EPOCH, version: opts.template.version })
    }
    incoming[target] = recs
    if (opts.mapping?.[target]) transforms[target] = [opts.mapping[target]]
  }

  // 3. Stage + validate (staging-safety), then merge as a degenerate all-insert.
  const staged = await stageAndValidate(vault, incoming, transforms)
  await mergeDecryptedRecords(vault, staged, { strategy: 'take-incoming', reason: 'dock:graduate' })

  // 3b. Optional custody Deed — the client's inalienable, sealed owner (FR-6).
  let deedSealed = false
  if (opts.deed) {
    await createDeedOwner(noydb._store, opts.vaultName, opts.deed.ownerId, opts.deed.sealingProvider)
    deedSealed = true
  }

  // 3c. Optional audited event.
  if (opts.stateVault) {
    await opts.stateVault.appendEvent({
      type: 'unit-graduated',
      group: opts.vaultName,
      vaultId: opts.vaultName,
      detail: `graduated foreign unit ${docked.unitId}`,
    })
  }

  // 4. Report.
  const collections: Record<string, { graduated: number }> = {}
  for (const [coll, recs] of Object.entries(staged)) collections[coll] = { graduated: recs.length }

  return {
    vaultName: opts.vaultName,
    collections,
    deedSealed,
    event: { type: 'unit-graduated', unitId: docked.unitId, vault: opts.vaultName },
  }
}
