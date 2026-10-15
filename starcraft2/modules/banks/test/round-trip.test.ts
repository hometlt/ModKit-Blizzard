/**
 * (c) "SC2 behavior remains unchanged through adapters" (Phase C acceptance), mirroring
 * `mods-processing/test/round-trip.test.ts`.
 *
 * The same real fixture is opened twice: once the way `@modkitx/bank` itself would (calling
 * `parseBank`/`validateBank`/`inferBankSignatureInfo` directly, exactly as `loadBankFile` does
 * internally minus the `node:fs` read), and once through `saves-processing`'s `Sc2BankCodec`.
 * Every observable of the loaded bank must match.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createMemoryAssetSource } from '@modkit/codec-kit/legacy/assets'
import {
  inferBankSignatureInfo,
  parseBank,
  serializeBank,
  toSignatureInfo,
  validateBank,
} from '../shared/core/core.js'
import { createSc2BankCodec } from '../codecs/bank/src/artifact-codec.js'

const FIXTURE_URL = new URL('./fixtures/endofdreamsbank2.SC2Bank', import.meta.url)
const FIXTURE_XML = readFileSync(FIXTURE_URL, 'utf8').trim()
const FIXTURE_BYTES = new TextEncoder().encode(FIXTURE_XML)

const codec = createSc2BankCodec()

describe('saves-processing round trip', () => {
  it('produces the same parsed bank as parsing directly through @modkitx/bank/core', async () => {
    const path = '/tmp/endofdreamsbank2.SC2Bank'
    const direct = parseBank(FIXTURE_XML)

    const document = await codec.open(createMemoryAssetSource(FIXTURE_BYTES, { path }), {})

    expect(document.bank).toEqual(direct)
    expect(document.xml).toBe(FIXTURE_XML)
    // Known values from the fixture (see packages/bank/src/bank.spec.ts).
    expect(document.bank.signature).toBe('B786E6B04930A2B9D6789019D9D7DAD476A3A9DB')
    expect(document.editor.getInt('Stats', 'TotalKills')).toBe(9999999)
    expect(document.editor.getString('Ranks', 'Rank')).toBe('Hero')
  })

  it('infers the same signature info and validation report as calling @modkitx/bank/core directly', async () => {
    const path = '/Accounts/123456/2-S2-1-10/Banks/2-S2-1-20/endofdreamsbank2.SC2Bank'
    const directBank = parseBank(FIXTURE_XML)
    const directInferred = inferBankSignatureInfo(path)
    const directSignatureInfo = toSignatureInfo(directInferred)
    const directValidation = validateBank(
      directBank,
      directSignatureInfo !== undefined ? { signatureInfo: directSignatureInfo } : {},
    )

    const document = await codec.open(createMemoryAssetSource(FIXTURE_BYTES, { path }), {})

    expect(document.inferredInfo).toEqual(directInferred)
    expect(document.signatureInfo).toEqual(directSignatureInfo)
    expect(document.validation).toEqual(directValidation)
  })

  it('produces the same serialized XML as calling serializeBank directly', async () => {
    const path = '/tmp/endofdreamsbank2.SC2Bank'
    const document = await codec.open(createMemoryAssetSource(FIXTURE_BYTES, { path }), {})
    // saveAs() is the codec's projection of serializeBank(); it must not diverge in shape.
    expect(codec.saveAs(document, { xmlHeader: false })).toBe(
      serializeBank(document.bank, { xmlHeader: false }),
    )
  })
})
