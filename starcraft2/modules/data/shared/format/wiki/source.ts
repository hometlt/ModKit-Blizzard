import type { TextStyleInfo } from '../../../../strings/shared/core/resolve.js'
import type { SC2LayoutFile } from '../../../../layout/shared/layout-engine/sc2-layout-core/simple-parse/index.js'
import type { CatalogEntity } from '../../catalog-engine/sc2-catalog/index.js'

export type Sc2WikiLocaleFiles = ReadonlyMap<
  string,
  ReadonlyMap<string, ReadonlyMap<string, string>>
>

/**
 * Minimal dependency-resolved workspace view used by the SC2 Data wiki services.
 *
 * Loaders may expose a richer mod object, but the wiki layer only reads this
 * contract. Keeping the boundary here prevents presentation and relation code
 * from depending on the historical MK2 loader implementation.
 */
export interface Sc2WikiSource {
  readonly locales: Sc2WikiLocaleFiles
  readonly opaqueFiles: ReadonlyMap<string, Uint8Array>
  readonly layouts: ReadonlyMap<string, SC2LayoutFile>

  get(namespace: string, id: string): CatalogEntity | undefined
  getResolved(namespace: string, id: string): Record<string, unknown> | undefined
  all(namespace: string): CatalogEntity[]
  namespaces(): string[]
  getTextConstant(name: string, locale?: string): string | undefined
  getTextStyle(name: string, locale?: string): TextStyleInfo | undefined
}
