import { createInspector } from '@noy-db/in-devtools'
import { groupInspector } from '../federation/group-inspector.js'
import { meterGroup } from '../federation/meter-group.js'
import type { VaultGroup } from '../federation/vault-group.js'

/**
 * A config module for the `klum` CLI default-exports this factory: given an
 * optional group name, it returns an opened VaultGroup (the user's module owns
 * the store, templates, and sharding config — the CLI stays agnostic of them).
 */
export type GroupFactory = (groupName?: string) => Promise<VaultGroup<unknown>>

type Log = (s: string) => void

export interface ParsedArgs {
  command: string
  configPath?: string
  group?: string
  vault?: string
  meter: boolean
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { command: argv[0] ?? '', meter: false }
  for (const a of argv.slice(1)) {
    if (a.startsWith('--group=')) out.group = a.slice('--group='.length)
    else if (a.startsWith('--vault=')) out.vault = a.slice('--vault='.length)
    else if (a === '--meter') out.meter = true
    else if (!a.startsWith('--')) out.configPath = a
  }
  return out
}

async function loadGroup(args: ParsedArgs): Promise<VaultGroup<unknown>> {
  const mod = (await import(args.configPath!)) as { default: GroupFactory }
  return mod.default(args.group)
}

export async function runInspectGroup(args: ParsedArgs, log: Log): Promise<number> {
  if (!args.configPath) {
    log('usage: klum inspect-group <config> --group=<name> [--vault=<id>]')
    return 2
  }
  const group = await loadGroup(args)
  const inspector = createInspector(groupInspector(group))
  const vaults = await inspector.listVaults()
  log(`group "${args.group ?? ''}" — ${vaults.length} shard(s):`)
  for (const v of vaults) log(`  ${v.id} [${v.role}]`)
  if (args.vault) {
    const vault = await group.db.openVault(args.vault)
    group.template.configure(vault)
    const snap = await inspector.snapshot(vault)
    log(`  collections in ${args.vault}: ${snap.collections.map((c) => c.name).join(', ')}`)
  }
  return 0
}

export async function runMeterGroup(args: ParsedArgs, log: Log): Promise<number> {
  if (!args.configPath) {
    log('usage: klum meter-group <config> --group=<name>')
    return 2
  }
  const group = await loadGroup(args)
  const r = await meterGroup(group)
  log(`group "${args.group ?? ''}" — ${r.vaults} vault(s), ${r.collections} collection(s), ${r.records} record(s)`)
  for (const s of r.perShard) {
    log(`  ${s.vaultId} (${s.partitionKey}) v${s.schemaVersion}: ${s.collections} coll, ${s.records} rec`)
  }
  if (r.skipped.length) log(`  skipped: ${r.skipped.length} shard(s)`)
  return 0
}

export async function main(argv: readonly string[], log: Log = console.log): Promise<number> {
  const args = parseArgs(argv)
  switch (args.command) {
    case 'inspect-group':
      return runInspectGroup(args, log)
    case 'meter-group':
      return runMeterGroup(args, log)
    default:
      log('klum <inspect-group|meter-group> <config> --group=<name> [--vault=<id>]')
      return args.command ? 1 : 0
  }
}

// bin entrypoint — only runs when executed directly, not when imported in tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((e: unknown) => {
      console.error(e)
      process.exitCode = 1
    })
}
