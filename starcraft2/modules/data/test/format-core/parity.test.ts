/**
 * (b) Adapter parity: opening the same fixture through `@modkitx/data-processing/sc2-catalog` directly and through
 * the `sc2-data` codec must produce equivalent underlying data.
 *
 * This is the Phase C acceptance criterion "SC2 behavior remains unchanged through adapters".
 * The adapter adds detection, a descriptor, and an account of unresolved inheritance — it must
 * not change a single parsed entity, merged field, or namespace along the way.
 */

import { describe, expect, it } from 'vitest'
import { parseCatalogXml } from '../../shared/catalog-engine/xml/index.js'
import { TypedCatalog } from '../../shared/catalog-engine/sc2-catalog'
import { createBuiltinRegistry } from '../../shared/catalog-engine/sc2-schema'
import { createSc2DataCodec } from '../../shared/format/codec.js'
import { type Sc2DataDocument } from '../../shared/format/document.js'
import {
  CHAINED_BASE_XML,
  CHAINED_LEAF_XML,
  SELF_CONTAINED_XML,
  fixtureSource,
} from './fixtures.js'

const codec = createSc2DataCodec()

/** Exactly what a caller does today without this package. */
function loadDirect(files: readonly { xml: string; mod: string }[]): TypedCatalog {
  const catalog = new TypedCatalog({ schema: createBuiltinRegistry() })
  for (const file of files) {
    const parsed = parseCatalogXml(file.xml, { filePath: 'UnitData.xml', trackSource: true })
    catalog.loadFromFiles([parsed], { mod: file.mod })
  }
  return catalog
}

/** A comparable snapshot of everything a catalog exposes about its entities. */
function snapshot(catalog: TypedCatalog) {
  const namespaces = [...catalog.namespaces()].sort()
  return {
    namespaces,
    entities: namespaces.map(namespace => ({
      namespace,
      raw: catalog
        .all(namespace)
        .map(entity => ({
          id: entity.id,
          class: entity.class,
          parent: entity.parent,
          data: entity.data,
          tokens: entity.tokens,
          sources: entity.sources,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      resolved: catalog
        .all(namespace)
        .map(entity => [entity.id, catalog.getResolved(namespace, entity.id)] as const)
        .sort((a, b) => a[0].localeCompare(b[0])),
    })),
  }
}

describe('sc2-data adapter parity with @modkitx/data-processing/sc2-catalog', () => {
  it('matches a direct TypedCatalog load for a self-contained catalog', async () => {
    const mod = 'Mods/Test.SC2Mod'
    const direct = loadDirect([{ xml: SELF_CONTAINED_XML, mod }])
    const document: Sc2DataDocument = await codec.open(
      fixtureSource(SELF_CONTAINED_XML, { path: `${mod}/GameData/UnitData.xml` }),
      {},
    )

    expect(snapshot(document.catalog)).toEqual(snapshot(direct))
    // Spot-check the merge itself, so a mutual regression in `snapshot` cannot pass silently.
    expect(document.catalog.getResolved('Unit', 'Marine')).toEqual(
      direct.getResolved('Unit', 'Marine'),
    )
    expect(direct.getResolved('Unit', 'Marine')?.['Radius']).toBe('0.5')
  })

  it('matches a direct multi-file chain load, in the same load order', async () => {
    const baseMod = 'Mods/Base.SC2Mod'
    const leafMod = 'Mods/Leaf.SC2Mod'
    const direct = loadDirect([
      { xml: CHAINED_BASE_XML, mod: baseMod },
      { xml: CHAINED_LEAF_XML, mod: leafMod },
    ])
    const document = await codec.openCatalogFiles([
      fixtureSource(CHAINED_BASE_XML, { path: `${baseMod}/GameData/UnitData.xml` }),
      fixtureSource(CHAINED_LEAF_XML, { path: `${leafMod}/GameData/UnitData.xml` }),
    ])

    expect(snapshot(document.catalog)).toEqual(snapshot(direct))
    expect(document.catalog.getResolved('Unit', 'Marauder')).toEqual(
      direct.getResolved('Unit', 'Marauder'),
    )
  })

  it('reproduces the partial merge a single-file load produces, without hiding it', async () => {
    const mod = 'Mods/Leaf.SC2Mod'
    const direct = loadDirect([{ xml: CHAINED_LEAF_XML, mod }])
    const document = await codec.open(
      fixtureSource(CHAINED_LEAF_XML, { path: `${mod}/GameData/UnitData.xml` }),
      {},
    )

    // Identical data: the adapter does not silently repair the dangling parent...
    expect(snapshot(document.catalog)).toEqual(snapshot(direct))
    expect(document.catalog.getResolved('Unit', 'Marauder')).toEqual(
      direct.getResolved('Unit', 'Marauder'),
    )
    // ...it only makes the gap visible, which the bare catalog cannot do.
    expect(document.stats.unresolvedParents).toHaveLength(1)
    expect(direct.get('Unit', 'StandardTerranUnit')).toBeUndefined()
  })

  it('attributes entities to the same mod root a direct caller would pass', async () => {
    const mod = 'Mods/Test.SC2Mod'
    const document = await codec.open(
      fixtureSource(SELF_CONTAINED_XML, { path: `${mod}/GameData/UnitData.xml` }),
      {},
    )
    // `modRootOfDataPath` derives the same `{ mod }` option `SC2ModReader` passes explicitly.
    expect(document.files[0]?.modPath).toBe(mod)
    expect(document.catalog.get('Unit', 'Marine')?.source?.mod).toBe(mod)
  })
})
