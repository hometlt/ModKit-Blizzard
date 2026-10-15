import { describe, expect, it } from 'vitest'
import {
  createSc2LayoutCodec,
} from '../../shared/format/codec.js'
import {
  createSc2LayoutReferenceRenameEditTransaction,
} from '../../shared/format/edit.js'
import { fixtureSource } from './fixtures.js'

const options = {
  canon: (namespace: string) =>
    ['Unit'].find(candidate => candidate.toLowerCase() === namespace.toLowerCase()),
  mapped: (namespace: string, id: string) =>
    namespace === 'Unit' && id === 'Marine' ? 'Hero' : undefined,
}

describe('SC2Layout reference-rename edit transaction', () => {
  it('plans and applies a raw-preserving output without mutating the open document', async () => {
    const bytes = new TextEncoder().encode(
      '\ufeff<?xml version="1.0"?><Desc><!--keep--><Frame type="Image" name="Icon"><Texture val="@@Unit/Icon/Marine"/></Frame></Desc>',
    )
    const codec = createSc2LayoutCodec()
    const document = await codec.open(fixtureSource(bytes, 'UI/Test.SC2Layout'), {})
    const transaction = codec.createReferenceRenameEditTransaction(document, options)

    expect(transaction.plans[0]?.summary.referencesPatched).toBe(1)
    expect(transaction.plans[0]?.preservesUnknownData).toBe(true)
    expect(document.text).toContain('Marine')
    expect(() => transaction.outputs()).toThrow('Call apply()')

    await transaction.apply()
    const output = transaction.outputs()[0]
    expect(output?.path).toBe('UI/Test.SC2Layout')
    expect(output?.data.slice(0, 3)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]))
    expect(new TextDecoder().decode(output?.data)).toContain('<!--keep-->')
    expect(new TextDecoder().decode(output?.data)).toContain('@@Unit/Icon/Hero')
    expect(document.text).toContain('Marine')
  })

  it('returns a valid no-op plan and no outputs when no reference matches', async () => {
    const codec = createSc2LayoutCodec()
    const document = await codec.open(fixtureSource(), {})
    const transaction = createSc2LayoutReferenceRenameEditTransaction(document, options)

    expect(transaction.plans[0]?.summary.referencesPatched).toBe(0)
    await transaction.apply()
    expect(transaction.outputs()).toEqual([])
  })
})
