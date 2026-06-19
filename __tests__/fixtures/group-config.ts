/**
 * Example `klum` CLI config module: default-exports a factory that opens (and,
 * here, seeds) a VaultGroup. Real configs wire their own store/templates; this
 * fixture reuses the in-memory two-shard group so the CLI smoke test runs
 * without external state.
 */
import { makeTwoShardGroup } from '../helpers/two-shard-group.js'

export default async function openGroup(_groupName?: string) {
  const { group } = await makeTwoShardGroup()
  return group
}
