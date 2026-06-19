/**
 * @klum-db/lobby dock — the foreign-format contract (unit-driver family).
 *
 * A `UnitDriver` reads a foreign / legacy unit (a raw sqlite file, an external
 * schema, …) as plain records. The noy-db vault is the flagship "vessel"; this
 * is the passthrough driver for everything else. klum-db ships the interface
 * plus an in-memory reference driver; concrete adapters (sqlite, …) live in
 * separate packages.
 *
 * @module
 */

/** Reads a foreign unit as plain, plaintext records. */
export interface UnitDriver {
  /** Stable identifier for the foreign unit (used in audit events). */
  readonly unitId: string
  /** List the foreign collections/tables available to dock. */
  listCollections(): Promise<readonly string[]>
  /** Stream the records of one foreign collection. */
  readRecords(collection: string): AsyncIterable<Record<string, unknown>>
}

/** In-memory reference driver — the test/flagship-less vessel. */
export class InMemoryUnitDriver implements UnitDriver {
  constructor(
    readonly unitId: string,
    private readonly data: Record<string, readonly Record<string, unknown>[]>,
  ) {}

  async listCollections(): Promise<readonly string[]> {
    return Object.keys(this.data)
  }

  async *readRecords(collection: string): AsyncIterable<Record<string, unknown>> {
    for (const row of this.data[collection] ?? []) yield row
  }
}
