/**
 * Small in-memory GameData fixtures.
 *
 * Kept as text rather than files on disk so every test runs through `createMemoryAssetSource`,
 * the reference `AssetSource` implementation `@modkitx/assets` ships for exactly this purpose.
 */

import { createMemoryAssetSource, type AssetSource } from '@modkit/codec-kit/legacy/assets'

/**
 * A self-contained catalog: `Marine` inherits from `BaseUnit`, which is declared in the same
 * file, so the whole inheritance chain resolves without any dependency context.
 */
export const SELF_CONTAINED_XML = `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
  <CUnit id="BaseUnit" default="1">
    <LifeMax value="40"/>
    <Radius value="0.5"/>
  </CUnit>
  <CUnit id="Marine" parent="BaseUnit">
    <LifeMax value="45"/>
    <WeaponArray index="0" Link="GaussRifle"/>
  </CUnit>
  <CWeapon id="GaussRifle">
    <Range value="5"/>
  </CWeapon>
</Catalog>
`

/**
 * The realistic case: `Marauder` inherits from `StandardTerranUnit`, which lives in a dependency
 * mod that a single `AssetSource` cannot reach. `TypedCatalog.buildChain` stops silently at the
 * dangling parent, so this fixture is what proves the codec reports the gap instead of hiding it.
 */
export const CHAINED_LEAF_XML = `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
  <CUnit id="Marauder" parent="StandardTerranUnit">
    <LifeMax value="125"/>
    <WeaponArray index="0" Link="PunisherGrenades"/>
  </CUnit>
</Catalog>
`

/** The dependency that {@link CHAINED_LEAF_XML} is missing, plus the global constants file. */
export const CHAINED_BASE_XML = `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
  <const id="ArmorBase" value="1"/>
  <CUnit id="StandardTerranUnit">
    <LifeMax value="100"/>
    <Radius value="0.75"/>
  </CUnit>
</Catalog>
`

/** A `Catalog`-rooted document whose children name no class the schema knows. */
export const FOREIGN_CATALOG_XML = `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
  <Product id="Widget"><Price value="10"/></Product>
</Catalog>
`

/** Ordinary XML that must never be claimed as GameData. */
export const UNRELATED_XML = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <appSettings><add key="Theme" value="dark"/></appSettings>
</configuration>
`

export interface FixtureSourceInit {
  /**
   * Logical path; `**\/GameData/*.xml` is what the manifest's pathGlob matches.
   *
   * The default deliberately uses a *custom* catalog filename. `gamedata-lang` enforces that a
   * standard data file (`UnitData.xml`, `ActorData.xml`, …) may only hold classes of its own
   * category, while "custom `<Catalog>` files (unrecognized name) accept any class" — and
   * {@link SELF_CONTAINED_XML} mixes `CUnit` with `CWeapon` on purpose.
   */
  readonly path?: string
  readonly parentArtifactIds?: readonly string[]
  readonly gameId?: string
}

/** An in-memory `AssetSource` over fixture text, with declared SC2 context by default. */
export function fixtureSource(xml: string, init: FixtureSourceInit = {}): AssetSource {
  const context = {
    ...(init.gameId === undefined ? {} : { gameId: init.gameId }),
    ...(init.parentArtifactIds === undefined
      ? {}
      : { parentArtifactIds: [...init.parentArtifactIds] }),
  }
  return createMemoryAssetSource(new TextEncoder().encode(xml), {
    path: init.path ?? 'Mods/Test.SC2Mod/GameData/TestData.xml',
    ...(Object.keys(context).length > 0 ? { context } : {}),
  })
}
