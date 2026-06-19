import { describe, it, expect } from 'vitest'
import * as lobby from '../src/index.js'

describe('dock public surface', () => {
  it('exports the dock tier from the package root', () => {
    expect(typeof lobby.InMemoryUnitDriver).toBe('function')
    expect(typeof lobby.DockedUnit).toBe('function')
    expect(typeof lobby.UnitGraduationError).toBe('function')
    expect(typeof lobby.createLobby).toBe('function')
  })
})
