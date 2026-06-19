import type { InspectableContainer } from '@noy-db/in-devtools'
import type { AccessibleVault, Vault, WriteHook, WriteConflict, WriteQueue, Unsubscribe } from '@noy-db/hub'
import type { VaultGroup } from './vault-group.js'

/**
 * Adapt a federation {@link VaultGroup} to the dev-tools `InspectableContainer`
 * contract from `@noy-db/in-devtools`, so the inspector / TUI can browse a
 * whole fleet exactly like a single instance.
 *
 * Built entirely on the group's public surface (`allRows`, `db`, `template`) —
 * no `VaultGroup` changes, and (critically) no `@klum-db` import lands in any
 * `@noy-db` package: the dependency runs one way, klum → noy.
 *
 * Write-event scoping: `group.db` may host vaults outside this group, so write
 * and conflict events are filtered to the group's shard ids. The id set is
 * primed/refreshed on every `listAccessibleVaults()` call — drive `listVaults()`
 * (the inspector's normal first step) before relying on event scoping.
 */
export function groupInspector<T>(group: VaultGroup<T>): InspectableContainer {
  let shardIds = new Set<string>()
  const refresh = async () => {
    const rows = await group.allRows()
    shardIds = new Set(rows.map((r) => r.vaultId))
    return rows
  }
  return {
    async listAccessibleVaults(): Promise<readonly AccessibleVault[]> {
      const rows = await refresh()
      return rows.map((r): AccessibleVault => ({ id: r.vaultId, role: 'owner' }))
    },
    async openVault(name: string): Promise<Vault> {
      const vault = await group.db.openVault(name)
      group.template.configure(vault)
      return vault
    },
    onAfterWrite(handler: WriteHook): Unsubscribe {
      return group.db.onAfterWrite((event) => {
        if (shardIds.has(event.vault)) return handler(event)
      })
    },
    onWriteConflict(handler: (c: WriteConflict) => void): Unsubscribe {
      return group.db.onWriteConflict((c) => {
        if (shardIds.has(c.vault)) handler(c)
      })
    },
    get writeQueue(): WriteQueue {
      return group.db.writeQueue
    },
  }
}
