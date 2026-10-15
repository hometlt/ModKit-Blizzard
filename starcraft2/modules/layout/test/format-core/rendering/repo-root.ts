/**
 * Repository root and the fixture roots the rendering suites read, computed once.
 *
 * Nine of these eleven suites each walked up from their own `import.meta.url` — six with
 * `'../../../layout-lang/sc2layout'` and three with `'../../../..'` plus a `packages/…` join —
 * which encodes this tree's depth in nine places and silently resolves to the wrong directory the
 * moment any of them moves. R3·S7 moved all eleven, so the walk lives here instead.
 *
 * The suites are all corpus-gated: each checks `fs.existsSync` on its fixture and skips when the
 * corpus is absent, so a wrong root reads as "skipped", not "failed". That is precisely why the
 * depth must not be duplicated — a broken path here is invisible.
 */
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRegistry } from '../../../shared/layout-engine/sc2-layout-core/core.js'
import schemaData from '../../layout-engine/bundled-schema.js'

/** …/extensions/blizzard/starcraft-2/codecs/sc2-layout/test/rendering → repository root. */
export const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../../..',
)

/** The SC2Layout desc schema, still shipped by `@modkitx/layout-lang` until S7 absorbs it too. */
/** Build the same schema registry in a workspace checkout and in an extracted extension. */
export function createTestRegistry() {
  return createRegistry(schemaData)
}
