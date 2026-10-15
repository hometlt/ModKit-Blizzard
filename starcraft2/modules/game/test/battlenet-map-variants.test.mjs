import assert from 'node:assert/strict'
import test from 'node:test'
import { composePublicationHeader } from '../../../dist/modules/game/battlenet/publishing/header-composer.js'
import { reference } from '../../../dist/modules/game/battlenet/content-sources/cache-header.js'
import { readMapVariants } from '../../../dist/modules/game/battlenet/content-sources/map-variants.js'

const table = entries => new TextEncoder().encode(`<?xml version="1.0" encoding="utf-8"?>\r\n<Locale region="x">\r\n${
  entries.map(([id, text]) => `    <e id="${id}">${text}</e>`).join('\r\n')}\r\n</Locale>`)

function depot() {
  const header = composePublicationHeader({ identity: { id: 140436, version: 131154 }, fileName: 'Direct Strike.SC2Map', region: 'eu',
    archiveSha256: 'a'.repeat(64), namespace: 1,
    locales: [{ locale: 'enUS', sha256: 'b'.repeat(64) }, { locale: 'ruRU', sha256: 'c'.repeat(64) }],
    variants: [{ categoryId: 5, modeId: 5, maxTeamSize: 3, categoryName: 45, modeName: 47 },
      { categoryId: 5, modeId: 1, maxTeamSize: 1, categoryName: 45, modeName: 48 },
      { categoryId: 2, modeId: 9, maxTeamSize: 4 }] })
  const tables = { ['b'.repeat(64)]: table([[45, 'Tug Of War'], [47, '3V3'], [48, '1V1 &amp; Commanders']]),
    ['c'.repeat(64)]: table([[45, 'Перетягивание'], [47, '3 на 3']]) }
  const reads = []
  const readComponent = async request => {
    reads.push(request.handle)
    if (request.handle === 'header') return header
    const bytes = Uint8Array.from(request.handle.match(/../g), pair => Number.parseInt(pair, 16))
    const found = tables[reference(bytes)?.sha256]
    if (!found) throw new Error('no such component')
    return found
  }
  return { readComponent, reads }
}

test('variants are named from the map locale tables, the preferred locale first', async () => {
  const { readComponent, reads } = depot()
  const variants = await readMapVariants(readComponent, { region: 'eu', headerHandle: 'header', locale: 'ruRU', signal: new AbortController().signal })
  assert.deepEqual(variants, [
    { index: 0, categoryId: 5, modeId: 5, category: 'Перетягивание', mode: '3 на 3', maxTeamSize: 3 },
    // Missing in ruRU: enUS fills in, entities decoded.
    { index: 1, categoryId: 5, modeId: 1, category: 'Перетягивание', mode: '1V1 & Commanders', maxTeamSize: 1 },
    { index: 2, categoryId: 2, modeId: 9, maxTeamSize: 4 },
  ])
  assert.equal(reads.filter(handle => handle !== 'header').length, 2, 'each locale table is read once')
})

test('without a preferred locale enUS names the variants; unreadable tables leave them unnamed', async () => {
  const { readComponent } = depot()
  const variants = await readMapVariants(readComponent, { region: 'eu', headerHandle: 'header', signal: new AbortController().signal })
  assert.deepEqual(variants.map(v => [v.category, v.mode]), [['Tug Of War', '3V3'], ['Tug Of War', '1V1 & Commanders'], [undefined, undefined]])
  const broken = await readMapVariants(async request => {
    if (request.handle === 'header') return readComponent(request)
    throw new Error('depot down')
  }, { region: 'eu', headerHandle: 'header', signal: new AbortController().signal })
  assert.deepEqual(broken.map(v => [v.index, v.mode]), [[0, undefined], [1, undefined], [2, undefined]])
})
