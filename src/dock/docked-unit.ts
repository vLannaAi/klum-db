/**
 * @klum-db/lobby dock — the lower tier. A `DockedUnit` is present in the Lobby
 * and read-only carried, WITHOUT the sovereign guarantees (custody, field
 * authority, provenance, forget). Those become reachable only after
 * `graduate()` mints a real noy-db vault. The boundary is structural: this
 * class deliberately has no sovereign methods.
 *
 * @module
 */
import type { UnitDriver } from './unit-driver.js'

export class DockedUnit {
  constructor(readonly driver: UnitDriver) {}

  get unitId(): string {
    return this.driver.unitId
  }

  listCollections(): Promise<readonly string[]> {
    return this.driver.listCollections()
  }

  readRecords(collection: string): AsyncIterable<Record<string, unknown>> {
    return this.driver.readRecords(collection)
  }
}
