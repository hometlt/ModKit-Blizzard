import { describe, it, expect, beforeAll } from 'vitest'
import { TypedCatalog } from '../../../data/shared/catalog-engine/sc2-catalog/index.js'
import { createBuiltinRegistry } from '../../../data/shared/catalog-engine/sc2-schema/index.js'
import { parseCatalogXml } from '../../../data/shared/catalog-engine/xml/index.js'
import { SC2Mod, type LocaleStrings } from '../../shared/core/mod.js'
import { isOwnEntity, gameDataNamespaceSummaries, collectModEntities } from '../../shared/core/entities.js'

/**
 * The host-agnostic entity-listing core shared by the VS Code Mod Card / MOD tree and the LSP
 * `modkit/modResource` handler (G8). Built here from a two-archive catalog (a dependency + the
 * own root) so own-vs-inherited counting is exercised without a live host.
 */

// A dependency mod defines Marine + Zealot; the own root patches Marine and adds Marauder.
const DEP_XML = `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
  <CUnit id="Marine"><LifeMax value="45"/></CUnit>
  <CUnit id="Zealot"><LifeMax value="100"/></CUnit>
</Catalog>`

const ROOT_XML = `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
  <CUnit id="Marine"><Race value="Terr"/></CUnit>
  <CUnit id="Marauder"><LifeMax value="125"/></CUnit>
</Catalog>`

const DEP_PATH = 'Dep.SC2Mod'
const ROOT_PATH = 'Root.SC2Mod'

function makeMod(): SC2Mod {
  const catalog = new TypedCatalog({ schema: createBuiltinRegistry() })
  // deps first, root last (engine load order); each tagged with its archive name as source.mod
  catalog.loadFromFiles([parseCatalogXml(DEP_XML)], { mod: DEP_PATH })
  catalog.loadFromFiles([parseCatalogXml(ROOT_XML)], { mod: ROOT_PATH })
  const locales: LocaleStrings = new Map([
    ['enus', new Map([['GameStrings', new Map([['Unit/Name/Marine', 'Marine']])]])],
  ])
  return new SC2Mod(catalog, [DEP_PATH, ROOT_PATH], locales)
}

describe('@modkitx/mods-processing/sc2-mod-core entity helpers', () => {
  let mod: SC2Mod

  beforeAll(() => {
    mod = makeMod()
  })

  it('isOwnEntity flags entities the last load-order entry declares or patches', () => {
    const marine = mod.get('Unit', 'Marine')!
    const marauder = mod.get('Unit', 'Marauder')!
    const zealot = mod.get('Unit', 'Zealot')!
    expect(isOwnEntity(marine, ROOT_PATH)).toBe(true) // patched by root
    expect(isOwnEntity(marauder, ROOT_PATH)).toBe(true) // declared by root
    expect(isOwnEntity(zealot, ROOT_PATH)).toBe(false) // only in the dependency
  })

  it('gameDataNamespaceSummaries counts own vs total per namespace', () => {
    const nss = gameDataNamespaceSummaries(mod)
    const unit = nss.find(n => n.ns === 'Unit')
    expect(unit).toEqual({ ns: 'Unit', own: 2, total: 3 })
  })

  it('collectModEntities returns id/name/own rows sorted by id', () => {
    const rows = collectModEntities(mod, 'Unit', 'enUS')
    expect(rows.map(r => r.id)).toEqual(['Marauder', 'Marine', 'Zealot'])
    const marine = rows.find(r => r.id === 'Marine')!
    expect(marine.own).toBe(true)
    expect(marine.name).toBe('Marine')
    expect(rows.find(r => r.id === 'Zealot')!.own).toBe(false)
  })

  it('falls back to the single loaded locale when the requested one is absent', () => {
    // Server hydrates one locale; an unknown locale resolves against whatever was loaded.
    const rows = collectModEntities(mod, 'Unit', 'ruRU')
    expect(rows.find(r => r.id === 'Marine')!.name).toBe('Marine')
  })
})
