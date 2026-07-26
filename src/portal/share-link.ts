/**
 * Vendor-side deep-link addressing (#43). The share-link GRAMMAR is the
 * hub's (`@noy-db/hub/share-link`, #806) — one canonical link shape for
 * the LIFF permalink, the installed PWA, and the vendor console. The
 * Lobby contributes the FLEET half: mapping the link's vault handle to
 * the firm's registry row (resolve), and a client's registry row to its
 * portal handle (build).
 *
 * Fail closed: unknown/foreign handles or clients throw a typed
 * {@link ShareLinkResolutionError} whose message never enumerates the
 * fleet (no vault ids, no partition keys beyond the caller's own input).
 */
import type { Collection } from '@noy-db/hub'
import {
  parseShareLink,
  buildShareLink as buildShareLinkFromParts,
  type ShareLink,
} from '@noy-db/hub/share-link'
import type { VaultRegistryRow } from '../federation/types.js'

/** Machine-readable {@link ShareLinkResolutionError} discriminant. */
export type ShareLinkResolutionErrorCode =
  | 'UNKNOWN_VAULT_HANDLE'
  | 'UNKNOWN_CLIENT'
  | 'NO_PORTAL_HANDLE'

/**
 * Typed failure for fleet-side share-link resolution. Standalone
 * (`extends Error`) mirroring the hub's `ShareLinkParseError` style.
 * Fail closed: map to an app-level 404; never fall back to a default
 * vault, and never leak fleet contents through the message.
 */
export class ShareLinkResolutionError extends Error {
  override readonly name = 'ShareLinkResolutionError'
  constructor(
    readonly code: ShareLinkResolutionErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** What {@link resolveShareLinkAgainstRegistry} returns. */
export interface ResolvedShareLink {
  /** The parsed link (hub grammar), as-received or parsed from the raw string. */
  readonly link: ShareLink
  /** The fleet registry row the link's vault handle resolved to. */
  readonly row: VaultRegistryRow
  /**
   * Console-route descriptor: everything the firm app needs to mint its
   * OWN console URL for the addressed record. Descriptor, not redirect —
   * the Lobby returns data, the app owns its routes.
   */
  readonly consoleRoute: {
    readonly vaultId: string
    readonly collection: string
    readonly recordId: string
    readonly period?: string
    readonly version?: number
  }
}

/** Input to {@link buildShareLinkForClient}: fleet coordinates + link context. */
export interface BuildShareLinkForClientOptions {
  /** The client's partition key in the fleet registry. */
  readonly client: string
  /** Which VaultGroup the client belongs to (registry is shared across groups). */
  readonly group: string
  readonly collection: string
  readonly record: string
  readonly period?: string
  readonly version?: number
  /** Single-use grant token — emitted only as the `#g=` fragment (hub rule). */
  readonly grantToken?: string
  /** Origin prefix prepended verbatim by the hub builder (e.g. a LIFF permalink base). */
  readonly base?: string
}

async function registryRows(registry: Collection<VaultRegistryRow>): Promise<readonly VaultRegistryRow[]> {
  await registry.list()
  return registry.query().toArray()
}

/** Resolve a share link (raw or parsed) to its fleet registry row. */
export async function resolveShareLinkAgainstRegistry(
  link: string | URL | ShareLink,
  registry: Collection<VaultRegistryRow>,
): Promise<ResolvedShareLink> {
  const parsed: ShareLink =
    typeof link === 'string' || link instanceof URL ? parseShareLink(link) : link
  const rows = await registryRows(registry)
  const row = rows.find((r) => r.handle === parsed.vaultHandle)
  if (!row) {
    throw new ShareLinkResolutionError(
      'UNKNOWN_VAULT_HANDLE',
      `share link addresses vault handle "${parsed.vaultHandle}", which is not registered in this fleet.`,
    )
  }
  return {
    link: parsed,
    row,
    consoleRoute: {
      vaultId: row.vaultId,
      collection: parsed.collection,
      recordId: parsed.recordId,
      ...(parsed.period !== undefined ? { period: parsed.period } : {}),
      ...(parsed.version !== undefined ? { version: parsed.version } : {}),
    },
  }
}

/** Mint a share link for a fleet client, delegating the grammar to the hub. */
export async function buildShareLinkForClient(
  opts: BuildShareLinkForClientOptions,
  registry: Collection<VaultRegistryRow>,
): Promise<string> {
  const rows = await registryRows(registry)
  const row = rows.find((r) => r.partitionKey === opts.client && r.group === opts.group)
  if (!row) {
    throw new ShareLinkResolutionError(
      'UNKNOWN_CLIENT',
      `client "${opts.client}" is not registered in group "${opts.group}".`,
    )
  }
  if (row.handle === undefined) {
    throw new ShareLinkResolutionError(
      'NO_PORTAL_HANDLE',
      `client "${opts.client}" has no portal vault handle — provision the portal before minting share links.`,
    )
  }
  return buildShareLinkFromParts(
    {
      vaultHandle: row.handle,
      collection: opts.collection,
      recordId: opts.record,
      ...(opts.period !== undefined ? { period: opts.period } : {}),
      ...(opts.version !== undefined ? { version: opts.version } : {}),
      ...(opts.grantToken !== undefined ? { grantToken: opts.grantToken } : {}),
    },
    opts.base,
  )
}
