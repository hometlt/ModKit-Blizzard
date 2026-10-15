import { describe, expect, it } from 'vitest'
import { inventoryGalaxyNativeSignatures } from '../services/analysis/native-signatures.js'

describe('Galaxy native signature inventory', () => {
  it('retains exact types, lines and original fragments without claiming execution', () => {
    const source = 'native bool HasUnit(unit entity, int player);\nbool Own(bool value) { return value; }'
    const inventory = inventoryGalaxyNativeSignatures(source)
    expect(inventory.functionDeclarations).toBe(2)
    expect(inventory.signatures).toEqual([{
      name: 'HasUnit', returnType: 'bool', line: 1,
      parameters: [{ name: 'entity', type: 'unit' }, { name: 'player', type: 'int' }],
      fragment: 'native bool HasUnit(unit entity, int player);', admission: 'unmapped-native',
    }])
    expect(() => inventoryGalaxyNativeSignatures('native bool Broken(')).toThrow(/syntax/u)
  })
})
