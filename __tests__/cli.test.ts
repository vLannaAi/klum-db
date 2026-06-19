import { describe, it, expect } from 'vitest'
import { parseArgs, main } from '../src/bin/klum.js'

const CONFIG = new URL('./fixtures/group-config.ts', import.meta.url).href

describe('klum CLI', () => {
  it('parseArgs reads command, config path, and flags', () => {
    expect(parseArgs(['inspect-group', './c.js', '--group=g', '--vault=v1', '--meter'])).toEqual({
      command: 'inspect-group',
      configPath: './c.js',
      group: 'g',
      vault: 'v1',
      meter: true,
    })
  })

  it('inspect-group lists the group shards', async () => {
    const lines: string[] = []
    const code = await main(['inspect-group', CONFIG, '--group=firm-clients'], (s) => lines.push(s))
    expect(code).toBe(0)
    const out = lines.join('\n')
    expect(out).toContain('2 shard(s)')
    expect(out).toContain('firm-clients--acme')
  })

  it('meter-group reports group totals', async () => {
    const lines: string[] = []
    const code = await main(['meter-group', CONFIG, '--group=firm-clients'], (s) => lines.push(s))
    expect(code).toBe(0)
    expect(lines.join('\n')).toContain('2 vault(s), 1 collection(s), 3 record(s)')
  })

  it('returns a usage code when no config is given', async () => {
    const lines: string[] = []
    const code = await main(['inspect-group'], (s) => lines.push(s))
    expect(code).toBe(2)
    expect(lines.join('\n')).toContain('usage:')
  })
})
