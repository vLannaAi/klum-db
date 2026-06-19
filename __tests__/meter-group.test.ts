import { describe, it, expect } from 'vitest'
import { meterGroup } from '../src/federation/meter-group.js'
import { makeTwoShardGroup } from './helpers/two-shard-group.js'

describe('meterGroup', () => {
  it('sums shape-metrics across eligible shards', async () => {
    const { group } = await makeTwoShardGroup()
    const report = await meterGroup(group)

    expect(report.vaults).toBe(2)
    expect(report.records).toBe(3)
    expect(report.collections).toBe(1)
    expect(report.skipped).toEqual([])
    expect(report.perShard.reduce((n, s) => n + s.records, 0)).toBe(3)

    const acme = report.perShard.find((s) => s.partitionKey === 'acme')
    expect(acme?.records).toBe(2)
    expect(acme?.collections).toBe(1)
    expect(acme?.schemaVersion).toBe(1)
  })
})
