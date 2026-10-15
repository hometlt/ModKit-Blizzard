import { describe, expect, it } from 'vitest'
import { LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT } from '@modkit/sdk/language'
import { createProvider as createDataProvider } from '../modules/data/providers/language/runtime.js'
import { galaxyRename } from '../modules/galaxy/language/semantic-provider.js'
import { createProvider as createMapProvider } from '../modules/map/providers/language/runtime.js'

/*
 * An entity rename reaches every place that names it: GameData's own `parent` and linked fields,
 * Galaxy literals, and a map's placed objects and preload list — from whichever document it starts.
 */
const data = Object.freeze({
  uri: 'file:///Base.SC2Data/GameData/UnitData.xml',
  languageId: 'sc2-data',
  version: 4,
  text: '<Catalog><CUnit id="Marine"/><CUnit id="MarineElite" parent="Marine"/><CSound id="Boom"/></Catalog>',
})
const galaxy = Object.freeze({
  uri: 'file:///MapScript.galaxy',
  languageId: 'galaxy',
  version: 2,
  text: 'void Init() { point p; UnitCreate(1, "Marine", 0, 1, p, 0.0); }',
})
const objects = Object.freeze({
  uri: 'file:///Objects',
  languageId: 'sc2-map-objects',
  version: 7,
  text: [
    '<PlacedObjects Version="27">',
    '<ObjectUnit Id="1" Position="1,2,0" UnitType="Marine" Player="1"/>',
    '<ObjectPoint Id="2" Position="0,0,0" Name="P" Sound="Boom"/>',
    '</PlacedObjects>',
  ].join('\n'),
})
const preload = Object.freeze({
  uri: 'file:///Preload.xml',
  languageId: 'sc2-map-preload',
  version: 8,
  text: '<Preload>\n<Unit id="Marine"/>\n</Preload>',
})
const documents = Object.freeze([data, galaxy, objects, preload])

function position(document: (typeof documents)[number], needle: string, delta = 1) {
  const offset = document.text.indexOf(needle) + delta
  const lines = document.text.slice(0, offset).split('\n')
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 }
}

const feature = (document: (typeof documents)[number], needle: string, delta = 1) => ({
  document,
  workspaceDocuments: documents,
  workspaceIncomplete: false,
  maxResults: 64,
  maxDocuments: 8,
  position: position(document, needle, delta),
})

const selection = { contract: LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT, major: 1 }
const map = createMapProvider(selection).value
const dataProvider = createDataProvider(selection).value

const touched = (edit: { documentChanges: readonly { uri: string; edits: readonly unknown[] }[] } | undefined) =>
  Object.fromEntries((edit?.documentChanges ?? []).map(change => [change.uri, change.edits.length]))

describe('SC2 entity rename across every language that names it', () => {
  it('routes a map\'s Objects and Preload.xml to the map provider', () => {
    expect(map.languageIds).toEqual(['sc2-map-objects', 'sc2-map-preload'])
    expect(map.workspaceLanguageIds).toEqual(expect.arrayContaining(['sc2-data', 'sc2-map-objects', 'sc2-map-preload']))
  })

  it('finds a placed unit\'s type and a preloaded unit as usages, with the Data parent', async () => {
    const found = await map.references({ ...feature(objects, 'UnitType="Marine"', 11), includeDeclaration: true })
    expect(found.isIncomplete).toBe(false)
    expect(found.locations.map((item: { uri: string }) => item.uri).sort()).toEqual(
      [data.uri, data.uri, galaxy.uri, objects.uri, preload.uri].sort(),
    )
    await expect(map.definition(feature(objects, 'Sound="Boom"', 8))).resolves.toMatchObject({
      locations: [{ uri: data.uri }],
    })
  })

  it('renames from a placed object into Data (declaration and parent), Galaxy and Preload', async () => {
    const preparation = await map.prepareRename(feature(preload, 'Marine'))
    expect(preparation?.placeholder).toBe('Marine')
    const edit = await map.rename({ ...feature(objects, 'UnitType="Marine"', 11), newName: 'Marauder', maxEdits: 16 })
    expect(touched(edit)).toEqual({ [data.uri]: 2, [galaxy.uri]: 1, [objects.uri]: 1, [preload.uri]: 1 })
  })

  it('renames from Galaxy into the Data parent and the map too', async () => {
    const edit = await galaxyRename({ ...feature(galaxy, 'Marine'), newName: 'Marauder', maxEdits: 16 })
    expect(touched(edit)).toEqual({ [data.uri]: 2, [galaxy.uri]: 1, [objects.uri]: 1, [preload.uri]: 1 })
  })

  it('renames from the Data declaration through the provider contract into every language', async () => {
    const edit = await dataProvider.rename({ ...feature(data, 'id="Marine"', 5), newName: 'Marauder', maxEdits: 16 })
    expect(touched(edit)).toEqual({ [data.uri]: 2, [galaxy.uri]: 1, [objects.uri]: 1, [preload.uri]: 1 })
    const references = await dataProvider.references({ ...feature(data, 'id="Marine"', 5), includeDeclaration: false })
    expect(references.locations.map((item: { uri: string }) => item.uri).sort()).toEqual(
      [data.uri, galaxy.uri, objects.uri, preload.uri].sort(),
    )
  })

  it('refuses a rename that would miss usages in a partial snapshot', async () => {
    const edit = await map.rename({
      ...feature(objects, 'UnitType="Marine"', 11),
      workspaceIncomplete: true,
      newName: 'Marauder',
      maxEdits: 16,
    })
    expect(edit).toBeUndefined()
  })
})
